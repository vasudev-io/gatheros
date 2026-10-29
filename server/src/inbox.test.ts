// Inbox tokens, queue, isolation, limits, and the MCP tools.
// Uses wrangler's local D1 + R2 bindings (nothing is deployed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import type { Env } from './types.ts';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as { build: (opts: Record<string, unknown>) => Promise<void> };

// Node's type-stripping loader does not resolve the Worker's extensionless
// imports. Bundle the worker the same way Wrangler does, then call it
// with local D1 and R2 bindings.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(os.tmpdir(), `gatheros-inbox-test-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.join(HERE, 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'silent',
});
const bundled = await import(pathToFileURL(bundlePath).href) as {
  app: { request: (input: string, init?: RequestInit, env?: Env, ctx?: unknown) => Promise<Response> };
  runInboxMaintenance: (env: Env, now?: number) => Promise<{ pending: number; delivered: number }>;
};
const { app, runInboxMaintenance } = bundled;

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(Buffer.from(PNG_B64, 'base64'));

let env: Env;
let dispose: () => Promise<unknown> = async () => {};

test.before(async () => {
  const proxy = await getPlatformProxy({
    configPath: path.join(HERE, '..', 'wrangler.toml'),
    persist: false,
  });
  env = proxy.env as Env;
  dispose = proxy.dispose;
  const migrations = fs.readdirSync(path.join(HERE, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    const sql = fs.readFileSync(path.join(HERE, '..', 'migrations', file), 'utf8');
    for (const statement of sqlStatements(sql)) {
      await env.DB.prepare(statement).run();
    }
  }
});

test.after(async () => {
  await dispose();
});

function sqlStatements(sql: string): string[] {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
  return stripped.split(';').map((part) => part.trim()).filter(Boolean);
}

function withVars(base: Env, vars: Record<string, string>): Env {
  return Object.assign(Object.create(base), vars);
}

async function api(pathname: string, init: RequestInit = {}, bindings: Env = env): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type') && typeof init.body === 'string') {
    headers.set('content-type', 'application/json');
  }
  return app.request(`http://localhost${pathname}`, { ...init, headers }, bindings);
}

