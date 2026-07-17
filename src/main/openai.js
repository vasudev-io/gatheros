// Thin client for the GatherOS AI proxy. The Worker holds the master
// OpenAI key and gates every call on a valid licensed session, so we
// only need to forward the body shape OpenAI expects (chat / embed)
// plus the bearer session token.
//
// Each public helper signs the request with the current session token
// (read on demand from licensing.js) and unwraps the proxy envelope
// before returning the OpenAI-shaped body the rest of the app expects.

const fs = require('node:fs');
const { API_BASE_URL } = require('../shared/licensing-config');
const { getSessionToken } = require('./licensing');
const aiConfig = require('./ai-config');

// Public so callers can short-circuit feature toggles without making
// a network round-trip when AI isn't usable yet. In BYOK mode that
// means a configured endpoint (+ key where required); in proxy mode it
// means a licensing session token is present.
function hasSession() {
  const cfg = aiConfig.resolveAiConfig();
  if (cfg.mode === 'byok') return aiConfig.byokReady(cfg);
  return !!getSessionToken();
}

// Internal endpoint → OpenAI path map, used only in BYOK mode. The
// proxy accepts the /ai/* shapes directly, so this rewrite is skipped
// for proxy mode.
const OPENAI_PATHS = {
  '/ai/chat': '/chat/completions',
  '/ai/embed': '/embeddings',
  '/ai/image': '/images/generations',
};

