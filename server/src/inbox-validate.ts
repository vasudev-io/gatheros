// Pure checks for inbox payloads, image bytes, and remote image URLs.
// No D1 or R2 here so the rules can be tested without a Worker.

export class InboxError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, extra?: Record<string, unknown>) {
    super(code);
    this.name = 'InboxError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const SOURCE_NAMES = ['mobbin', 'cosmos', 'x', 'dribbble', 'web', 'other'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export const DEFAULT_LIMITS = {
  maxAssetBytes: 10 * 1024 * 1024,
  dailyItemLimit: 50,
  dailyUserLimit: 200,
  pendingBytesCap: 250 * 1024 * 1024,
  maxActiveTokens: 5,
  deliveredRetentionMs: 7 * 24 * 60 * 60 * 1000,
  pendingRetentionMs: 30 * 24 * 60 * 60 * 1000,
  noteMax: 1000,
};

export type InboxLimits = typeof DEFAULT_LIMITS;

export function limitsFromEnv(env: {
  INBOX_MAX_ASSET_BYTES?: string;
  INBOX_DAILY_ITEM_LIMIT?: string;
  INBOX_DAILY_USER_LIMIT?: string;
  INBOX_PENDING_BYTES_CAP?: string;
  INBOX_MAX_ACTIVE_TOKENS?: string;
  INBOX_DELIVERED_RETENTION_MS?: string;
  INBOX_PENDING_RETENTION_MS?: string;
  INBOX_NOTE_MAX?: string;
}): InboxLimits {
  return {
    maxAssetBytes: positiveInt(env.INBOX_MAX_ASSET_BYTES, DEFAULT_LIMITS.maxAssetBytes),
    dailyItemLimit: positiveInt(env.INBOX_DAILY_ITEM_LIMIT, DEFAULT_LIMITS.dailyItemLimit),
    dailyUserLimit: positiveInt(env.INBOX_DAILY_USER_LIMIT, DEFAULT_LIMITS.dailyUserLimit),
    pendingBytesCap: positiveInt(env.INBOX_PENDING_BYTES_CAP, DEFAULT_LIMITS.pendingBytesCap),
    maxActiveTokens: positiveInt(env.INBOX_MAX_ACTIVE_TOKENS, DEFAULT_LIMITS.maxActiveTokens),
    deliveredRetentionMs: positiveInt(env.INBOX_DELIVERED_RETENTION_MS, DEFAULT_LIMITS.deliveredRetentionMs),
    pendingRetentionMs: positiveInt(env.INBOX_PENDING_RETENTION_MS, DEFAULT_LIMITS.pendingRetentionMs),
    noteMax: positiveInt(env.INBOX_NOTE_MAX, DEFAULT_LIMITS.noteMax),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function cleanLine(input: unknown, max: number, code: string): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') throw new InboxError(400, code);
  const s = input.replace(/\u0000/g, '').replace(/[\r\n]+/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) throw new InboxError(400, 'too_long', { field: code });
  return s;
}

export function cleanNote(input: unknown, max: number): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') throw new InboxError(400, 'invalid_note');
  const s = input.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (!s) return null;
  if (s.length > max) throw new InboxError(400, 'note_too_long', { max });
  return s;
}

