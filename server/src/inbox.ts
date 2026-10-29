// Account-scoped inbox queue.
//
// Write routes accept an inbox token only. Read, ack, and the
// collection catalog accept a session token only. A write token cannot
// list the queue or stream bytes; the desktop pulls with the session.

import { Hono } from 'hono';
import type { Env } from './types';
import type { ApiTokenAuth } from './auth';
import { requireInboxWrite, requireSession } from './auth';
import { sha256HexBytes } from './crypto';
import { decodeBase64 } from './crypto';
import {
  InboxError,
  assertPublicHttpsUrl,
  assertPublicPageUrl,
  cleanCollectionId,
  cleanCollectionKind,
  cleanCollectionName,
  cleanHttpUrl,
  cleanRating,
  collectionNameKey,
  cleanLine,
  cleanNote,
  cleanSourceName,
  cleanTags,
  detectImageMime,
  fetchRemoteImage,
  inboxAssetKey,
  isUuid,
  keyBelongsToUser,
  limitsFromEnv,
  type InboxLimits,
} from './inbox-validate';

export const inboxRoutes = new Hono<{ Bindings: Env }>();

const ITEM_COLUMNS = `i.id, i.user_id, i.token_id, i.kind, i.title, i.note, i.source_name,
  i.source_url, i.image_url, i.tags, i.content_hash, i.r2_key, i.bytes, i.mime,
  i.collection_id, i.collection_kind, i.collection_name, i.created_at, i.received_at, i.delivered_at,
  i.delivered_save_id, i.status, i.error, i.deleted_at`;

export interface ItemRow {
  id: string;
  user_id: string;
  token_id: string;
  kind: string;
  title: string | null;
  note: string | null;
  source_name: string | null;
  source_url: string | null;
  image_url: string | null;
  tags: string | null;
  content_hash: string | null;
  r2_key: string | null;
  bytes: number | null;
  mime: string | null;
  collection_id: string | null;
  collection_kind: string | null;
  collection_name: string | null;
  created_at: number | null;
  received_at: number;
  delivered_at: number | null;
  delivered_save_id: string | null;
  status: string;
  error: string | null;
  deleted_at: number | null;
  token_label?: string | null;
}

export interface CreateInboxInput {
  id?: unknown;
  title?: unknown;
  note?: unknown;
  source_url?: unknown;
  source_name?: unknown;
  tags?: unknown;
  image_url?: unknown;
  image_base64?: unknown;
  collection_id?: unknown;
  collection_kind?: unknown;
  collection_name?: unknown;
  created_at?: unknown;
  content_hash?: unknown;
}

export interface CreateInboxResult {
  ok: true;
  id: string;
  duplicate: boolean;
  idempotent: boolean;
  asset_stored: boolean;
  status: string;
  fetch_error?: string;
}

inboxRoutes.post('/items', async (c) => {
  const auth = await requireInboxWrite(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json<CreateInboxInput>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ ok: false, error: 'invalid_json' }, 400);
  try {
    const result = await createInboxItem(c.env, auth, body);
    const status = result.idempotent || result.duplicate ? 200 : 201;
    return c.json(result, status);
  } catch (err) {
    return inboxErrorResponse(err);
  }
});

inboxRoutes.put('/items/:id/asset', async (c) => {
  const auth = await requireInboxWrite(c);
  if (auth instanceof Response) return auth;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ ok: false, error: 'invalid_id' }, 400);
  const mimeHeader = (c.req.header('content-type') || '').split(';')[0]?.trim().toLowerCase() || '';
  if (mimeHeader.startsWith('image/svg')) return c.json({ ok: false, error: 'unsupported_media' }, 415);
  const limits = limitsFromEnv(c.env);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await attachInboxAsset(c.env, auth, id, buf, limits);
    return c.json(result, result.duplicate || result.idempotent ? 200 : 200);
  } catch (err) {
    return inboxErrorResponse(err);
  }
});

inboxRoutes.get('/items', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const status = c.req.query('status') || 'pending';
  if (!['pending', 'delivered', 'duplicate', 'failed'].includes(status)) {
    return c.json({ ok: false, error: 'invalid_status' }, 400);
  }
  const limit = clampLimit(c.req.query('limit'), 50);
  const cursor = decodeCursor(c.req.query('cursor') || '');
  if (c.req.query('cursor') && !cursor) return c.json({ ok: false, error: 'invalid_cursor' }, 400);

  const params: unknown[] = [user.id, status];
  let cursorSql = '';
  if (cursor) {
    cursorSql = ' AND (i.received_at > ? OR (i.received_at = ? AND i.id > ?))';
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }
  params.push(limit + 1);
  const rows = await c.env.DB.prepare(
    `SELECT ${ITEM_COLUMNS}, t.label AS token_label
       FROM inbox_items i
       LEFT JOIN api_tokens t ON t.id = i.token_id
      WHERE i.user_id = ? AND i.status = ? AND i.deleted_at IS NULL
      ${cursorSql}
      ORDER BY i.received_at ASC, i.id ASC
      LIMIT ?`,
  )
    .bind(...params)
    .all<ItemRow>();
  const all = rows.results || [];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const next = all.length > limit && last
    ? encodeCursor(last.received_at, last.id)
    : null;
  const pending = await pendingCount(c.env, user.id);
  return c.json({
    ok: true,
    items: page.map(publicItem),
    next_cursor: next,
    pending_count: pending,
  });
});

