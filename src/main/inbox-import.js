// Pure inbox import decisions. No Electron, filesystem, or network.
// The desktop shell in inbox.js supplies the real save path, and the
// tests supply fakes. Bytes still go through saveImageFromBuffer so
// thumbs, palette, and content-hash dedupe stay on the existing path.

const MAX_ATTEMPTS = 3;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

function extFromMime(mime) {
  return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'png';
}

function tagsForItem(item) {
  const tags = [];
  const seen = new Set();
  const add = (name) => {
    const cleaned = String(name || '').trim().toLowerCase().replace(/^#+/, '');
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    tags.push(cleaned);
  };
  for (const tag of item.tags || []) add(tag);
  add('inbox');
  if (item.source_name) add(`src:${item.source_name}`);
  return tags;
}

// Item collection_id wins, then the Settings default, then a
// collection named Inbox (created by the caller when missing). A
// stale id falls through rather than failing the import.
function pickTarget({ item, collections, boards, defaultTarget }) {
  const collectionRows = Array.isArray(collections) ? collections : [];
  const boardRows = Array.isArray(boards) ? boards : [];
  const wantedId = item && item.collection_id ? item.collection_id : (defaultTarget && defaultTarget.id) || null;
  const wantedKind = item && item.collection_id
    ? (item.collection_kind || 'collection')
    : (defaultTarget && defaultTarget.kind) || null;
  if (wantedId && wantedKind === 'board' && boardRows.some((row) => row.id === wantedId)) {
    return { kind: 'board', id: wantedId };
  }
  if (wantedId && wantedKind !== 'board' && collectionRows.some((row) => row.id === wantedId)) {
    return { kind: 'collection', id: wantedId };
  }
  const inbox = collectionRows.find((row) => String(row.name || '').toLowerCase() === 'inbox');
  if (inbox) return { kind: 'collection', id: inbox.id };
  return { createInbox: true };
}

function receiptFields(item, extra) {
  return {
    item_id: item.id,
    save_id: extra.saveId || null,
    result: extra.result,
    attempts: extra.attempts,
    last_error: extra.error || null,
    received_at: item.received_at || Date.now(),
    acked_at: extra.ackedAt || null,
  };
}

async function importInboxItem(item, deps) {
  const receipt = deps.getReceipt(item.id);
  if (receipt && receipt.result && receipt.result !== 'retry') {
    if (!receipt.acked_at) {
      try {
        await deps.ack(item, {
          result: receipt.result,
          saveId: receipt.save_id || null,
          error: receipt.last_error || null,
        });
        deps.saveReceipt({ ...receipt, acked_at: Date.now() });
      } catch (err) {
        return { action: 'retry', error: String(err && err.message || err) };
      }
    }
    return { action: receipt.result, saveId: receipt.save_id || null, replay: true };
  }

  if (typeof deps.canCreateSave === 'function' && !deps.canCreateSave()) {
    return { action: 'blocked' };
  }

  const attempts = ((receipt && receipt.attempts) || 0) + 1;
  try {
    const outcome = await importFresh(item, deps);
    deps.saveReceipt(receiptFields(item, { ...outcome, result: outcome.action, attempts, ackedAt: null }));
    await deps.ack(item, { result: outcome.action, saveId: outcome.saveId, error: null });
    deps.saveReceipt(receiptFields(item, { ...outcome, result: outcome.action, attempts, ackedAt: Date.now() }));
    return outcome;
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 500);
    const failed = attempts >= MAX_ATTEMPTS;
    deps.saveReceipt(receiptFields(item, {
      result: failed ? 'failed' : 'retry',
      attempts,
      error: message,
      ackedAt: null,
    }));
    if (failed) {
      try {
        await deps.ack(item, { result: 'failed', saveId: null, error: message });
        deps.saveReceipt(receiptFields(item, {
          result: 'failed',
          attempts,
          error: message,
          ackedAt: Date.now(),
        }));
      } catch {
        /* the next pull sends the ack again */
      }
      return { action: 'failed', error: message };
    }
    return { action: 'retry', error: message };
  }
}

async function importFresh(item, deps) {
  const choice = pickTarget({
    item,
    collections: deps.listCollections(),
    boards: deps.listBoards(),
    defaultTarget: deps.getDefaultTarget(),
  });
  const target = choice.createInbox
    ? { kind: 'collection', id: deps.createCollection({ name: 'Inbox' }).id }
    : choice;

  let img;
  let kind = item.kind === 'url' ? 'url' : 'image';
  if (item.has_asset) {
    const bytes = Buffer.from(await deps.fetchAsset(item.id));
    if (deps.maxBytes && bytes.length > deps.maxBytes) throw new Error('Image exceeds size cap');
    img = await deps.saveImageFromBuffer(bytes, extFromMime(item.mime));
  } else if (item.image_url) {
    img = await deps.saveImageFromUrl(item.image_url, { maxBytes: deps.maxBytes });
  } else if (item.source_url) {
    img = await deps.captureUrl(item.source_url);
    kind = 'url';
  } else {
    throw new Error('Inbox item has no image or page');
  }

  if (img.duplicateOf) {
    const saveId = img.duplicateOf;
    const existing = deps.getSave(saveId) || img.existing || { id: saveId };
    if (existing && !(existing.notes && String(existing.notes).trim()) && item.note) {
      deps.updateSave({ id: saveId, notes: item.note });
    }
    for (const name of tagsForItem(item)) deps.addTagToSave({ saveId, name });
    deps.place(target, existing);
    if (deps.onDuplicate) deps.onDuplicate(existing);
    return { action: 'duplicate', saveId };
  }

  const record = deps.insertSave({
    id: img.id,
    filePath: img.filePath,
    thumbPath: img.thumbPath,
    width: img.width,
    height: img.height,
    fileSize: img.fileSize,
    palette: img.palette,
    contentHash: img.contentHash,
    sourceUrl: item.source_url || item.image_url || null,
    title: item.title || img.title || null,
    notes: item.note || null,
    source: 'inbox',
    kind,
    meta: {
      inbox: {
        item_id: item.id,
        source_name: item.source_name || null,
        sender: item.token_label || null,
      },
    },
  });
  for (const name of tagsForItem(item)) deps.addTagToSave({ saveId: record.id, name });
  deps.place(target, record);
  if (deps.onSaveCreated) deps.onSaveCreated(record);
  return { action: 'imported', saveId: record.id };
}

module.exports = {
  MAX_ATTEMPTS,
  extFromMime,
  tagsForItem,
  pickTarget,
  importInboxItem,
};
