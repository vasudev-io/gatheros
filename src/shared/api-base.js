// Where the desktop app sends auth, licensing, AI, and inbox calls.
//
// Order: a Settings value, then GATHEROS_API_BASE_URL, then the
// long-standing production default. The default stays so an unset
// install keeps talking to the existing service. Point Settings →
// Inbox → API server at your own Worker when you deploy one.
//
// Only the origin is kept. A pasted path or query is dropped so a
// docs URL can't get baked into every request.

const DEFAULT_API_BASE_URL = 'https://api.gatheros.co';

function normalizeApiBaseUrl(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function resolveApiBaseUrl({ pref, env } = {}) {
  const fromPref = normalizeApiBaseUrl(pref);
  if (fromPref) return fromPref;
  const fromEnv = normalizeApiBaseUrl(env && env.GATHEROS_API_BASE_URL);
  if (fromEnv) return fromEnv;
  return DEFAULT_API_BASE_URL;
}

function readConfiguredApiBaseUrl() {
  let pref = '';
  try {
    pref = require('../main/settings').getPref('apiBaseUrl', '') || '';
  } catch {
    pref = '';
  }
  const env = (typeof process !== 'undefined' && process.env) || {};
  return resolveApiBaseUrl({ pref, env });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  resolveApiBaseUrl,
  readConfiguredApiBaseUrl,
};