inboxRoutes.get('/status', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  return c.json({ ok: true, pending_count: await pendingCount(c.env, user.id) });
});

inboxRoutes.get('/items/:id/asset', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const variant = c.req.query('variant') || 'original';
  if (variant !== 'original') {
    return c.json({ ok: false, error: 'variant_unavailable', variant }, 404);
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, r2_key, mime, deleted_at FROM inbox_items WHERE id = ?`,
  )
    .bind(id)
    .first<Pick<ItemRow, 'id' | 'user_id' | 'r2_key' | 'mime' | 'deleted_at'>>();
  if (!row || row.user_id !== user.id || row.deleted_at || !row.r2_key) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  if (!keyBelongsToUser(row.r2_key, user.id)) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  if (!c.env.ASSETS) return c.json({ ok: false, error: 'asset_storage_unconfigured' }, 503);
  const obj = await c.env.ASSETS.get(row.r2_key);
  if (!obj) return c.json({ ok: false, error: 'not_found' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', row.mime || obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { status: 200, headers });
});

inboxRoutes.post('/items/:id/ack', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const id = c.req.param('id');
  const body = await c.req.json<{ result?: unknown; save_id?: unknown; error?: unknown }>().catch(() => ({} as { result?: unknown; save_id?: unknown; error?: unknown }));
  const result = body.result;
  if (result !== 'imported' && result !== 'duplicate' && result !== 'failed') {
    return c.json({ ok: false, error: 'invalid_result' }, 400);
  }
  let saveId: string | null = null;
  if (body.save_id != null && body.save_id !== '') {
    if (typeof body.save_id !== 'string' || !isUuid(body.save_id)) {
      return c.json({ ok: false, error: 'invalid_save_id' }, 400);
    }
    saveId = body.save_id;
  }
  let error: string | null = null;
  if (body.error != null) {
    if (typeof body.error !== 'string') return c.json({ ok: false, error: 'invalid_error' }, 400);
    error = body.error.replace(/\u0000/g, '').slice(0, 500);
  }
  const row = await loadOwnItem(c.env, user.id, id);
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  if (row.status !== 'pending') {
    return c.json({ ok: true, id: row.id, status: row.status, idempotent: true });
  }
  const now = Date.now();
  // The desktop says "imported". The queue status is "delivered" so
  // list filters and retention share one word for "the app has it".
  const stored = result === 'imported' ? 'delivered' : result;
  await c.env.DB.prepare(
    `UPDATE inbox_items
        SET status = ?, delivered_at = ?, delivered_save_id = ?, error = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'`,
  )
    .bind(stored, now, saveId, error, id, user.id)
    .run();
  return c.json({ ok: true, id, status: stored });
});

inboxRoutes.delete('/items/:id', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const row = await loadOwnItem(c.env, user.id, c.req.param('id'));
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  await tombstoneItem(c.env, row);
  return c.json({ ok: true });
});

inboxRoutes.put('/collections', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ collections?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.collections)) {
    return c.json({ ok: false, error: 'invalid_collections' }, 400);
  }
  if (body.collections.length > 200) return c.json({ ok: false, error: 'too_many_collections' }, 400);
  const now = Date.now();
  const rows: { id: string; name: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const entry of body.collections) {
    if (!entry || typeof entry !== 'object') return c.json({ ok: false, error: 'invalid_collections' }, 400);
    const rec = entry as { id?: unknown; name?: unknown; kind?: unknown };
    const id = cleanCollectionId(rec.id);
    const kind = cleanCollectionKind(rec.kind) || 'collection';
    const name = cleanLine(rec.name, 200, 'invalid_name');
    if (!id || !name) return c.json({ ok: false, error: 'invalid_collections' }, 400);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name, kind });
  }
  await c.env.DB.prepare(`DELETE FROM inbox_collections WHERE user_id = ?`).bind(user.id).run();
  for (const row of rows) {
    await c.env.DB.prepare(
      `INSERT INTO inbox_collections (user_id, collection_id, name, kind, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(user.id, row.id, row.name, row.kind, now)
      .run();
  }
  return c.json({ ok: true, count: rows.length });
});

// Ratings: the desktop pushes like / dislike / cleared for its own
// inbox items. Last write wins by rated_at so a slow device cannot
// undo a newer rating.
inboxRoutes.post('/ratings', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ ratings?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ratings)) return c.json({ ok: false, error: 'invalid_ratings' }, 400);
  if (body.ratings.length > 200) return c.json({ ok: false, error: 'too_many_ratings' }, 400);
  try {
    const result = await writeRatings(c.env, user.id, body.ratings);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return inboxErrorResponse(err);
  }
});

// Filings queued by file_items, for the desktop to apply.
inboxRoutes.get('/filings', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const rows = await c.env.DB.prepare(
    `SELECT id, item_id, collection_id, collection_kind, collection_name, created_at
       FROM inbox_filings
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
  )
    .bind(user.id)
    .all<FilingRow>();
  return c.json({ ok: true, filings: rows.results || [] });
});

