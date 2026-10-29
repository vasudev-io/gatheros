// Session-scoped inbox token management.
//
// POST   /v1/tokens       issue a token (raw value returned once)
// GET    /v1/tokens       list active tokens, never the secret or its hash
// DELETE /v1/tokens/:id   revoke, and tombstone that token's pending items

import { Hono } from 'hono';
import type { Env } from './types';
import { requireSession } from './auth';
import { randomInboxToken, sha256Hex } from './crypto';
import { limitsFromEnv } from './inbox-validate';
import { purgeTokenPending } from './inbox';

export const tokenRoutes = new Hono<{ Bindings: Env }>();

const DAY = 24 * 60 * 60 * 1000;

tokenRoutes.post('/', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;

  const body = await c.req.json<{ label?: unknown; scopes?: unknown; expires_at?: unknown }>().catch(() => ({} as { label?: unknown; scopes?: unknown; expires_at?: unknown }));
  if (body.scopes != null) {
    const scopes = body.scopes;
    const ok = Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'inbox:write';
    if (!ok) return c.json({ ok: false, error: 'invalid_scope' }, 400);
  }
  let label = 'assistant';
  if (body.label != null) {
    if (typeof body.label !== 'string') return c.json({ ok: false, error: 'invalid_label' }, 400);
    label = body.label.trim().replace(/\u0000/g, '').slice(0, 40);
    if (!label) return c.json({ ok: false, error: 'invalid_label' }, 400);
  }
  let expiresAt: number | null = null;
  if (body.expires_at != null) {
    if (typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at)) {
      return c.json({ ok: false, error: 'invalid_expires_at' }, 400);
    }
    const now = Date.now();
    if (body.expires_at <= now || body.expires_at > now + 366 * DAY) {
      return c.json({ ok: false, error: 'invalid_expires_at' }, 400);
    }
    expiresAt = Math.floor(body.expires_at);
  }

  const limits = limitsFromEnv(c.env);
  const now = Date.now();
  const active = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM api_tokens
      WHERE user_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(user.id, now)
    .first<{ n: number }>();
  if ((active?.n || 0) >= limits.maxActiveTokens) {
    return c.json({ ok: false, error: 'token_limit', limit: limits.maxActiveTokens }, 409);
  }

  const { token, prefix } = randomInboxToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO api_tokens
       (id, user_id, token_hash, prefix, label, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, tokenHash, prefix, label, JSON.stringify(['inbox:write']), now, expiresAt)
    .run();

  return c.json({
    ok: true,
    token,
    token_record: {
      id,
      prefix,
      label,
      scopes: ['inbox:write'],
      created_at: now,
      expires_at: expiresAt,
    },
  }, 201);
});

tokenRoutes.get('/', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const rows = await c.env.DB.prepare(
    `SELECT id, prefix, label, scopes, created_at, last_used_at, expires_at
       FROM api_tokens
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<{
      id: string;
      prefix: string;
      label: string;
      scopes: string;
      created_at: number;
      last_used_at: number | null;
      expires_at: number | null;
    }>();
  const tokens = (rows.results || []).map((row) => ({
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
  }));
  return c.json({ ok: true, tokens });
});

tokenRoutes.delete('/:id', async (c) => {
  const user = await requireSession(c);
  if (user instanceof Response) return user;
  const id = c.req.param('id');
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`)
    .bind(now, id, user.id)
    .run();
  await purgeTokenPending(c.env, user.id, id);
  return c.json({ ok: true });
});

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