async function createUser(email: string, opts: { trialEndsAt?: number; deleted?: boolean } = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, created_at, trial_ends_at, lemonsqueezy_customer_id, deleted_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, email, now, opts.trialEndsAt ?? now + 86_400_000, opts.deleted ? now : null)
    .run();
  const session = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, device_label, created_at, last_seen_at)
     VALUES (?, ?, 'test', ?, ?)`,
  )
    .bind(session, id, now, now)
    .run();
  return { id, session };
}

async function issueToken(session: string, label = 'assistant') {
  const res = await api('/v1/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${session}` },
    body: JSON.stringify({ label }),
  });
  const body = await res.json() as { ok: boolean; token: string; token_record: { id: string; prefix: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

function mcp(token: string, message: unknown, extra: Record<string, string> = {}) {
  return api('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(message),
  });
}

test('session still verifies a license and an inbox token cannot', async () => {
  const user = await createUser(`license-${crypto.randomUUID()}@example.com`);
  const ok = await api('/license/verify', { headers: { authorization: `Bearer ${user.session}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json() as { ok: boolean; user: { id: string } };
  assert.equal(body.ok, true);
  assert.equal(body.user.id, user.id);

  const issued = await issueToken(user.session);
  const blocked = await api('/license/verify', { headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(blocked.status, 403);
  const ai = await api('/ai/usage', { headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(ai.status, 403);
});

test('tokens are hashed, shown once, revoked, and capped', async () => {
  const user = await createUser(`tok-${crypto.randomUUID()}@example.com`);
  const issued = await issueToken(user.session, 'drippie');
  assert.ok(issued.token.startsWith('gos_in_'));
  const stored = await env.DB.prepare(`SELECT token_hash, prefix, label, scopes FROM api_tokens WHERE id = ?`)
    .bind(issued.token_record.id)
    .first<{ token_hash: string; prefix: string; label: string; scopes: string }>();
  assert.ok(stored);
  assert.notEqual(stored.token_hash, issued.token);
  assert.equal(stored.token_hash.length, 64);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  assert.equal(stored.label, 'drippie');
  assert.deepEqual(JSON.parse(stored.scopes), ['inbox:write']);

  const list = await api('/v1/tokens', { headers: { authorization: `Bearer ${user.session}` } });
  const listed = await list.json() as { tokens: { id: string; prefix: string }[] };
  assert.equal(listed.tokens.some((t) => t.id === issued.token_record.id), true);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);

  const badScope = await api('/v1/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ scopes: ['library:read'] }),
  });
  assert.equal(badScope.status, 400);

  const del = await api(`/v1/tokens/${issued.token_record.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${user.session}` },
  });
  assert.equal(del.status, 200);
  const after = await mcp(issued.token, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(after.status, 401);

  const limited = withVars(env, { INBOX_MAX_ACTIVE_TOKENS: '1' });
  const first = await api('/v1/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ label: 'one' }),
  }, limited);
  assert.equal(first.status, 201);
  const second = await api('/v1/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ label: 'two' }),
  }, limited);
  assert.equal(second.status, 409);
});

test('mcp add_item, dedupe, idempotency, and scoping', async () => {
  const a = await createUser(`a-${crypto.randomUUID()}@example.com`);
  const b = await createUser(`b-${crypto.randomUUID()}@example.com`);
  const tokenA = (await issueToken(a.session, 'assistant')).token;
  const tokenB = (await issueToken(b.session, 'other')).token;
  const itemId = crypto.randomUUID();

  const sessionOnMcp = await mcp(a.session, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(sessionOnMcp.status, 403);

  const init = await mcp(tokenA, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get('content-type'), 'application/json');
  const initBody = await init.json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
  assert.equal(initBody.result.protocolVersion, '2025-06-18');

  const evil = await mcp(tokenA, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);

  const added = await mcp(tokenA, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'add_item',
      arguments: {
        id: itemId,
        title: 'Ramp home',
        note: 'One input, three chips.',
        source_url: 'https://mobbin.com/screens/ramp',
        source_name: 'mobbin',
        tags: ['ai-patterns', 'empty-state'],
        image_base64: PNG_B64,
        collection_id: 'not-a-real-one',
      },
    },
  });
  const addedBody = await added.json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(added.status, 200);
  const payload = JSON.parse(addedBody.result.content[0]!.text) as { ok: boolean; id: string; duplicate: boolean; asset_stored: boolean };
  assert.equal(addedBody.result.isError, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, itemId);
  assert.equal(payload.duplicate, false);
  assert.equal(payload.asset_stored, true);

  const again = await mcp(tokenA, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'add_item', arguments: { id: itemId, image_base64: PNG_B64, title: 'ignored' } },
  });
  const againPayload = JSON.parse(((await again.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { idempotent: boolean; id: string };
  assert.equal(againPayload.idempotent, true);
  assert.equal(againPayload.id, itemId);

  const otherId = crypto.randomUUID();
  const dup = await mcp(tokenA, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'add_item', arguments: { id: otherId, image_base64: PNG_B64, title: 'same bytes' } },
  });
  const dupPayload = JSON.parse(((await dup.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { duplicate: boolean; id: string };
  assert.equal(dupPayload.duplicate, true);
  assert.equal(dupPayload.id, itemId);

  const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox_items WHERE user_id = ? AND deleted_at IS NULL`)
    .bind(a.id)
    .first<{ n: number }>();
  assert.equal(rows?.n, 1);

  const recentA = await mcp(tokenA, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'list_recent_inbox_items', arguments: { limit: 5 } },
  });
  const recentPayload = JSON.parse(((await recentA.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { items: { id: string; title: string }[] };
  assert.equal(recentPayload.items.length, 1);
  assert.equal(recentPayload.items[0]!.id, itemId);
  assert.equal(JSON.stringify(recentPayload).includes('r2_key'), false);

  const recentB = await mcp(tokenB, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'list_recent_inbox_items', arguments: {} },
  });
  const recentBPayload = JSON.parse(((await recentB.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { items: unknown[] };
  assert.deepEqual(recentBPayload.items, []);

  const readWithToken = await api('/v1/inbox/items?status=pending', { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(readWithToken.status, 403);
  const assetWithToken = await api(`/v1/inbox/items/${itemId}/asset`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(assetWithToken.status, 403);

  const listB = await api('/v1/inbox/items?status=pending', { headers: { authorization: `Bearer ${b.session}` } });
  const listBBody = await listB.json() as { items: unknown[] };
  assert.equal(listB.status, 200);
  assert.deepEqual(listBBody.items, []);
  const ackB = await api(`/v1/inbox/items/${itemId}/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.session}` },
    body: JSON.stringify({ result: 'imported', save_id: crypto.randomUUID() }),
  });
  assert.equal(ackB.status, 404);
  const assetB = await api(`/v1/inbox/items/${itemId}/asset`, { headers: { authorization: `Bearer ${b.session}` } });
  assert.equal(assetB.status, 404);

  const listA = await api('/v1/inbox/items?status=pending&limit=10', { headers: { authorization: `Bearer ${a.session}` } });
  const listABody = await listA.json() as { items: { id: string; has_asset: boolean; title: string; note: string; tags: string[] }[]; pending_count: number };
  assert.equal(listABody.pending_count, 1);
  assert.equal(listABody.items[0]!.id, itemId);
  assert.equal(listABody.items[0]!.has_asset, true);
  assert.equal(listABody.items[0]!.title, 'Ramp home');
  assert.equal(listABody.items[0]!.note, 'One input, three chips.');
  assert.deepEqual(listABody.items[0]!.tags, ['ai-patterns', 'empty-state']);
  assert.equal(JSON.stringify(listABody).includes('users/'), false);

  const asset = await api(`/v1/inbox/items/${itemId}/asset?variant=original`, { headers: { authorization: `Bearer ${a.session}` } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  const got = new Uint8Array(await asset.arrayBuffer());
  assert.deepEqual(got, PNG);
  const preview = await api(`/v1/inbox/items/${itemId}/asset?variant=preview`, { headers: { authorization: `Bearer ${a.session}` } });
  assert.equal(preview.status, 404);

  const postAsSession = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${a.session}` },
    body: JSON.stringify({ title: 'nope', source_url: 'https://example.com' }),
  });
  assert.equal(postAsSession.status, 403);
});

test('collections catalog is names only and unknown ids are rejected once published', async () => {
  const user = await createUser(`col-${crypto.randomUUID()}@example.com`);
  const token = (await issueToken(user.session)).token;
  const col = crypto.randomUUID();
  const put = await api('/v1/inbox/collections', {
    method: 'PUT',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ collections: [{ id: col, name: 'Boards', kind: 'board' }] }),
  });
  assert.equal(put.status, 200);
  const listed = await mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_collections', arguments: {} } });
  const body = JSON.parse(((await listed.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { collections: { id: string; name: string; kind: string }[] };
  assert.deepEqual(body.collections, [{ id: col, name: 'Boards', kind: 'board' }]);

  const tokenPut = await api('/v1/inbox/collections', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ collections: [] }),
  });
  assert.equal(tokenPut.status, 403);

  const missing = await mcp(token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'add_item', arguments: { source_url: 'https://example.com/page', collection_id: crypto.randomUUID() } },
  });
  const missingBody = await missing.json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(missingBody.result.isError, true);
  assert.equal(JSON.parse(missingBody.result.content[0]!.text).error, 'unknown_collection');
});

test('limits: oversized, non-image, and daily cap', async () => {
  const user = await createUser(`lim-${crypto.randomUUID()}@example.com`);
  const token = (await issueToken(user.session)).token;
  const tiny = withVars(env, { INBOX_MAX_ASSET_BYTES: '16', INBOX_DAILY_ITEM_LIMIT: '1' });

  const big = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_base64: PNG_B64, title: 'too big for the test cap' }),
  }, tiny);
  assert.equal(big.status, 413);

  const text = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_base64: Buffer.from('hello world!!!!').toString('base64'), title: 'not an image' }),
  }, env);
  assert.equal(text.status, 415);

  const blocked = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_url: 'https://127.0.0.1/secret.png', title: 'no' }),
  });
  assert.equal(blocked.status, 400);

  const page = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_url: 'https://example.com/article', title: 'A page', source_name: 'web' }),
  }, tiny);
  assert.equal(page.status, 201);
  const second = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_url: 'https://example.com/another', title: 'Another' }),
  }, tiny);
  assert.equal(second.status, 429);
});

test('ack leaves the pending page and revoke drops that token\'s queue', async () => {
  const user = await createUser(`ack-${crypto.randomUUID()}@example.com`);
  const issued = await issueToken(user.session);
  const id = crypto.randomUUID();
  const created = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ id, image_base64: PNG_B64, title: 'Ack me' }),
  });
  assert.equal(created.status, 201);
  const saveId = crypto.randomUUID();
  const ack = await api(`/v1/inbox/items/${id}/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ result: 'imported', save_id: saveId }),
  });
  assert.equal(ack.status, 200);
  const again = await api(`/v1/inbox/items/${id}/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.session}` },
    body: JSON.stringify({ result: 'imported', save_id: saveId }),
  });
  const againBody = await again.json() as { idempotent: boolean; status: string };
  assert.equal(againBody.idempotent, true);
  assert.equal(againBody.status, 'delivered');
  const pending = await api('/v1/inbox/items?status=pending', { headers: { authorization: `Bearer ${user.session}` } });
  const pendingBody = await pending.json() as { items: unknown[]; pending_count: number };
  assert.equal(pendingBody.pending_count, 0);
  assert.deepEqual(pendingBody.items, []);

  const queued = crypto.randomUUID();
  const second = await issueToken(user.session, 'second');
  const made = await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${second.token}` },
    body: JSON.stringify({ id: queued, source_url: 'https://example.com/queued' }),
  });
  assert.equal(made.status, 201);
  const revoke = await api(`/v1/tokens/${second.token_record.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${user.session}` },
  });
  assert.equal(revoke.status, 200);
  const still = await api('/v1/inbox/items?status=pending', { headers: { authorization: `Bearer ${user.session}` } });
  const stillBody = await still.json() as { items: { id: string }[] };
  assert.equal(stillBody.items.some((item) => item.id === queued), false);
});

test('maintenance purges old pending items and delivered bytes', async () => {
  const user = await createUser(`purge-${crypto.randomUUID()}@example.com`);
  const token = (await issueToken(user.session)).token;
  const oldPending = crypto.randomUUID();
  const oldDelivered = crypto.randomUUID();
  const now = Date.now();
  const day = 86_400_000;
  await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: oldPending, image_base64: PNG_B64, title: 'stale' }),
  });
  await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: oldDelivered, image_base64: PNG_B64, title: 'done' }),
  });
  // The second image is a duplicate of the first, so it does not create
  // a row. Attach a distinct URL-only item and pretend it was delivered
  // with an object still in R2 by copying the first object's key.
  const deliveredId = crypto.randomUUID();
  await api('/v1/inbox/items', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: deliveredId, source_url: 'https://example.com/done', title: 'done' }),
  });
  const key = `users/${user.id}/inbox/${oldPending}/original`;
  await env.DB.prepare(
    `UPDATE inbox_items SET received_at = ? WHERE id = ?`,
  ).bind(now - 31 * day, oldPending).run();
  await env.DB.prepare(
    `UPDATE inbox_items SET status = 'delivered', delivered_at = ?, r2_key = ?, content_hash = NULL WHERE id = ?`,
  ).bind(now - 8 * day, key, deliveredId).run();

  const result = await runInboxMaintenance(env, now);
  assert.ok(result.pending >= 1);
  assert.ok(result.delivered >= 1);
  const pendingRow = await env.DB.prepare(`SELECT deleted_at, r2_key FROM inbox_items WHERE id = ?`).bind(oldPending).first<{ deleted_at: number | null; r2_key: string | null }>();
  assert.ok(pendingRow?.deleted_at);
  assert.equal(pendingRow?.r2_key, null);
  assert.ok(env.ASSETS);
  const gone = await env.ASSETS.get(key);
  assert.equal(gone, null);
  const deliveredRow = await env.DB.prepare(`SELECT deleted_at, r2_key FROM inbox_items WHERE id = ?`).bind(deliveredId).first<{ deleted_at: number | null; r2_key: string | null }>();
  assert.ok(deliveredRow?.deleted_at);
  assert.equal(deliveredRow?.r2_key, null);
});
