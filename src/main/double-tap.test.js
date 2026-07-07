// Run: node src/main/double-tap.test.js
const assert = require('node:assert');
const { UiohookKey } = require('uiohook-napi');
const { _test } = require('./double-tap');

const CMD = { keycode: UiohookKey.Meta };
const OTHER = { keycode: 999 }; // any non-⌘ key

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = (key) => { _test.keydown(key); _test.keyup(key); };

async function main() {
  // 1. Two clean ⌘ taps close together → fires once.
  let fired = 0;
  _test.reset();
  _test.setTrigger(() => { fired += 1; });
  tap(CMD);
  await sleep(100);
  tap(CMD);
  assert.strictEqual(fired, 1, 'clean ⌘⌘ should fire once');

  // 2. Taps too far apart → no fire.
  fired = 0;
  _test.reset();
  _test.setTrigger(() => { fired += 1; });
  tap(CMD);
  await sleep(600); // > GAP_MS
  tap(CMD);
  assert.strictEqual(fired, 0, 'slow ⌘…⌘ should not fire');

  // 3. ⌘+other between taps (a real shortcut) → no fire.
  fired = 0;
  _test.reset();
  _test.setTrigger(() => { fired += 1; });
  _test.keydown(CMD); _test.keydown(OTHER); _test.keyup(OTHER); _test.keyup(CMD); // ⌘C
  await sleep(50);
  tap(CMD);
  assert.strictEqual(fired, 0, 'shortcut then ⌘ should not fire');

  // 4. Triple-tap within cooldown → fires only once.
  fired = 0;
  _test.reset();
  _test.setTrigger(() => { fired += 1; });
  tap(CMD); await sleep(80); tap(CMD); await sleep(80); tap(CMD);
  assert.strictEqual(fired, 1, 'triple-tap should fire once (cooldown)');

  console.log('ok — double-tap logic');
}

main();
