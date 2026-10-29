const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveApiBaseUrl, normalizeApiBaseUrl } = require('./api-base');

test('api base defaults to the existing production service', () => {
  assert.equal(resolveApiBaseUrl({ pref: '', env: {} }), 'https://api.gatheros.co');
});

test('env overrides the default and a saved preference wins over env', () => {
  const env = { GATHEROS_API_BASE_URL: 'http://127.0.0.1:8787' };
  assert.equal(resolveApiBaseUrl({ pref: '', env }), 'http://127.0.0.1:8787');
  assert.equal(
    resolveApiBaseUrl({ pref: 'https://gatheros-api.example.workers.dev/docs', env }),
    'https://gatheros-api.example.workers.dev',
  );
});

test('invalid preferences fall through instead of breaking auth', () => {
  assert.equal(normalizeApiBaseUrl('javascript:alert(1)'), null);
  assert.equal(normalizeApiBaseUrl('https://user:pass@example.com'), null);
  assert.equal(
    resolveApiBaseUrl({ pref: 'not a url', env: { GATHEROS_API_BASE_URL: 'https://api.example.com' } }),
    'https://api.example.com',
  );
});