inboxRoutes.post('/filings/ack', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ results?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.results)) return c.json({ ok: false, error: 'invalid_results' }, 400);
  if (body.results.length > 200) return c.json({ ok: false, error: 'too_many_results' }, 400);
  const now = Date.now();
  let updated = 0;
  for (const entry of body.results) {
    if (!entry || typeof entry !== 'object') return c.json({ ok: false, error: 'invalid_results' }, 400);
    const rec = entry as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof rec.id !== 'string' || !isUuid(rec.id)) return c.json({ ok: false, error: 'invalid_id' }, 400);
    if (rec.result !== 'applied' && rec.result !== 'skipped' && rec.result !== 'failed') {
      return c.json({ ok: false, error: 'invalid_result' }, 400);
    }
    const error = typeof rec.error === 'string' ? rec.error.replace(/\u0000/g, '').slice(0, 200) : null;
    const res = await c.env.DB.prepare(
      `UPDATE inbox_filings SET status = ?, error = ?, applied_at = ?
        WHERE id = ? AND user_id = ? AND status = 'pending'`,
    )
      .bind(rec.result, error, now, rec.id, user.id)
      .run();
    updated += res.meta?.changes || 0;
  }
  return c.json({ ok: true, updated });
});

export async function createInboxItem(
  env: Env,
  auth: ApiTokenAuth,
  input: CreateInboxInput,
): Promise<CreateInboxResult> {
  const limits = limitsFromEnv(env);
  const title = cleanLine(input.title, 300, 'invalid_title');
  const note = cleanNote(input.note, limits.noteMax);
  const sourceName = cleanSourceName(input.source_name);
  const tags = cleanTags(input.tags);
  const collectionId = cleanCollectionId(input.collection_id);
  let collectionKind = cleanCollectionKind(input.collection_kind);
  const collectionName = collectionId ? null : cleanCollectionName(input.collection_name);
  const sourceUrlRaw = cleanHttpUrl(input.source_url, 'invalid_source_url');
  const imageUrlRaw = cleanHttpUrl(input.image_url, 'invalid_image_url');
  if (sourceUrlRaw) assertPublicPageUrl(sourceUrlRaw);
  if (imageUrlRaw) assertPublicHttpsUrl(imageUrlRaw);

  let bytes: Uint8Array | null = null;
  let mime: string | null = null;
  let fetchError: string | undefined;
  if (typeof input.image_base64 === 'string' && input.image_base64.trim()) {
    let decoded: { bytes: Uint8Array };
    try {
      decoded = decodeBase64(input.image_base64);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'asset_too_large') throw new InboxError(413, 'asset_too_large');
      throw new InboxError(400, 'invalid_image');
    }
    if (decoded.bytes.byteLength > limits.maxAssetBytes) throw new InboxError(413, 'asset_too_large');
    mime = detectImageMime(decoded.bytes);
    if (!mime) throw new InboxError(415, 'unsupported_media');
    bytes = decoded.bytes;
  } else if (imageUrlRaw) {
    try {
      const fetched = await fetchRemoteImage(imageUrlRaw, limits.maxAssetBytes);
      bytes = fetched.bytes;
      mime = fetched.mime;
    } catch (err) {
      if (err instanceof InboxError && (err.code === 'asset_too_large' || err.code === 'unsupported_media' || err.code === 'image_url_blocked' || err.code === 'image_url_not_https' || err.code === 'invalid_image_url')) {
        throw err;
      }
      // Transient fetch failures still queue the URL. The desktop retries
      // the download on its own network.
      fetchError = err instanceof InboxError ? err.code : 'image_fetch_failed';
    }
  }

  if (!bytes && !imageUrlRaw && !sourceUrlRaw) throw new InboxError(400, 'missing_content');
  const kind = bytes || imageUrlRaw ? 'image' : 'url';

  await assertKnownCollection(env, auth.user.id, collectionId, collectionKind);
  if (collectionId && !collectionKind) {
    const catalogKind = await catalogKindFor(env, auth.user.id, collectionId);
    collectionKind = catalogKind || 'collection';
  }

  const id = typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID();
  if (!isUuid(id)) throw new InboxError(400, 'invalid_id');

  const existing = await env.DB.prepare(
    `SELECT ${bareColumns()} FROM inbox_items WHERE id = ?`,
  )
    .bind(id)
    .first<ItemRow>();
  if (existing && existing.user_id !== auth.user.id) throw new InboxError(409, 'id_conflict');
  if (existing && existing.deleted_at) throw new InboxError(409, 'id_conflict');
  if (existing) {
    if (bytes && !existing.r2_key && existing.status === 'pending') {
      const stored = await storeBytesOnItem(env, auth, existing, bytes, mime || 'application/octet-stream', limits, input.content_hash);
      return { ...stored, idempotent: true };
    }
    return {
      ok: true,
      id: existing.id,
      duplicate: false,
      idempotent: true,
      asset_stored: !!existing.r2_key,
      status: existing.status,
    };
  }

  let hash: string | null = null;
  if (bytes) {
    hash = await sha256HexBytes(bytes);
    if (typeof input.content_hash === 'string' && input.content_hash.trim()) {
      if (input.content_hash.trim().toLowerCase() !== hash) throw new InboxError(400, 'hash_mismatch');
    }
    const dup = await findLiveByHash(env, auth.user.id, hash);
    if (dup) {
      return { ok: true, id: dup.id, duplicate: true, idempotent: false, asset_stored: !!dup.r2_key, status: dup.status };
    }
  }

  await assertQuota(env, auth, limits, bytes ? bytes.byteLength : 0);

  // A named target that already exists in the catalog becomes an id so
  // the desktop does not have to guess. An unknown name counts against
  // the daily new-collection cap; the desktop creates it on import.
  let targetId: string | null = collectionId;
  let targetKind: string | null = collectionKind;
  let targetName: string | null = null;
  if (collectionName) {
    const resolved = await resolveCollectionName(env, auth.user.id, collectionName);
    if (resolved) {
      targetId = resolved.id;
      targetKind = resolved.kind;
    } else {
      await chargeNewCollection(env, auth.user.id, collectionName);
      targetName = collectionName;
      targetKind = 'collection';
    }
  }

  const now = Date.now();
  const createdAt = cleanCreatedAt(input.created_at, now);
  try {
    await env.DB.prepare(
      `INSERT INTO inbox_items (
         id, user_id, token_id, kind, title, note, source_name, source_url, image_url,
         tags, content_hash, r2_key, bytes, mime, collection_id, collection_kind,
         collection_name, created_at, received_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
      .bind(
        id,
        auth.user.id,
        auth.tokenId,
        kind,
        title,
        note,
        sourceName,
        sourceUrlRaw,
        imageUrlRaw,
        JSON.stringify(tags),
        hash,
        bytes ? bytes.byteLength : null,
        mime,
        targetId,
        targetKind,
        targetName,
        createdAt,
        now,
      )
      .run();
  } catch (err) {
    if (!isUniqueError(err) || !hash) throw err;
    const dup = await findLiveByHash(env, auth.user.id, hash);
    if (dup) {
      return { ok: true, id: dup.id, duplicate: true, idempotent: false, asset_stored: !!dup.r2_key, status: dup.status };
    }
    throw err;
  }

  if (bytes && mime && hash) {
    const row = await env.DB.prepare(`SELECT ${bareColumns()} FROM inbox_items WHERE id = ?`)
      .bind(id)
      .first<ItemRow>();
    if (!row) throw new InboxError(500, 'server_error');
    const stored = await storeBytesOnItem(env, auth, row, bytes, mime, limits, hash);
    return fetchError ? { ...stored, fetch_error: fetchError } : stored;
  }

  return {
    ok: true,
    id,
    duplicate: false,
    idempotent: false,
    asset_stored: false,
    status: 'pending',
    ...(fetchError ? { fetch_error: fetchError } : {}),
  };
}

async function storeBytesOnItem(
  env: Env,
  auth: ApiTokenAuth,
  row: ItemRow,
  bytes: Uint8Array,
  mime: string,
  limits: InboxLimits,
  hintedHash: unknown,
): Promise<CreateInboxResult> {
  if (bytes.byteLength > limits.maxAssetBytes) throw new InboxError(413, 'asset_too_large');
  const detected = detectImageMime(bytes);
  if (!detected) throw new InboxError(415, 'unsupported_media');
  const hash = await sha256HexBytes(bytes);
  if (typeof hintedHash === 'string' && hintedHash.trim() && hintedHash.trim().toLowerCase() !== hash) {
    throw new InboxError(400, 'hash_mismatch');
  }
  if (row.content_hash && row.content_hash !== hash) {
    return {
      ok: true,
      id: row.id,
      duplicate: false,
      idempotent: true,
      asset_stored: !!row.r2_key,
      status: row.status,
    };
  }
  const dup = await findLiveByHash(env, auth.user.id, hash);
  if (dup && dup.id !== row.id) {
    await tombstoneItem(env, row);
    return { ok: true, id: dup.id, duplicate: true, idempotent: false, asset_stored: !!dup.r2_key, status: dup.status };
  }
  if (!row.r2_key) {
    const pending = await pendingBytes(env, auth.user.id);
    const already = row.bytes || 0;
    if (pending - already + bytes.byteLength > limits.pendingBytesCap) {
      throw new InboxError(413, 'pending_quota');
    }
  }
  const key = inboxAssetKey(auth.user.id, row.id);
  if (!env.ASSETS) throw new InboxError(503, 'asset_storage_unconfigured');
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: detected } });
  await env.DB.prepare(
    `UPDATE inbox_items
        SET content_hash = ?, r2_key = ?, bytes = ?, mime = ?, kind = 'image'
      WHERE id = ? AND user_id = ?`,
  )
    .bind(hash, key, bytes.byteLength, detected, row.id, auth.user.id)
    .run();
  return { ok: true, id: row.id, duplicate: false, idempotent: !!row.r2_key, asset_stored: true, status: row.status };
}

export async function attachInboxAsset(
  env: Env,
  auth: ApiTokenAuth,
  id: string,
  bytes: Uint8Array,
  limits: InboxLimits,
): Promise<CreateInboxResult> {
  const row = await env.DB.prepare(`SELECT ${bareColumns()} FROM inbox_items WHERE id = ?`)
    .bind(id)
    .first<ItemRow>();
  if (!row || row.deleted_at || row.user_id !== auth.user.id) throw new InboxError(404, 'not_found');
  if (row.token_id !== auth.tokenId && row.user_id !== auth.user.id) throw new InboxError(404, 'not_found');
  if (row.status !== 'pending') {
    return { ok: true, id: row.id, duplicate: false, idempotent: true, asset_stored: !!row.r2_key, status: row.status };
  }
  return storeBytesOnItem(env, auth, row, bytes, 'application/octet-stream', limits, null);
}

export async function listRecentForToken(env: Env, userId: string, limit: number): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT id, title, note, status, source_name, source_url, tags, collection_id, collection_kind, collection_name, received_at
       FROM inbox_items
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY received_at DESC
      LIMIT ?`,
  )
    .bind(userId, limit)
    .all<{
      id: string;
      title: string | null;
      note: string | null;
      status: string;
      source_name: string | null;
      source_url: string | null;
      tags: string | null;
      collection_id: string | null;
      collection_kind: string | null;
      collection_name: string | null;
      received_at: number;
    }>();
  return (rows.results || []).map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    source_name: row.source_name,
    source_url: row.source_url,
    tags: parseTags(row.tags),
    collection_id: row.collection_id,
    collection_kind: row.collection_kind,
    collection_name: row.collection_name,
    received_at: row.received_at,
  }));
}

