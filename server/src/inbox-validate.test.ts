import test from 'node:test';
import assert from 'node:assert/strict';
import { InboxError, assertPublicHttpsUrl, assertPublicPageUrl, detectImageMime, fetchRemoteImage } from './inbox-validate.ts';

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));

test('detects a png and rejects text', () => {
  assert.equal(detectImageMime(PNG), 'image/png');
  assert.equal(detectImageMime(new TextEncoder().encode('<svg></svg>')), null);
});

test('https image urls must be public', () => {
  assert.equal(assertPublicHttpsUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
  assert.throws(() => assertPublicHttpsUrl('http://cdn.example.com/a.png'), (err: unknown) => err instanceof InboxError && err.code === 'image_url_not_https');
  for (const blocked of [
    'https://127.0.0.1/a.png',
    'https://10.1.2.3/a.png',
    'https://192.168.1.9/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/a.png',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@cdn.example.com/a.png',
  ]) {
    assert.throws(() => assertPublicHttpsUrl(blocked), (err: unknown) => err instanceof InboxError, blocked);
  }
});

test('page urls may be http but not link-local', () => {
  assert.equal(assertPublicPageUrl('http://mobbin.com/screens/1').protocol, 'http:');
  assert.throws(() => assertPublicPageUrl('http://127.0.0.1:3000/'), (err: unknown) => err instanceof InboxError && err.code === 'source_url_blocked');
});

test('image fetch follows a public redirect and refuses a private hop', async () => {
  const ok = await fetchRemoteImage('https://cdn.example.com/a.png', 1024, async (input) => {
    const url = String(input);
    if (url.endsWith('/a.png')) {
      return new Response(null, { status: 302, headers: { location: 'https://images.example.com/b.png' } });
    }
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  assert.equal(ok.mime, 'image/png');

  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example.com/a.png', 1024, async () =>
      new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/x' } })),
    (err: unknown) => err instanceof InboxError && err.code === 'image_url_blocked',
  );

  await assert.rejects(
    () => fetchRemoteImage('https://cdn.example.com/a.png', 8, async () =>
      new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999' } })),
    (err: unknown) => err instanceof InboxError && err.code === 'asset_too_large',
  );
});
