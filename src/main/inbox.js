// Desktop inbox pull.
//
// The Worker holds a short queue. This module pulls it with the
// session token (never an inbox token), writes each image through the
// same save path as a drop, and acks. Off until Settings turns it on.

const { readConfiguredApiBaseUrl } = require('../shared/api-base');
const { INBOX_POLL_MS } = require('../shared/licensing-config');
const { importInboxItem } = require('./inbox-import');
const { syncInbox } = require('./inbox-sync');

const FOCUS_MIN_MS = 60 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

let inflight = null;
let timer = null;
let lastFocusPull = 0;
let started = false;

function sessionToken() {
  try { return require('./licensing').getSessionToken(); }
  catch { return null; }
}

function apiBase() {
  return readConfiguredApiBaseUrl();
}

async function authedJson(pathname, options = {}) {
  const token = sessionToken();
  if (!token) {
    const err = new Error('signed out');
    err.code = 'unauthenticated';
    throw err;
  }
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${apiBase()}${pathname}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Inbox request failed (${res.status})`);
    err.code = data.error || 'http';
    err.status = res.status;
    throw err;
  }
  return data;
}

function libraryDeps() {
  const db = require('./db');
  const settings = require('./settings');
  const notify = require('./notify');
  return {
    getReceipt(id) {
      const row = db.getInboxReceipt(id);
      if (!row) return null;
      return row;
    },
    saveReceipt(row) {
      db.saveInboxReceipt({
        itemId: row.item_id,
        saveId: row.save_id,
        result: row.result,
        attempts: row.attempts,
        lastError: row.last_error,
        receivedAt: row.received_at,
        ackedAt: row.acked_at,
      });
    },
    ack(item, body) {
      return authedJson(`/v1/inbox/items/${encodeURIComponent(item.id)}/ack`, {
        method: 'POST',
        body: JSON.stringify({
          result: body.result,
          save_id: body.saveId || undefined,
          error: body.error || undefined,
        }),
      });
    },
    canCreateSave: () => require('./entitlement').canCreateSave(),
    async fetchAsset(id) {
      const token = sessionToken();
      const res = await fetch(`${apiBase()}/v1/inbox/items/${encodeURIComponent(id)}/asset?variant=original`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Could not download inbox image (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    saveImageFromBuffer: (...args) => require('./storage').saveImageFromBuffer(...args),
    saveImageFromUrl: (...args) => require('./storage').saveImageFromUrl(...args),
    captureUrl: (...args) => require('./urlCapture').captureUrl(...args),
    listCollections: () => db.getAllCollections(),
    listBoards: () => db.listBoards(),
    getDefaultTarget() {
      const target = settings.getPref('inboxTarget', null);
      if (!target || typeof target !== 'object' || !target.id) return null;
      return { id: target.id, kind: target.kind === 'board' ? 'board' : 'collection' };
    },
    createCollection: (fields) => db.createCollection(fields),
    getSave: (id) => db.getSave(id),
    updateSave: (fields) => db.updateSave(fields),
    insertSave: (fields) => db.insertSave(fields),
    addTagToSave: (fields) => db.addTagToSave(fields),
    place(target, record) {
      if (!target || !record || !record.id) return;
      if (target.kind === 'board') placeOnBoard(db, target.id, record);
      else db.addSaveToCollection({ collectionId: target.id, saveId: record.id });
    },
    onSaveCreated: (record) => notify.notifySaved(record),
    onDuplicate: (existing) => notify.notifyDuplicate(existing),
    maxBytes: MAX_IMAGE_BYTES,
  };
}

function placeOnBoard(db, boardId, record) {
  const rows = db.getDatabase().prepare(
    'SELECT z_index FROM board_items WHERE board_id = ?',
  ).all(boardId);
  const z = rows.reduce((max, row) => Math.max(max, row.z_index || 0), 0) + 1;
  const n = rows.length;
  const width = record.width || 480;
  const height = record.height || 480;
  const aspect = height ? width / height : 1;
  let w = width;
  let h = height;
  const maxEdge = 480;
  if (w > maxEdge || h > maxEdge) {
    if (aspect >= 1) { w = maxEdge; h = Math.max(1, Math.round(w / aspect)); }
    else { h = maxEdge; w = Math.max(1, Math.round(h * aspect)); }
  }
  const filePath = record.file_path || record.filePath || '';
  db.upsertBoardItem({
    boardId,
    item: {
      type: 'image',
      x: 80 + (n % 6) * 36,
      y: 80 + (n % 6) * 36,
      width: w,
      height: h,
      rotation: 0,
      z_index: z,
      data: {
        saveId: record.id,
        fileUrl: filePath ? `moodmark-file://local/${encodeURIComponent(filePath)}` : null,
        naturalWidth: record.width || null,
        naturalHeight: record.height || null,
      },
    },
  });
}