export async function listCatalog(env: Env, userId: string): Promise<{ id: string; name: string; kind: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT collection_id AS id, name, kind
       FROM inbox_collections
      WHERE user_id = ?
      ORDER BY name ASC`,
  )
    .bind(userId)
    .all<{ id: string; name: string; kind: string }>();
  return rows.results || [];
}

export async function purgeTokenPending(env: Env, userId: string, tokenId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, r2_key FROM inbox_items
      WHERE user_id = ? AND token_id = ? AND status = 'pending' AND deleted_at IS NULL`,
  )
    .bind(userId, tokenId)
    .all<Pick<ItemRow, 'id' | 'user_id' | 'r2_key'>>();
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE inbox_items
        SET deleted_at = ?, status = 'failed', error = 'token_revoked'
      WHERE user_id = ? AND token_id = ? AND status = 'pending' AND deleted_at IS NULL`,
  )
    .bind(now, userId, tokenId)
    .run();
  for (const row of rows.results || []) {
    if (row.r2_key) await deleteAsset(env, row.r2_key);
  }
  if ((rows.results || []).length) {
    await env.DB.prepare(
      `UPDATE inbox_items SET r2_key = NULL
        WHERE user_id = ? AND token_id = ? AND deleted_at IS NOT NULL AND error = 'token_revoked'`,
    )
      .bind(userId, tokenId)
      .run();
  }
}

export async function runInboxMaintenance(env: Env, now = Date.now()): Promise<{ pending: number; delivered: number }> {
  const limits = limitsFromEnv(env);
  const pendingCutoff = now - limits.pendingRetentionMs;
  const deliveredCutoff = now - limits.deliveredRetentionMs;
  const pending = await env.DB.prepare(
    `SELECT id, user_id, r2_key FROM inbox_items
      WHERE deleted_at IS NULL AND status = 'pending' AND received_at < ?
      LIMIT 500`,
  )
    .bind(pendingCutoff)
    .all<Pick<ItemRow, 'id' | 'user_id' | 'r2_key'>>();
  let pendingN = 0;
  for (const row of pending.results || []) {
    await env.DB.prepare(
      `UPDATE inbox_items
          SET deleted_at = ?, status = 'failed', error = 'expired', r2_key = NULL
        WHERE id = ?`,
    )
      .bind(now, row.id)
      .run();
    if (row.r2_key) await deleteAsset(env, row.r2_key);
    pendingN += 1;
  }
  const delivered = await env.DB.prepare(
    `SELECT id, r2_key FROM inbox_items
      WHERE deleted_at IS NULL AND status != 'pending'
        AND delivered_at IS NOT NULL AND delivered_at < ?
      LIMIT 500`,
  )
    .bind(deliveredCutoff)
    .all<{ id: string; r2_key: string | null }>();
  let deliveredN = 0;
  for (const row of delivered.results || []) {
    await env.DB.prepare(
      `UPDATE inbox_items SET deleted_at = ?, r2_key = NULL WHERE id = ?`,
    )
      .bind(now, row.id)
      .run();
    if (row.r2_key) await deleteAsset(env, row.r2_key);
    deliveredN += 1;
  }
  // Rows already tombstoned that still point at R2 (a revoke that died
  // mid-delete). Clear the object so retention is not best-effort only.
  const leftovers = await env.DB.prepare(
    `SELECT id, r2_key FROM inbox_items
      WHERE deleted_at IS NOT NULL AND r2_key IS NOT NULL
      LIMIT 200`,
  ).all<{ id: string; r2_key: string }>();
  for (const row of leftovers.results || []) {
    await deleteAsset(env, row.r2_key);
    await env.DB.prepare(`UPDATE inbox_items SET r2_key = NULL WHERE id = ?`).bind(row.id).run();
  }
  return { pending: pendingN, delivered: deliveredN };
}

// ── Ratings and filing ─────────────────────────────────────────────

export interface FilingRow {
  id: string;
  item_id: string;
  collection_id: string | null;
  collection_kind: string | null;
  collection_name: string | null;
  created_at: number;
}

// Items that can carry a rating or be filed: the user's own, and the
// desktop said it imported them as a new inbox save. Retention may
// have tombstoned the bytes; the metadata row is still there.
const FILEABLE_SQL = `status = 'delivered' AND delivered_save_id IS NOT NULL`;

export async function writeRatings(
  env: Env,
  userId: string,
  entries: unknown[],
): Promise<{ accepted: string[]; rejected: { item_id: string; error: string }[] }> {
  const now = Date.now();
  const accepted: string[] = [];
  const rejected: { item_id: string; error: string }[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new InboxError(400, 'invalid_ratings');
    const rec = entry as { item_id?: unknown; rating?: unknown; rated_at?: unknown };
    if (typeof rec.item_id !== 'string' || !isUuid(rec.item_id)) throw new InboxError(400, 'invalid_item_id');
    const rating = cleanRating(rec.rating);
    let ratedAt = typeof rec.rated_at === 'number' && Number.isFinite(rec.rated_at) && rec.rated_at > 0
      ? Math.floor(rec.rated_at)
      : now;
    if (ratedAt > now) ratedAt = now;
    const item = await env.DB.prepare(
      `SELECT id FROM inbox_items WHERE id = ? AND user_id = ? AND ${FILEABLE_SQL}`,
    )
      .bind(rec.item_id, userId)
      .first<{ id: string }>();
    if (!item) {
      rejected.push({ item_id: rec.item_id, error: 'not_found' });
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO inbox_ratings (user_id, item_id, rating, rated_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, item_id) DO UPDATE SET
         rating = excluded.rating,
         rated_at = excluded.rated_at,
         updated_at = excluded.updated_at
       WHERE excluded.rated_at >= inbox_ratings.rated_at`,
    )
      .bind(userId, rec.item_id, rating, ratedAt, now)
      .run();
    accepted.push(rec.item_id);
  }
  return { accepted, rejected };
}

