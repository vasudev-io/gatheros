// Pages the pending inbox and imports each item. Stops when the free
// tier blocks new saves so the rest stay pending for a later pull.

async function syncInbox(deps) {
  if (!deps.isEnabled()) return { ok: true, skipped: 'disabled' };
  if (!deps.hasSession()) return { ok: true, skipped: 'signed_out' };

  const catalog = (deps.listCatalog() || []).slice(0, 200).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind === 'board' ? 'board' : 'collection',
  }));
  await deps.api.putCollections(catalog);

  const summary = {
    ok: true,
    imported: 0,
    duplicate: 0,
    failed: 0,
    retry: 0,
    blocked: false,
    pending: 0,
  };
  const seen = new Set();
  let cursor = null;
  do {
    const page = await deps.api.listPending(cursor);
    if (typeof page.pending_count === 'number') summary.pending = page.pending_count;
    const items = Array.isArray(page.items) ? page.items : [];
    if (items.length === 0) break;
    for (const item of items) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      let outcome;
      try {
        outcome = await deps.importItem(item);
      } catch (err) {
        summary.retry += 1;
        summary.lastError = String(err && err.message || err);
        continue;
      }
      if (outcome.action === 'blocked') {
        summary.blocked = true;
        break;
      }
      if (outcome.action === 'imported') summary.imported += 1;
      else if (outcome.action === 'duplicate') summary.duplicate += 1;
      else if (outcome.action === 'failed') summary.failed += 1;
      else summary.retry += 1;
    }
    if (summary.blocked) break;
    cursor = page.next_cursor || null;
  } while (cursor);

  if (!summary.blocked && deps.api.status) {
    try {
      const status = await deps.api.status();
      if (typeof status.pending_count === 'number') summary.pending = status.pending_count;
    } catch {
      /* the page count is enough */
    }
  }
  return summary;
}

module.exports = { syncInbox };
