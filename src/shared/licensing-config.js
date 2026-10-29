// Single source of truth for licensing config. Both main and
// renderer import this — keep it CommonJS so it works in either.
//
// All values default to dev / test mode. Override at build time via
// env vars for staging and production builds.

const env = (typeof process !== 'undefined' && process.env) || {};

// Where the licensing + AI Worker lives. Defaults to the
// production deploy in both dev and packaged builds — most
// contributors aren't running `wrangler dev` locally, and the
// production endpoints are session-token gated anyway. Set
// GATHEROS_API_BASE_URL=http://localhost:8787 when running dev
// against a local Worker.
const { resolveApiBaseUrl } = require('./api-base');

// Env-only default. Callers that should also honor Settings → API
// server use readConfiguredApiBaseUrl() so a change applies without
// a restart. This constant stays for anything that only needs the
// build-time value.
const API_BASE_URL = resolveApiBaseUrl({ pref: '', env });

// Custom URL scheme registered by the desktop app — magic-link
// emails redirect into `gatheros://auth/verify?token=…` and the
// main process catches it via app.on('open-url') (macOS) or via
// the second-instance argv (Windows / Linux).
const URL_SCHEME = 'gatheros';

// How stale the cached /license/verify response can get before we
// stop trusting it. Within this window an offline launch is fine;
// past it we force a fresh verify and paywall on failure.
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How often the renderer re-verifies in the background while the
// app is open. 6 hours keeps subscription-status drift small without
// hammering the API.
const REVERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// How often the desktop pulls the inbox while the feature is on.
// GATHEROS_INBOX_POLL_MS overrides it (minimum 5s) for local testing.
const parsedPoll = Number(env.GATHEROS_INBOX_POLL_MS);
const INBOX_POLL_MS = Number.isFinite(parsedPoll) && parsedPoll >= 5000
  ? parsedPoll
  : 15 * 60 * 1000;

module.exports = {
  API_BASE_URL,
  URL_SCHEME,
  OFFLINE_GRACE_MS,
  REVERIFY_INTERVAL_MS,
  INBOX_POLL_MS,
};