export interface RatedItem {
  item_id: string;
  title: string | null;
  source_url: string | null;
  tags: string[];
  note: string | null;
  rating: string;
  rated_at: number;
  filing_status: string | null;
}

export async function listRatedItems(
  env: Env,
  userId: string,
  opts: { since?: number | null; rating?: 'like' | 'dislike' | 'any'; limit: number },
): Promise<RatedItem[]> {
  const params: unknown[] = [userId];
  let where = `r.user_id = ? AND r.rating IS NOT NULL`;
  if (opts.rating === 'like' || opts.rating === 'dislike') {
    where += ` AND r.rating = ?`;
    params.push(opts.rating);
  }
  if (opts.since != null) {
    where += ` AND r.rated_at >= ?`;
    params.push(opts.since);
  }
  params.push(opts.limit);
  const rows = await env.DB.prepare(
    `SELECT r.item_id, r.rating, r.rated_at, i.title, i.source_url, i.tags, i.note,
            (SELECT f.status FROM inbox_filings f
              WHERE f.user_id = r.user_id AND f.item_id = r.item_id
              ORDER BY f.created_at DESC LIMIT 1) AS filing_status
       FROM inbox_ratings r
       JOIN inbox_items i ON i.id = r.item_id AND i.user_id = r.user_id
      WHERE ${where} AND i.status = 'delivered' AND i.delivered_save_id IS NOT NULL
      ORDER BY r.rated_at DESC, r.item_id ASC
      LIMIT ?`,
  )
    .bind(...params)
    .all<{
      item_id: string;
      rating: string;
      rated_at: number;
      title: string | null;
      source_url: string | null;
      tags: string | null;
      note: string | null;
      filing_status: string | null;
    }>();
  return (rows.results || []).map((row) => ({
    item_id: row.item_id,
    title: row.title,
    source_url: row.source_url,
    tags: parseTags(row.tags),
    note: row.note,
    rating: row.rating,
    rated_at: row.rated_at,
    filing_status: row.filing_status,
  }));
}

