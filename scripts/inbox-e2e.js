#!/usr/bin/env node
// End-to-end inbox check against a local `wrangler dev`.
//
// Starts the Worker, signs two accounts in through the real magic-link
// route, adds an image with the MCP add_item tool, and imports it with
// the desktop pull path (better-sqlite3, sharp thumbnail, Inbox
// collection). Then rates it, reads it back with list_rated_items, files
// it with file_items, and checks the next pull moved it out of Inbox. A
// second account's item must not appear. Nothing here deploys.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const PORT = Number(process.env.INBOX_E2E_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-inbox-e2e-'));
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === 'electron') {
    return {
      app: {
        getPath: (name) => userData,
        getName: () => 'GatherOS',
        isReady: () => true,
        on() {},
        whenReady: () => Promise.resolve(),
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s) => Buffer.from(s),
        decryptString: (b) => Buffer.from(b).toString('utf8'),
      },
      BrowserWindow: class {},
      ipcMain: { handle() {}, on() {} },
    };
  }
  return originalRequire.apply(this, arguments);
};

function fail(msg) {
  console.error(`\n[inbox-e2e] ${msg}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(child) {
  const started = Date.now();
  let log = '';
  child.stdout.on('data', (buf) => { log += buf.toString(); });
  child.stderr.on('data', (buf) => { log += buf.toString(); });
  while (Date.now() - started < 60_000) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return { child, getLog: () => log };
    } catch { /* not up yet */ }
    if (child.exitCode != null) fail(`wrangler exited early.\n${log}`);
    await sleep(400);
  }
  fail(`wrangler did not become ready.\n${log}`);
}

async function json(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, init);
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body, headers: res.headers };
}

async function signIn(email, logHolder) {
  const before = logHolder.getLog().length;
  const requested = await json('/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (requested.status !== 200) fail(`magic-link failed: ${JSON.stringify(requested.body)}`);
  let token = null;
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const slice = logHolder.getLog().slice(before);
    const match = slice.match(/\/auth\/verify\?token=([0-9a-f-]+)/i);
    if (match) { token = match[1]; break; }
    await sleep(200);
  }
  if (!token) fail(`no magic-link token in the wrangler log for ${email}`);
  const exchanged = await json('/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, deviceLabel: 'e2e' }),
  });
  if (!exchanged.body.sessionToken) fail(`exchange failed: ${JSON.stringify(exchanged.body)}`);
  return exchanged.body.sessionToken;
}

async function mcp(token, method, params) {
  const res = await json('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.status !== 200) fail(`mcp ${method} status ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function main() {
  if (!fs.existsSync(path.join(SERVER, '.dev.vars'))) {
    fs.copyFileSync(path.join(SERVER, '.dev.vars.example'), path.join(SERVER, '.dev.vars'));
  }
  const wrangler = path.join(SERVER, 'node_modules', '.bin', 'wrangler');
  const migrate = spawn(wrangler, ['d1', 'migrations', 'apply', 'gatheros-db', '--local'], {
    cwd: SERVER,
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });
  const migrateCode = await new Promise((resolve) => migrate.on('exit', resolve));
  if (migrateCode !== 0) fail(`local migrations exited ${migrateCode}`);

  const child = spawn(wrangler, ['dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: SERVER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  const logHolder = { getLog: () => '' };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
  };
  process.on('exit', stop);
  try {
    const ready = await waitForHealth(child);
    logHolder.getLog = ready.getLog;

    const sessionA = await signIn(`a-${Date.now()}@inbox-e2e.test`, logHolder);
    const sessionB = await signIn(`b-${Date.now()}@inbox-e2e.test`, logHolder);
    const tokenA = (await json('/v1/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'e2e' }),
    })).body;
    const tokenB = (await json('/v1/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'other' }),
    })).body;
    if (!tokenA.token || !tokenB.token) fail('token create failed');

    const added = await mcp(tokenA.token, 'tools/call', {
      name: 'add_item',
      arguments: {
        title: 'E2E ramp',
        note: 'Why it is good: one quiet input.',
        source_url: 'https://example.com/ramp',
        source_name: 'web',
        tags: ['e2e'],
        image_base64: PNG_B64,
      },
    });
    const payload = JSON.parse(added.result.content[0].text);
    if (!payload.ok || !payload.asset_stored) fail(`add_item failed: ${JSON.stringify(payload)}`);

    const otherId = crypto.randomUUID();
    const other = await mcp(tokenB.token, 'tools/call', {
      name: 'add_item',
      arguments: { id: otherId, title: 'Not yours', source_url: 'https://example.com/other', source_name: 'web' },
    });
    const otherPayload = JSON.parse(other.result.content[0].text);
    if (!otherPayload.ok) fail(`second account add failed: ${JSON.stringify(otherPayload)}`);

    const settings = require('../src/main/settings');
    const licensing = require('../src/main/licensing');
    const { setSaveNotifier } = require('../src/main/notify');
    settings.setPref('apiBaseUrl', BASE);
    settings.setPref('inboxEnabled', true);
    settings.setPref('inboxTarget', null);
    // This Worker's TRIAL_DAYS is 0, and a signed-in install does not
    // get the local no-account trial. Seed that clock so the import
    // is allowed the same way a trial or paid account would be.
    settings.setPref('trialStartedAt', Date.now());
    licensing.setSessionToken(sessionA);

    let created = 0;
    setSaveNotifier(() => { created += 1; });
    const { pullInbox } = require('../src/main/inbox');
    const summary = await pullInbox({ reason: 'e2e' });
    if (!summary.ok || summary.imported !== 1) fail(`pull summary unexpected: ${JSON.stringify(summary)}`);
    if (created !== 1) fail(`post-save hook fired ${created} times`);

    const db = require('../src/main/db');
    const saves = db.getDatabase().prepare(
      `SELECT id, title, notes, source, content_hash, thumb_path, file_path FROM saves`,
    ).all();
    if (saves.length !== 1) fail(`expected 1 save, found ${saves.length}: ${JSON.stringify(saves)}`);
    const save = saves[0];
    if (save.title !== 'E2E ramp') fail(`title ${save.title}`);
    if (save.notes !== 'Why it is good: one quiet input.') fail(`notes ${save.notes}`);
    if (save.source !== 'inbox') fail(`source ${save.source}`);
    const expectedHash = crypto.createHash('sha256').update(PNG).digest('hex');
    if (save.content_hash !== expectedHash) fail('content hash is not the original bytes');
    if (!fs.existsSync(save.thumb_path) || fs.statSync(save.thumb_path).size < 10) fail('thumbnail missing');
    const tags = db.getTagsForSave(save.id).map((t) => t.name).sort();
    if (!tags.includes('inbox') || !tags.includes('e2e') || !tags.includes('src:web')) {
      fail(`tags ${tags.join(',')}`);
    }
    const collections = db.getAllCollections();
    const inbox = collections.find((c) => c.name === 'Inbox');
    if (!inbox || inbox.save_count < 1) fail('save is not in Inbox');

    const pendingA = await json('/v1/inbox/items?status=pending', {
      headers: { authorization: `Bearer ${sessionA}` },
    });
    if (pendingA.body.pending_count !== 0) fail(`account A still pending: ${JSON.stringify(pendingA.body)}`);
    const pendingB = await json('/v1/inbox/items?status=pending', {
      headers: { authorization: `Bearer ${sessionB}` },
    });
    if (pendingB.body.pending_count !== 1) fail('account B item was pulled by account A');

    // Rate → list_rated_items → file_items → next pull moves it.
    const inboxModule = require('../src/main/inbox');
    const rated = inboxModule.rateSave(save.id, 'like');
    if (!rated.ok) fail(`rateSave failed: ${JSON.stringify(rated)}`);
    const ownSave = db.getDatabase().prepare(`SELECT id FROM saves WHERE id != ?`).get(save.id);
    if (ownSave) fail('unexpected second save before rating');
    const synced = await inboxModule.syncRatingsNow();
    if (!synced.ok || synced.ratingsSynced !== 1) fail(`rating sync unexpected: ${JSON.stringify(synced)}`);
    const ratedList = await mcp(tokenA.token, 'tools/call', { name: 'list_rated_items', arguments: { rating: 'like' } });
    const ratedItems = JSON.parse(ratedList.result.content[0].text).items;
    if (!Array.isArray(ratedItems) || ratedItems.length !== 1 || ratedItems[0].item_id !== payload.id) {
      fail(`list_rated_items unexpected: ${JSON.stringify(ratedItems)}`);
    }
    if (ratedItems[0].title !== 'E2E ramp' || ratedItems[0].rating !== 'like' || 'image_base64' in ratedItems[0]) {
      fail(`list_rated_items row unexpected: ${JSON.stringify(ratedItems[0])}`);
    }
    const otherRated = await mcp(tokenB.token, 'tools/call', { name: 'list_rated_items', arguments: {} });
    if (JSON.parse(otherRated.result.content[0].text).items.length !== 0) fail('account B sees account A ratings');

    const filed = await mcp(tokenA.token, 'tools/call', {
      name: 'file_items',
      arguments: { items: [{ item_id: payload.id, collection_name: 'E2E liked' }] },
    });
    const filedResult = JSON.parse(filed.result.content[0].text).results[0];
    if (!filedResult.ok || filedResult.status !== 'queued' || !filedResult.will_create) {
      fail(`file_items unexpected: ${JSON.stringify(filedResult)}`);
    }
    const crossFile = await mcp(tokenB.token, 'tools/call', {
      name: 'file_items',
      arguments: { items: [{ item_id: payload.id, collection_name: 'Stolen' }] },
    });
    if (JSON.parse(crossFile.result.content[0].text).results[0].error !== 'not_found') fail('account B could file account A item');

    const organized = await pullInbox({ reason: 'e2e-organize' });
    if (!organized.ok || !organized.organize || organized.organize.filed !== 1) {
      fail(`organize pull unexpected: ${JSON.stringify(organized)}`);
    }
    const memberships = db.getDatabase().prepare(
      `SELECT c.name FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE ci.save_id = ?`,
    ).all(save.id).map((r) => r.name).sort();
    if (JSON.stringify(memberships) !== JSON.stringify(['E2E liked'])) {
      fail(`filed save memberships ${JSON.stringify(memberships)}`);
    }
    const likedCols = db.getAllCollections().filter((c) => c.name.toLowerCase() === 'e2e liked');
    if (likedCols.length !== 1) fail(`expected one E2E liked collection, found ${likedCols.length}`);
    const filingsLeft = await json('/v1/inbox/filings', { headers: { authorization: `Bearer ${sessionA}` } });
    if (!Array.isArray(filingsLeft.body.filings) || filingsLeft.body.filings.length !== 0) {
      fail(`filings not acked: ${JSON.stringify(filingsLeft.body)}`);
    }
    const afterFile = await mcp(tokenA.token, 'tools/call', { name: 'list_rated_items', arguments: {} });
    if (JSON.parse(afterFile.result.content[0].text).items[0].filing_status !== 'applied') fail('filing_status not applied');
    const stillOne = db.getDatabase().prepare('SELECT COUNT(*) AS n FROM saves WHERE deleted_at IS NULL').get();
    if (stillOne.n !== 1) fail(`filing changed the save count to ${stillOne.n}`);

    // Same bytes again, after the first ack. Server dedupes, so force the
    // delivered row back to pending and drop the local receipt. The pull
    // must not create a second save.
    db.getDatabase().prepare('DELETE FROM inbox_receipts').run();
    const delivered = await json('/v1/inbox/items?status=delivered', {
      headers: { authorization: `Bearer ${sessionA}` },
    });
    const deliveredId = delivered.body.items && delivered.body.items[0] && delivered.body.items[0].id;
    if (!deliveredId) fail('delivered item missing');
    // The e2e talks to the Worker over HTTP only. Re-queue by inserting a
    // fresh copy is blocked by the content hash, which is the dedupe we
    // want: a second add_item reports duplicate and the library stays at 1.
    const dup = await mcp(tokenA.token, 'tools/call', {
      name: 'add_item',
      arguments: { title: 'again', image_base64: PNG_B64 },
    });
    const dupPayload = JSON.parse(dup.result.content[0].text);
    if (!dupPayload.duplicate) fail(`expected server dedupe, got ${JSON.stringify(dupPayload)}`);
    const again = await pullInbox({ reason: 'e2e-dedupe' });
    const after = db.getDatabase().prepare('SELECT COUNT(*) AS n FROM saves').get();
    if (after.n !== 1) fail(`dedupe created a second save (pull ${JSON.stringify(again)})`);

    console.log('[inbox-e2e] ok — MCP item landed in the local library with a thumbnail, was rated, listed, and filed out of Inbox, and the other account stayed isolated.');
  } finally {
    stop();
    await sleep(300);
  }
}

main().catch((err) => fail(err && err.stack || err));
