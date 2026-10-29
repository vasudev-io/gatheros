// Token and content hashing. Raw inbox tokens are shown once at
// creation and never written to D1, logs, or responses after that.

export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

export async function sha256HexBytes(bytes: BufferSource): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// gos_in_ + 32 random bytes, base64url. The prefix is how session
// routes tell an inbox token from a session id without a database
// lookup (session ids are UUIDs and never start with gos_in_).
export function randomInboxToken(): { token: string; prefix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const token = `gos_in_${body}`;
  return { token, prefix: token.slice(0, 12) };
}

export function decodeBase64(input: string): { bytes: Uint8Array; claimedMime: string | null } {
  let raw = input.trim();
  let claimedMime: string | null = null;
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(raw);
  if (dataUrl) {
    claimedMime = (dataUrl[1] || '').toLowerCase();
    raw = dataUrl[2] || '';
  }
  raw = raw.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  // 10MB binary is ~14MB of base64. Reject before atob allocates.
  if (raw.length > 14_000_000) {
    const err = new Error('asset_too_large');
    err.name = 'asset_too_large';
    throw err;
  }
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  let bin: string;
  try {
    bin = atob(raw + pad);
  } catch {
    const err = new Error('invalid_image');
    err.name = 'invalid_image';
    throw err;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out, claimedMime };
}