export interface FileRequest {
  item_id?: unknown;
  collection_id?: unknown;
  collection_kind?: unknown;
  collection_name?: unknown;
}

export interface FileResult {
  item_id: string;
  ok: boolean;
  status?: 'queued' | 'retargeted';
  filing_id?: string;
  collection_id?: string | null;
  collection_kind?: string | null;
  collection_name?: string | null;
  will_create?: boolean;
  error?: string;
}

export async function fileItems(env: Env, auth: ApiTokenAuth, requests: unknown[]): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const raw of requests) {
    const rec = (raw && typeof raw === 'object' ? raw : {}) as FileRequest;
    const itemId = typeof rec.item_id === 'string' ? rec.item_id.trim() : '';
    if (!isUuid(itemId)) {
      out.push({ item_id: itemId, ok: false, error: 'invalid_item_id' });
      continue;
    }
    try {
      out.push(await fileOne(env, auth, itemId, rec));
    } catch (err) {
      if (err instanceof InboxError) out.push({ item_id: itemId, ok: false, error: err.code });
      else throw err;
    }
  }
  return out;
}

async function fileOne(env: Env, auth: ApiTokenAuth, itemId: string, rec: FileRequest): Promise<FileResult> {
  const userId = auth.user.id;
  const item = await env.DB.prepare(`SELECT ${bareColumns()} FROM inbox_items WHERE id = ? AND user_id = ?`)
    .bind(itemId, userId)
    .first<ItemRow>();
  if (!item) throw new InboxError(404, 'not_found');
  if (item.status === 'duplicate') throw new InboxError(409, 'not_inbox_save');
  if (item.status === 'failed') throw new InboxError(409, 'not_delivered');
  if (item.status === 'pending' && item.deleted_at) throw new InboxError(404, 'not_found');

  const collectionId = cleanCollectionId(rec.collection_id);
  let kind = cleanCollectionKind(rec.collection_kind);
  const name = collectionId ? null : cleanCollectionName(rec.collection_name);
  if (!collectionId && !name) throw new InboxError(400, 'missing_collection');

  let targetId: string | null = null;
  let targetName: string | null = null;
  let willCreate = false;
  if (collectionId) {
    await assertKnownCollection(env, userId, collectionId, kind);
    kind = kind || (await catalogKindFor(env, userId, collectionId)) || 'collection';
    targetId = collectionId;
  } else if (name) {
    const resolved = await resolveCollectionName(env, userId, name);
    if (resolved) {
      targetId = resolved.id;
      kind = resolved.kind;
    } else {
      await chargeNewCollection(env, userId, name);
      targetName = name;
      kind = 'collection';
      willCreate = true;
    }
  }

  if (item.status === 'pending') {
    // Not on the desktop yet: change where the import lands instead.
    await env.DB.prepare(
      `UPDATE inbox_items SET collection_id = ?, collection_kind = ?, collection_name = ?
        WHERE id = ? AND user_id = ? AND status = 'pending'`,
    )
      .bind(targetId, kind, targetName, itemId, userId)
      .run();
    return { item_id: itemId, ok: true, status: 'retargeted', collection_id: targetId, collection_kind: kind, collection_name: targetName, will_create: willCreate };
  }
  if (!item.delivered_save_id) throw new InboxError(409, 'not_inbox_save');

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE inbox_filings SET status = 'superseded', applied_at = ?
      WHERE user_id = ? AND item_id = ? AND status = 'pending'`,
  )
    .bind(now, userId, itemId)
    .run();
  const filingId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO inbox_filings (id, user_id, item_id, token_id, collection_id, collection_kind, collection_name, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(filingId, userId, itemId, auth.tokenId, targetId, kind, targetName, now)
    .run();
  return { item_id: itemId, ok: true, status: 'queued', filing_id: filingId, collection_id: targetId, collection_kind: kind, collection_name: targetName, will_create: willCreate };
}

// Case-insensitive match against the catalog the desktop last pushed.
// Collections win over boards with the same name.
export async function resolveCollectionName(
  env: Env,
  userId: string,
  name: string,
): Promise<{ id: string; kind: 'collection' | 'board'; name: string } | null> {
  const key = collectionNameKey(name);
  const catalog = await listCatalog(env, userId);
  const hits = catalog.filter((row) => collectionNameKey(row.name) === key);
  const hit = hits.find((row) => row.kind !== 'board') || hits[0];
  if (!hit) return null;
  return { id: hit.id, kind: hit.kind === 'board' ? 'board' : 'collection', name: hit.name };
}

// Each distinct new name counts once per rolling day. Asking for the
// same new name again inside that window is free.
async function chargeNewCollection(env: Env, userId: string, name: string): Promise<void> {
  const limits = limitsFromEnv(env);
  const key = collectionNameKey(name);
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  const existing = await env.DB.prepare(
    `SELECT created_at FROM inbox_new_collections WHERE user_id = ? AND name_key = ?`,
  )
    .bind(userId, key)
    .first<{ created_at: number }>();
  if (existing && existing.created_at >= since) return;
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inbox_new_collections WHERE user_id = ? AND created_at >= ?`,
  )
    .bind(userId, since)
    .first<{ n: number }>();
  if ((count?.n || 0) >= limits.dailyNewCollectionLimit) {
    throw new InboxError(429, 'collection_create_limit', { limit: limits.dailyNewCollectionLimit });
  }
  await env.DB.prepare(
    `INSERT INTO inbox_new_collections (user_id, name_key, created_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, name_key) DO UPDATE SET created_at = excluded.created_at`,
  )
    .bind(userId, key, now)
    .run();
}

