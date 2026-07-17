// Runnable check for the pure config logic. No Electron needed:
//   node src/main/ai-config.test.js
const assert = require('node:assert');
const { buildConfig, byokReady, PRESETS } = require('./ai-config');

// 'proxy' (and missing provider) stay on the subscription path.
assert.equal(buildConfig('proxy').mode, 'proxy');
assert.equal(buildConfig(undefined).mode, 'proxy');
assert.equal(buildConfig('').mode, 'proxy');

// Gemini preset fills every default and carries the pasted key.
const g = buildConfig('gemini', {}, 'k');
assert.equal(g.mode, 'byok');
assert.equal(g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
assert.equal(g.visionModel, 'gemini-2.5-flash');
assert.equal(g.embedModel, 'gemini-embedding-001');
assert.equal(g.requiresKey, true);
assert.equal(g.apiKey, 'k');

// Overrides win; a trailing slash on the base URL is trimmed; unset
// fields still fall back to the preset.
const c = buildConfig('custom', { baseUrl: 'https://x.ai/v1/', visionModel: 'm' }, 'k');
assert.equal(c.baseUrl, 'https://x.ai/v1');
assert.equal(c.visionModel, 'm');
assert.equal(c.embedModel, PRESETS.custom.embedModel);

// Readiness: needs an endpoint, plus a key only when the provider does.
assert.equal(byokReady(buildConfig('gemini', {}, '')), false); // key required, missing
assert.equal(byokReady(buildConfig('gemini', {}, 'k')), true);
assert.equal(byokReady(buildConfig('ollama', {}, '')), true);  // keyless is fine
assert.equal(byokReady(buildConfig('custom', { baseUrl: '' }, 'k')), false); // no endpoint
assert.equal(byokReady({ mode: 'proxy' }), false);

console.log('ai-config: all assertions passed');
