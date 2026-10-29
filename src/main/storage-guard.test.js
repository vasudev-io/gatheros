const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-storage-'));
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === 'electron') {
    return {
      app: {
        getPath: () => userData,
        getName: () => 'GatherOS',
        isReady: () => true,
        on() {},
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

const { saveImageFromBuffer, saveImageFromUrl } = require('./storage');

test.after(() => {
  Module.prototype.require = originalRequire;
});

test('saveImageFromBuffer rejects a non-image', async () => {
  await assert.rejects(
    () => saveImageFromBuffer(Buffer.from('this is not an image'), 'png'),
    /not an image/i,
  );
});

test('saveImageFromUrl enforces a size cap before writing', async () => {
  const previous = global.fetch;
  global.fetch = async () => new Response(Buffer.alloc(64), {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': '64' },
  });
  try {
    await assert.rejects(
      () => saveImageFromUrl('https://cdn.example.com/big.png', { maxBytes: 16 }),
      /size cap/i,
    );
  } finally {
    global.fetch = previous;
  }
});