async function assertQuota(env: Env, auth: ApiTokenAuth, limits: InboxLimits, extraBytes: number): Promise<void> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const perToken = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inbox_items WHERE token_id = ? AND received_at >= ?`,
  )
    .bind(auth.tokenId, since)
    .first<{ n: number }>();
  if ((perToken?.n || 0) >= limits.dailyItemLimit) {
    throw new InboxError(429, 'rate_limited', { limit: limits.dailyItemLimit });
  }
  const perUser = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inbox_items WHERE user_id = ? AND received_at >= ?`,
  )
    .bind(auth.user.id, since)
    .first<{ n: number }>();
  if ((perUser?.n || 0) >= limits.dailyUserLimit) {
    throw new InboxError(429, 'rate_limited', { limit: limits.dailyUserLimit });
  }
  if (extraBytes > 0) {
    const pending = await pendingBytes(env, auth.user.id);
    if (pending + extraBytes > limits.pendingBytesCap) throw new InboxError(413, 'pending_quota');
  }
}

async function pendingBytes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS n FROM inbox_items
      WHERE user_id = ? AND status = 'pending' AND deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n || 0;
}

async function pendingCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inbox_items
      WHERE user_id = ? AND status = 'pending' AND deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n || 0;
}

async function findLiveByHash(env: Env, userId: string, hash: string): Promise<ItemRow | null> {
  return env.DB.prepare(
    `SELECT ${bareColumns()} FROM inbox_items
      WHERE user_id = ? AND content_hash = ? AND deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(userId, hash)
    .first<ItemRow>();
}

async function loadOwnItem(env: Env, userId: string, id: string): Promise<ItemRow | null> {
  const row = await env.DB.prepare(`SELECT ${bareColumns()} FROM inbox_items WHERE id = ?`)
    .bind(id)
    .first<ItemRow>();
  if (!row || row.user_id !== userId || row.deleted_at) return null;
  return row;
}

async function assertKnownCollection(
  env: Env,
  userId: string,
  collectionId: string | null,
  kind: 'collection' | 'board' | null,
): Promise<void> {
  if (!collectionId) return;
  const catalog = await listCatalog(env, userId);
  if (catalog.length === 0) return;
  const hit = catalog.find((row) => row.id === collectionId);
  if (!hit) throw new InboxError(400, 'unknown_collection');
  if (kind && hit.kind !== kind) throw new InboxError(400, 'collection_kind_mismatch');
}

async function catalogKindFor(env: Env, userId: string, collectionId: string): Promise<'collection' | 'board' | null> {
  const row = await env.DB.prepare(
    `SELECT kind FROM inbox_collections WHERE user_id = ? AND collection_id = ?`,
  )
    .bind(userId, collectionId)
    .first<{ kind: string }>();
  if (row?.kind === 'board' || row?.kind === 'collection') return row.kind;
  return null;
}

async function tombstoneItem(env: Env, row: Pick<ItemRow, 'id' | 'r2_key'>): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE inbox_items SET deleted_at = ?, r2_key = NULL WHERE id = ?`,
  )
    .bind(now, row.id)
    .run();
  if (row.r2_key) await deleteAsset(env, row.r2_key);
}