// Route an AI call either through the GatherOS proxy (subscription) or
// straight to a user-configured OpenAI-compatible endpoint (BYOK). The
// request + response bodies are already OpenAI-shaped, so BYOK just
// swaps the transport + auth and skips the proxy's {ok:true} envelope —
// the model is the only thing that has to be injected, since the proxy
// pins it server-side but a raw endpoint expects it in the body.
async function postAi(path, body) {
  const cfg = aiConfig.resolveAiConfig();
  if (cfg.mode !== 'byok') return postProxyMode(path, body);

  if (!cfg.baseUrl) {
    const err = new Error('No AI endpoint configured');
    err.code = 'no_config';
    throw err;
  }
  if (cfg.requiresKey && !cfg.apiKey) {
    const err = new Error('No AI API key set');
    err.code = 'no_key';
    throw err;
  }
  const out = { ...body };
  if (path === '/ai/chat') out.model = cfg.visionModel;
  else if (path === '/ai/embed') out.model = cfg.embedModel;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(`${cfg.baseUrl}${OPENAI_PATHS[path] || path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(out),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* keep raw for the error line */ }
  if (!res.ok) {
    // Gemini's OpenAI-compat layer wraps errors in an array; plain
    // OpenAI uses an object. Fall through to the raw body so a
    // quota/deprecation message is never reduced to just "http_429"
    // (that masking hid a dead default model for a week).
    const errObj = Array.isArray(data) ? data[0]?.error : data.error;
    const reason = (errObj && (errObj.message || errObj))
      || (raw && raw.slice(0, 300))
      || `http_${res.status}`;
    const err = new Error(`AI ${res.status}: ${reason}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

async function postProxyMode(path, body) {
  const token = getSessionToken();
  if (!token) {
    const err = new Error('Not signed in');
    err.code = 'unauthenticated';
    throw err;
  }
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const reason = data.error || `http_${res.status}`;
    const err = new Error(`AI proxy ${reason}${data.detail ? `: ${data.detail}` : ''}`);
    err.code = reason;
    throw err;
  }
  return data;
}

// ── Image preprocessing helpers ────────────────────────────────────

async function imageToDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }
  const sharp = require('sharp');
  const resized = await sharp(filePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

// ── Chat / vision helpers ──────────────────────────────────────────

async function chat({ messages, model = 'gpt-4o-mini', responseFormat, maxTokens }) {
  const body = { model, messages };
  if (responseFormat) body.response_format = responseFormat;
  if (maxTokens) body.max_tokens = maxTokens;
  const data = await postAi('/ai/chat', body);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in proxy response');
  return content;
}

async function autoTagImage(filePath) {
  const dataUrl = await imageToDataUrl(filePath);
  const content = await chat({
    messages: [
      {
        role: 'system',
        content:
          'You suggest short, useful tags for visual inspiration. Return JSON only: ' +
          '{"tags": ["tag1", "tag2", ...]}. Provide 3-6 lowercase tags. ' +
          'Use single words or hyphenated phrases. Focus on style, content, ' +
          'mood, or use case. Avoid generic words like "image", "design", "art".',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Tag this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: 120,
  });
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('AI response was not valid JSON'); }
  const raw = Array.isArray(parsed.tags) ? parsed.tags : [];
  return raw
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().toLowerCase().replace(/^#+/, ''))
    .filter(Boolean)
    .slice(0, 6);
}

async function analyzeImage(filePath) {
  const dataUrl = await imageToDataUrl(filePath);
  const content = await chat({
    messages: [
      {
        role: 'system',
        content:
          'You write designer-friendly metadata for visual inspiration. ' +
          'Return JSON: {"title": "...", "description": "...", "text": "..."}. ' +
          'title: 2-6 words, Title Case, capture subject/style/mood. ' +
          'description: ONE sentence packed with concrete searchable nouns ' +
          'and adjectives. Cover (a) every notable object or subject visible ' +
          '(e.g. statue, mountain, person, button, logo, sky, clouds, water, ' +
          'building, chart), (b) the visual style or art movement (e.g. ' +
          'minimalist, brutalist, Renaissance, illustration, photograph, 3D ' +
          'render, vaporwave), (c) the dominant colors, (d) the mood, and ' +
          '(e) the likely use case ("landing page", "poster", "UI screenshot"). ' +
          'Prefer concrete nouns over abstract framing. No quotes, no emoji. ' +
          'text: every word that appears IN the image — UI labels, headlines, ' +
          'body copy, button text, signage, captions. Include every URL, link, ' +
          'domain, and email address verbatim (e.g. https://..., example.com, ' +
          'name@site.com). Preserve original wording and capitalization. ' +
          'Separate distinct lines with " | ". Empty string if no text is visible.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: 800,
  });
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('AI response was not valid JSON'); }

  const title = typeof parsed.title === 'string'
    ? parsed.title.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 80)
    : '';
  const description = typeof parsed.description === 'string'
    ? parsed.description.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 600)
    : '';
  const text = typeof parsed.text === 'string'
    ? parsed.text.trim().slice(0, 4000)
    : '';
  return {
    title: title || null,
    description: description || null,
    text: text || null,
  };
}

async function generateImagePrompt(filePath) {
  const dataUrl = await imageToDataUrl(filePath);
  const content = await chat({
    messages: [
      {
        role: 'system',
        content:
          'You write image-generation prompts that recreate the visual ' +
          'style and content of a reference image. The prompts are used ' +
          'with Midjourney, DALL-E, Stable Diffusion, and similar tools.\n\n' +
          'Return JSON: {"prompt": "..."}.\n\n' +
          'The prompt must:\n' +
          '- Be a single paragraph, 35-75 words\n' +
          '- Describe subjects, composition, camera framing, lighting, ' +
          'color palette, texture, style/medium, and mood\n' +
          '- Use flowing natural language, not comma-stuffed keyword lists\n' +
          '- Not include tool-specific parameter syntax (--ar, --v, /imagine)\n' +
          '- Not name copyrighted characters, real people, or real brands\n' +
          '- Not start with "An image of" or "A picture of" — describe directly',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Write a prompt that recreates this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: 280,
  });
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('AI response was not valid JSON'); }
  const prompt = typeof parsed.prompt === 'string'
    ? parsed.prompt.trim().replace(/^["'`]+|["'`]+$/g, '')
    : '';
  return prompt || null;
}

// ── Embedding ──────────────────────────────────────────────────────

async function embedText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('Cannot embed empty text');
  const data = await postAi('/ai/embed', {
    input: trimmed.slice(0, 8000),
  });
  const vec = data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('No embedding in proxy response');
  return vec;
}

// ── Usage / quota ──────────────────────────────────────────────────

async function getUsage() {
  // BYOK has no proxy-side quota meter — the user's own provider bills
  // them directly. Return null so the UI simply hides the usage meter.
  if (aiConfig.resolveAiConfig().mode === 'byok') return null;
  const token = getSessionToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/ai/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return null;
    return data;
  } catch (err) {
    console.error('[ai] getUsage failed:', err);
    return null;
  }
}

// Resize a save's image to a server-friendly size and return raw
// base64 (no data-url prefix). Used to seed image-edit calls so
// the variant model sees the actual source pixels rather than just
// a text description. Capped at 1024×1024 since that's the output
// resolution anyway — anything larger is wasted bandwidth.
async function imageToBase64(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }
  const sharp = require('sharp');
  const buf = await sharp(filePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return buf.toString('base64');
}

// Generate an image. If `sourceFilePath` is provided, the worker
// routes to /v1/images/edits with the source as a reference — the
// result is a true variation that preserves composition, palette,
// and subject. Without a source, falls back to text-to-image
// generation (used only by callers that genuinely have no image).
//
// `size` selects the output aspect ratio — the worker validates it
// against gpt-image-1's supported set ('1024x1024', '1536x1024',
// '1024x1536'); model + quality stay locked server-side so the
// per-image cost curve is predictable.
async function generateImage(prompt, { sourceFilePath, size } = {}) {
  const trimmed = (prompt || '').trim();
  if (!trimmed) throw new Error('Cannot generate from empty prompt');
  const body = { prompt: trimmed.slice(0, 4000) };
  if (sourceFilePath) {
    body.image_b64 = await imageToBase64(sourceFilePath);
    body.image_mime = 'image/jpeg';
  }
  if (size) body.size = size;
  const data = await postAi('/ai/image', body);
  // ponytail: image-gen was built around the proxy envelope
  // ({image:{b64_json}}); raw OpenAI-compatible endpoints return
  // {data:[{b64_json}]}. Read both so BYOK generation works where the
  // endpoint supports it — provider-specific image models aren't wired.
  const b64 = data.image?.b64_json || data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image in AI response');
  return {
    bytes: Buffer.from(b64, 'base64'),
    quota: data.quota || null,
  };
}

module.exports = {
  hasSession,
  autoTagImage,
  analyzeImage,
  generateImagePrompt,
  embedText,
  getUsage,
};
