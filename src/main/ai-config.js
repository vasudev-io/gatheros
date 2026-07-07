// Bring-your-own-AI config.
//
// The app speaks the OpenAI wire format, so any OpenAI-compatible
// endpoint — Gemini's compatibility layer, a local Ollama, OpenRouter,
// etc. — can serve the vision + embedding calls directly, with no
// GatherOS proxy and no license entitlement. Provider presets fill in
// the base URL + default models; the user only pastes a key (or
// nothing at all, for a local Ollama).
//
// The API key is a secret, so it's encrypted at rest with safeStorage
// exactly like the licensing session token — never written to the
// plain-JSON prefs file and never handed back to the renderer.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { getPref } = require('./settings');

const KEY_FILE = 'ai-provider-key.bin';

// Per-provider defaults. baseUrl carries no trailing slash — the
// OpenAI path is appended verbatim. Verified July 2026: Gemini exposes
// an OpenAI-compatible layer that accepts image_url base64 for vision
// and an /embeddings route, so the existing request bodies drop in
// unchanged.
const PRESETS = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    visionModel: 'gemini-2.0-flash',
    embedModel: 'gemini-embedding-001',
    requiresKey: true,
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    visionModel: 'qwen2.5vl',       // vision-capable; strong local OCR
    embedModel: 'nomic-embed-text',
    requiresKey: false,             // local, keyless
  },
  custom: {
    baseUrl: '',                    // user must supply
    visionModel: 'gpt-4o-mini',
    embedModel: 'text-embedding-3-small',
    requiresKey: true,
  },
};

function keyPath() {
  return path.join(app.getPath('userData'), KEY_FILE);
}

function getAiKey() {
  try {
    if (!fs.existsSync(keyPath())) return '';
    const buf = fs.readFileSync(keyPath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    // safeStorage unavailable: we wrote plaintext last time too.
    return buf.toString('utf8');
  } catch (err) {
    console.error('[ai-config] failed to read key:', err.message);
    return '';
  }
}

function setAiKey(key) {
  try {
    if (!key) {
      fs.rmSync(keyPath(), { force: true });
      return { ok: true };
    }
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, 'utf8');
    fs.writeFileSync(keyPath(), data, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function hasAiKey() {
  try {
    return fs.existsSync(keyPath()) && fs.statSync(keyPath()).size > 0;
  } catch {
    return false;
  }
}

// Pure merge of a provider + user overrides + key into a concrete
// config. Kept side-effect-free (no prefs/keychain reads) so it's unit
// testable without Electron. Empty override fields fall back to the
// preset, so switching providers "just works" on defaults while power
// users can override any single field.
function buildConfig(provider, overrides = {}, apiKey = '') {
  if (!provider || provider === 'proxy') return { mode: 'proxy', provider: 'proxy' };
  const preset = PRESETS[provider] || PRESETS.custom;
  const baseUrl = (overrides.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  return {
    mode: 'byok',
    provider,
    baseUrl,
    visionModel: overrides.visionModel || preset.visionModel,
    embedModel: overrides.embedModel || preset.embedModel,
    requiresKey: preset.requiresKey,
    apiKey,
  };
}

function resolveAiConfig() {
  return buildConfig(
    getPref('aiProvider', 'proxy'),
    {
      baseUrl: getPref('aiBaseUrl', ''),
      visionModel: getPref('aiVisionModel', ''),
      embedModel: getPref('aiEmbedModel', ''),
    },
    getAiKey(),
  );
}

// A BYOK config is usable once it has an endpoint and — for providers
// that need one — a key. Ollama runs keyless on localhost.
function byokReady(cfg) {
  if (!cfg || cfg.mode !== 'byok') return false;
  if (!cfg.baseUrl) return false;
  return cfg.requiresKey ? !!cfg.apiKey : true;
}

module.exports = {
  PRESETS,
  buildConfig,
  resolveAiConfig,
  byokReady,
  getAiKey,
  setAiKey,
  hasAiKey,
};