export function cleanTags(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new InboxError(400, 'invalid_tags');
  if (input.length > 10) throw new InboxError(400, 'too_many_tags');
  const out: string[] = [];
  for (const t of input) {
    if (typeof t !== 'string') throw new InboxError(400, 'invalid_tags');
    const s = t.trim().toLowerCase().replace(/^#+/, '').replace(/[\u0000\r\n]/g, '');
    if (!s) continue;
    if (s.length > 40) throw new InboxError(400, 'tag_too_long');
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function cleanHttpUrl(input: unknown, code: string): string | null {
  if (input == null || input === '') return null;
  if (typeof input !== 'string') throw new InboxError(400, code);
  const s = input.trim();
  if (s.length > 2000) throw new InboxError(400, 'too_long', { field: code });
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new InboxError(400, code);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InboxError(400, code);
  if (url.username || url.password) throw new InboxError(400, code);
  return url.toString();
}

export function cleanSourceName(input: unknown): SourceName {
  if (input == null || input === '') return 'other';
  if (typeof input !== 'string') throw new InboxError(400, 'invalid_source_name');
  const s = input.trim().toLowerCase();
  if (!(SOURCE_NAMES as readonly string[]).includes(s)) {
    throw new InboxError(400, 'invalid_source_name');
  }
  return s as SourceName;
}

export function cleanCollectionId(input: unknown): string | null {
  if (input == null || input === '') return null;
  if (typeof input !== 'string') throw new InboxError(400, 'invalid_collection');
  const s = input.trim();
  if (!ID_RE.test(s)) throw new InboxError(400, 'invalid_collection');
  return s;
}

export function cleanCollectionKind(input: unknown): 'collection' | 'board' | null {
  if (input == null || input === '') return null;
  if (input === 'collection' || input === 'board') return input;
  throw new InboxError(400, 'invalid_collection_kind');
}

// Remote fetches refuse loopback, link-local, private, and metadata
// hosts. Hostnames are checked literally; IP literals are checked
// against the private ranges. Redirects are followed by the caller,
// which re-runs this on every hop.
//
// Image bytes are https-only. A page URL the desktop will screenshot
// may be http, but it still has to be a public host so a token can't
// point the app at a link-local address.
export function assertPublicHttpsUrl(raw: string): URL {
  return assertPublicUrl(raw, { httpsOnly: true, invalid: 'invalid_image_url', blocked: 'image_url_blocked', notHttps: 'image_url_not_https' });
}

export function assertPublicPageUrl(raw: string): URL {
  return assertPublicUrl(raw, { httpsOnly: false, invalid: 'invalid_source_url', blocked: 'source_url_blocked', notHttps: 'invalid_source_url' });
}

function assertPublicUrl(
  raw: string,
  codes: { httpsOnly: boolean; invalid: string; blocked: string; notHttps: string },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InboxError(400, codes.invalid);
  }
  if (codes.httpsOnly) {
    if (url.protocol !== 'https:') throw new InboxError(400, codes.notHttps);
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InboxError(400, codes.invalid);
  }
  if (url.username || url.password) throw new InboxError(400, codes.invalid);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new InboxError(400, codes.blocked);
  }
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.internal' ||
    host.endsWith('.internal')
  ) {
    throw new InboxError(400, codes.blocked);
  }
  if (isBlockedIp(host)) throw new InboxError(400, codes.blocked);
  return url;
}

function isBlockedIp(host: string): boolean {
  if (host.includes(':')) {
    const v6 = host.split('%')[0] || '';
    if (v6 === '::1' || v6 === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v6);
    if (mapped && mapped[1] && isBlockedIpv4(mapped[1])) return true;
    if (/^f[cd]/i.test(v6) || /^fe[89ab]/i.test(v6)) return true;
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIpv4(host);
  return false;
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

// SVG is rejected on purpose: it can carry script, and the desktop
// decodes through sharp which we don't want to feed active content.
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  // ISO BMFF (avif): bytes 4..7 are 'ftyp', brand follows.
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8] || 0, bytes[9] || 0, bytes[10] || 0, bytes[11] || 0);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

export function extForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/avif': return 'avif';
    case 'image/bmp': return 'bmp';
    default: return 'img';
  }
}

export function inboxAssetKey(userId: string, itemId: string): string {
  if (!isUuid(userId) || !isUuid(itemId)) throw new InboxError(400, 'invalid_id');
  return `users/${userId}/inbox/${itemId}/original`;
}

export function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`users/${userId}/inbox/`) && !key.includes('..');
}

const MAX_REDIRECTS = 3;

export type FetchedImage = { bytes: Uint8Array; mime: string };

// fetchImpl is injectable so tests don't need the network. Every
// redirect hop is re-checked with assertPublicHttpsUrl.
export async function fetchRemoteImage(
  rawUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedImage> {
  let current = assertPublicHttpsUrl(rawUrl).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new InboxError(422, 'image_fetch_failed');
      const next = new URL(loc, current).toString();
      current = assertPublicHttpsUrl(next).toString();
      continue;
    }
    if (!res.ok) throw new InboxError(422, 'image_fetch_failed');
    const claimed = (res.headers.get('content-type') || '').split(';')[0]?.trim().toLowerCase() || '';
    if (claimed.startsWith('image/svg')) throw new InboxError(415, 'unsupported_media');
    const len = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(len) && len > maxBytes) throw new InboxError(413, 'asset_too_large');
    const bytes = await readLimited(res, maxBytes);
    const mime = detectImageMime(bytes);
    if (!mime) throw new InboxError(415, 'unsupported_media');
    if (claimed && !claimed.startsWith('image/')) throw new InboxError(415, 'unsupported_media');
    return { bytes, mime };
  }
  throw new InboxError(422, 'image_fetch_failed');
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) throw new InboxError(422, 'image_fetch_failed');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new InboxError(413, 'asset_too_large');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released after cancel */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
