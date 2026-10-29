// Remote MCP endpoint (streamable HTTP, stateless).
//
// POST /mcp   JSON-RPC. Bearer must be an inbox token (inbox:write).
// GET  /mcp   405 — this server does not push messages.
// DELETE /mcp 405 — no session to terminate.
//
// Tools:
//   add_item                  queue an image (url or base64) or a page URL
//   list_collections          names the desktop has published, not saves
//   list_recent_inbox_items   inbox metadata this account queued, not the library
//
// A session token is rejected. The token cannot call the read routes
// that stream bytes or page the queue; those stay on the session.

import type { Context } from 'hono';
import type { Env } from './types';
import { requireInboxWrite, type ApiTokenAuth } from './auth';
import { createInboxItem, listCatalog, listRecentForToken } from './inbox';
import { InboxError, SOURCE_NAMES } from './inbox-validate';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const SERVER_NAME = 'gatheros-inbox';
const SERVER_VERSION = '1.0.0';
const MAX_BODY = 15 * 1024 * 1024;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

const TOOLS = [
  {
    name: 'add_item',
    description:
      'Add an inspiration item to the user\'s GatherOS inbox. The desktop app imports it into their library (thumbnail, palette, and AI indexing when that is on). Provide image_base64 or image_url, or only a source_url to save the page. collection_id comes from list_collections; omit it to use their default Inbox collection.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, up to 300 characters.' },
        note: { type: 'string', description: 'Why this is good, up to 1000 characters.' },
        source_url: { type: 'string', description: 'Page this came from.' },
        source_name: { type: 'string', enum: [...SOURCE_NAMES] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        image_url: { type: 'string', description: 'Public https URL of the image.' },
        image_base64: { type: 'string', description: 'Base64 image bytes, or a data:image/...;base64 URL.' },
        collection_id: { type: 'string', description: 'Target collection or board id from list_collections.' },
        collection_kind: { type: 'string', enum: ['collection', 'board'] },
        id: { type: 'string', description: 'Optional UUID. Repeating it is idempotent.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_collections',
    description:
      'List collection and board names the GatherOS app has published for this account. Returns ids and names only, never the saves inside them. Call this before add_item when you want to file into a specific collection or board.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'list_recent_inbox_items',
    description:
      'List recent items queued in the inbox (title, note, status, source). Does not return image bytes and does not read the user\'s library.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

export async function mcpHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'DELETE') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        Allow: 'POST',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), { status: 405 });
  }

  const originBlock = rejectBadOrigin(c);
  if (originBlock) return originBlock;

  const accept = c.req.header('accept') || '';
  if (accept && !accept.includes('application/json') && !accept.includes('text/event-stream')) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'not_acceptable' } }, 406);
  }
  const wantSse = accept.includes('text/event-stream') && !accept.includes('application/json');

  const auth = await requireInboxWrite(c);
  if (auth instanceof Response) {
    const status = auth.status;
    const www: Record<string, string> = {};
    if (status === 401) {
      www['WWW-Authenticate'] = 'Bearer realm="gatheros-inbox", error="invalid_token"';
    }
    return json(
      { jsonrpc: '2.0', id: null, error: { code: status === 403 ? -32002 : -32001, message: status === 403 ? 'forbidden' : 'unauthenticated' } },
      status,
      www,
    );
  }

  let raw = '';
  try {
    raw = await c.req.text();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (raw.length > MAX_BODY) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'payload_too_large' } }, 413);
  }
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
  }
  if (!message.method) {
    return new Response(null, { status: 202 });
  }
  const id = message.id === undefined ? null : message.id;
  const isNotification = message.id === undefined;

  try {
    const result = await dispatch(c.env, auth, message.method, message.params);
    if (isNotification || result === undefined) return new Response(null, { status: 202 });
    const body = { jsonrpc: '2.0', id, result };
    return wantSse ? sse(body) : json(body, 200, protocolHeader(c));
  } catch (err) {
    if (err instanceof InboxError) {
      const tool = toolError(err.code);
      if (isNotification) return new Response(null, { status: 202 });
      const body = { jsonrpc: '2.0', id, result: tool };
      return wantSse ? sse(body) : json(body, 200, protocolHeader(c));
    }
    if (err instanceof RpcError) {
      return json({ jsonrpc: '2.0', id, error: { code: err.code, message: err.message } }, err.http);
    }
    console.error('[mcp]', err instanceof Error ? err.name : 'error');
    return json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } }, 500);
  }
}

class RpcError extends Error {
  code: number;
  http: number;
  constructor(code: number, message: string, http = 200) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

async function dispatch(
  env: Env,
  auth: ApiTokenAuth,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method === 'initialize') {
    const requested = params && typeof params === 'object' && 'protocolVersion' in params
      ? String((params as { protocolVersion?: unknown }).protocolVersion || '')
      : '';
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : (PROTOCOL_VERSIONS[0] || '2025-06-18');
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Call list_collections to choose a collection or board, then add_item. This token can queue inbox items and read that queue\'s metadata. It cannot read the library.',
    };
  }
  if (method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') return callTool(env, auth, params);
  throw new RpcError(-32601, 'Method not found');
}

async function callTool(
  env: Env,
  auth: ApiTokenAuth,
  params: unknown,
): Promise<unknown> {
  if (!params || typeof params !== 'object') throw new RpcError(-32602, 'Invalid params');
  const name = (params as { name?: unknown }).name;
  const argsRaw = (params as { arguments?: unknown }).arguments;
  const args = argsRaw == null ? {} : argsRaw;
  if (typeof name !== 'string') throw new RpcError(-32602, 'Invalid params');
  if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'Invalid params');
  if (name === 'list_collections') {
    const collections = await listCatalog(env, auth.user.id);
    return toolOk({ collections });
  }
  if (name === 'list_recent_inbox_items') {
    const limitRaw = (args as { limit?: unknown }).limit;
    const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(20, Math.floor(limitRaw)))
      : 20;
    const items = await listRecentForToken(env, auth.user.id, limit);
    return toolOk({ items });
  }
  if (name === 'add_item') {
    try {
      const result = await createInboxItem(env, auth, args as Record<string, unknown>);
      return toolOk(result);
    } catch (err) {
      if (err instanceof InboxError) return toolError(err.code, err.extra);
      throw err;
    }
  }
  throw new RpcError(-32602, 'Unknown tool');
}

function toolOk(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

function toolError(code: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: code, ...(extra || {}) }) }],
    isError: true,
  };
}

function rejectBadOrigin(c: Context<{ Bindings: Env }>): Response | null {
  const origin = c.req.header('origin');
  if (!origin) return null;
  let host = '';
  try {
    const url = new URL(origin);
    host = url.host.toLowerCase();
    if (host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:')) {
      return null;
    }
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'bad_origin' } }, 403);
  }
  const allowed = (c.env.MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return null;
  return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'bad_origin' } }, 403);
}

function protocolHeader(c: Context<{ Bindings: Env }>): Record<string, string> {
  const requested = c.req.header('mcp-protocol-version') || '';
  const version = PROTOCOL_VERSIONS.includes(requested) ? requested : (PROTOCOL_VERSIONS[0] || '2025-06-18');
  return { 'MCP-Protocol-Version': version };
}

function json(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extra || {}),
    },
  });
}

function sse(body: unknown): Response {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
    },
  });
}