async function deleteAsset(env: Env, key: string): Promise<void> {
  if (!env.ASSETS || !key) return;
  try {
    await env.ASSETS.delete(key);
  } catch (err) {
    console.error('[inbox] r2 delete failed');
    void err;
  }
}

function cleanCreatedAt(input: unknown, now: number): number {
  if (input == null) return now;
  if (typeof input !== 'number' || !Number.isFinite(input)) throw new InboxError(400, 'invalid_created_at');
  if (input < 0) throw new InboxError(400, 'invalid_created_at');
  if (input > now + 24 * 60 * 60 * 1000) return now;
  return Math.floor(input);
}

function publicItem(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    note: row.note,
    source_name: row.source_name,
    source_url: row.source_url,
    image_url: row.image_url,
    tags: parseTags(row.tags),
    content_hash: row.content_hash,
    has_asset: !!row.r2_key,
    mime: row.mime,
    bytes: row.bytes,
    collection_id: row.collection_id,
    collection_kind: row.collection_kind,
    collection_name: row.collection_name || null,
    status: row.status,
    received_at: row.received_at,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    delivered_save_id: row.delivered_save_id,
    token_label: row.token_label || null,
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function bareColumns(): string {
  return `id, user_id, token_id, kind, title, note, source_name, source_url, image_url, tags,
    content_hash, r2_key, bytes, mime, collection_id, collection_kind, collection_name, created_at, received_at,
    delivered_at, delivered_save_id, status, error, deleted_at`;
}

function encodeCursor(receivedAt: number, id: string): string {
  return btoa(JSON.stringify([receivedAt, id])).replace(/=+$/g, '');
}

function decodeCursor(raw: string): { receivedAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    const parsed = JSON.parse(atob(raw + pad));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const receivedAt = parsed[0];
    const id = parsed[1];
    if (typeof receivedAt !== 'number' || typeof id !== 'string') return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
}

function clampLimit(raw: string | undefined, max: number): number {
  const n = Number(raw || max);
  if (!Number.isFinite(n) || n < 1) return Math.min(50, max);
  return Math.min(max, Math.floor(n));
}

function isUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(msg);
}

export function inboxErrorResponse(err: unknown): Response {
  if (err instanceof InboxError) {
    return Response.json({ ok: false, error: err.code, ...(err.extra || {}) }, { status: err.status });
  }
  console.error('[inbox]', err instanceof Error ? err.name : 'error');
  return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
}
