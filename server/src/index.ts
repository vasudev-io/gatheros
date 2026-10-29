// GatherOS API — Cloudflare Worker entry.
//
//   /auth/*         magic-link request, browser bridge, token exchange, signout
//   /license/*      /verify endpoint the desktop app polls on launch
//   /webhooks/*     Lemon Squeezy subscription events
//   /ai/*           OpenAI proxy
//   /v1/tokens      session-scoped inbox tokens (hashed at rest)
//   /v1/inbox       account-scoped inbox queue
//   /mcp            streamable-HTTP MCP, bearer = inbox token

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authRoutes, bearer } from './auth';
import { licenseRoutes } from './license';
import { webhookRoutes } from './lemonsqueezy';
import { aiRoutes } from './ai';
import { announcementRoutes } from './announcement';
import { downloadHandler } from './download';
import { inboxRoutes, runInboxMaintenance } from './inbox';
import { tokenRoutes } from './tokens';
import { mcpHandler } from './mcp';

const app = new Hono<{ Bindings: Env }>();

// The desktop app calls the existing auth, license, and AI routes from
// Electron, which presents a file:// or app:// origin. Those stay
// wide-open. Inbox and MCP are not browser APIs: no CORS headers, and
// an inbox token is refused everywhere except the write routes.
const openCors = cors({ origin: '*' });
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/mcp' || path.startsWith('/v1/')) return next();
  return openCors(c, next);
});

app.use('*', async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  if (!token || !token.startsWith('gos_in_')) return next();
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const allowed =
    (method === 'POST' && path === '/mcp') ||
    (method === 'POST' && path === '/v1/inbox/items') ||
    (method === 'PUT' && /^\/v1\/inbox\/items\/[^/]+\/asset$/.test(path));
  if (!allowed) return c.json({ ok: false, error: 'inbox_token_not_allowed' }, 403);
  return next();
});

app.get('/', (c) =>
  c.json({
    ok: true,
    name: c.env.APP_NAME,
    mcp: '/mcp',
    docs: 'server/README.md',
  }),
);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/auth', authRoutes);
app.route('/license', licenseRoutes);
app.route('/webhooks', webhookRoutes);
app.route('/ai', aiRoutes);
app.route('/announcement', announcementRoutes);
app.route('/v1/tokens', tokenRoutes);
app.route('/v1/inbox', inboxRoutes);
app.all('/mcp', mcpHandler);
// Marketing-site download button → 302 to the latest macOS .dmg.
// Direct route (not a mounted sub-app) so the bare /download path matches.
app.get('/download', downloadHandler);

// 404 fallback — keep it tight, no body leak.
app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error('[unhandled]', err);
  return c.json({ ok: false, error: 'server_error' }, 500);
});

export { app, runInboxMaintenance };

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runInboxMaintenance(env));
  },
};