function ensureLibrary() {
  require('./library-registry').bootstrap();
  require('./db').initDatabase();
  require('./storage').ensureStorageDirs();
}

async function pullInbox({ reason = 'manual' } = {}) {
  if (inflight) return inflight;
  inflight = doPull(reason).finally(() => { inflight = null; });
  return inflight;
}

async function doPull(reason) {
  const settings = require('./settings');
  if (!settings.getPref('inboxEnabled', false)) return { ok: true, skipped: 'disabled' };
  if (!sessionToken()) return { ok: true, skipped: 'signed_out' };
  ensureLibrary();
  const deps = libraryDeps();
  let blockedAnnounced = false;
  try {
    const summary = await syncInbox({
      isEnabled: () => true,
      hasSession: () => true,
      listCatalog() {
        const collections = deps.listCollections().map((row) => ({ id: row.id, name: row.name, kind: 'collection' }));
        const boards = deps.listBoards().map((row) => ({ id: row.id, name: row.name, kind: 'board' }));
        return collections.concat(boards);
      },
      api: {
        putCollections: (collections) => authedJson('/v1/inbox/collections', {
          method: 'PUT',
          body: JSON.stringify({ collections }),
        }),
        listPending: (cursor) => {
          const query = new URLSearchParams({ status: 'pending', limit: '50' });
          if (cursor) query.set('cursor', cursor);
          return authedJson(`/v1/inbox/items?${query.toString()}`);
        },
        status: () => authedJson('/v1/inbox/status'),
      },
      importItem: async (item) => {
        const outcome = await importInboxItem(item, deps);
        if (outcome.action === 'blocked' && !blockedAnnounced) {
          blockedAnnounced = true;
          try { require('./notify').notifyNeedsUpgrade({ source: 'inbox' }); } catch { /* ignore */ }
        }
        return outcome;
      },
    });
    settings.setPref('inboxLastSyncAt', Date.now());
    settings.setPref('inboxLastSyncError', summary.blocked ? 'upgrade' : null);
    if (typeof summary.pending === 'number') settings.setPref('inboxPendingCount', summary.pending);
    summary.reason = reason;
    return summary;
  } catch (err) {
    const message = String(err && err.message || err);
    settings.setPref('inboxLastSyncError', message);
    return { ok: false, error: message };
  }
}

function startInbox() {
  if (started) return;
  started = true;
  const { ipcMain } = require('electron');
  ipcMain.handle('inbox:status', () => getStatus());
  ipcMain.handle('inbox:pull', () => pullInbox({ reason: 'manual' }));
  ipcMain.handle('inbox:tokens:list', () => listTokens());
  ipcMain.handle('inbox:tokens:create', (_e, payload) => createToken(payload || {}));
  ipcMain.handle('inbox:tokens:revoke', (_e, id) => revokeToken(id));
  timer = setInterval(() => {
    pullInbox({ reason: 'interval' }).catch(() => {});
  }, INBOX_POLL_MS);
  if (timer.unref) timer.unref();
  pullInbox({ reason: 'launch' }).catch(() => {});
}

function onWindowFocus() {
  const now = Date.now();
  if (now - lastFocusPull < FOCUS_MIN_MS) return;
  lastFocusPull = now;
  pullInbox({ reason: 'focus' }).catch(() => {});
}

async function getStatus() {
  const settings = require('./settings');
  const base = apiBase();
  let pending = settings.getPref('inboxPendingCount', 0) || 0;
  let serverError = null;
  if (sessionToken() && settings.getPref('inboxEnabled', false)) {
    try {
      const status = await authedJson('/v1/inbox/status');
      if (typeof status.pending_count === 'number') {
        pending = status.pending_count;
        settings.setPref('inboxPendingCount', pending);
      }
    } catch (err) {
      serverError = String(err && err.message || err);
    }
  }
  return {
    enabled: !!settings.getPref('inboxEnabled', false),
    signedIn: !!sessionToken(),
    apiBaseUrl: settings.getPref('apiBaseUrl', '') || '',
    resolvedApiBaseUrl: base,
    mcpUrl: `${base}/mcp`,
    lastSyncAt: settings.getPref('inboxLastSyncAt', null),
    lastError: settings.getPref('inboxLastSyncError', null),
    pendingCount: pending,
    target: settings.getPref('inboxTarget', null),
    serverError,
  };
}

async function listTokens() {
  if (!sessionToken()) return { ok: false, error: 'unauthenticated' };
  try {
    return await authedJson('/v1/tokens');
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function createToken(payload) {
  if (!sessionToken()) return { ok: false, error: 'unauthenticated' };
  const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 40) : '';
  try {
    return await authedJson('/v1/tokens', {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function revokeToken(id) {
  if (!sessionToken()) return { ok: false, error: 'unauthenticated' };
  if (!id) return { ok: false, error: 'not_found' };
  try {
    return await authedJson(`/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  startInbox,
  onWindowFocus,
  pullInbox,
  getStatus,
};
