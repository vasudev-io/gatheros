// Global "⌘⌘" trigger: double-tap either Command key to fire an area
// capture. Electron's globalShortcut can't register a bare modifier,
// so we run a system-wide key hook (uiohook-napi) and detect the
// double-tap ourselves.
//
// A "clean tap" = Command pressed and released with NO other key held
// during the press and held only briefly (a tap, not a shortcut hold).
// Two clean taps whose releases fall within GAP_MS = trigger.
//
// ponytail: either-Cmd as the user asked. Cmd is a heavily-used
// modifier, so back-to-back bare Cmd presses will occasionally
// false-fire — the clean-tap + no-other-key + cooldown guards keep it
// rare. Upgrade path: scope to right-Cmd only (keycode 0x0E5C) if the
// false positives annoy.
const { uIOhook, UiohookKey } = require('uiohook-napi');

const CMD_KEYS = new Set([UiohookKey.Meta, UiohookKey.MetaRight]); // left + right ⌘
const TAP_MAX_MS = 400; // longer than this held = a hold, not a tap
const GAP_MS = 400; // max time between the two taps
const COOLDOWN_MS = 1000; // ignore further fires just after one triggers

let started = false;
let onTrigger = null;

let cmdDownAt = 0; // when the current ⌘ press started (0 = up)
let sawOtherKey = false; // any non-⌘ key active during this press
let lastTapAt = 0; // release time of the last clean ⌘ tap
let cooldownUntil = 0;

function isCmd(keycode) {
  return CMD_KEYS.has(keycode);
}

function handleKeydown(e) {
  if (isCmd(e.keycode)) {
    if (cmdDownAt === 0) {
      cmdDownAt = Date.now();
      sawOtherKey = false;
    }
    return; // repeats while held are ignored
  }
  // Any non-⌘ key breaks both the current tap and the double-tap chain.
  sawOtherKey = true;
  lastTapAt = 0;
}

function handleKeyup(e) {
  if (!isCmd(e.keycode)) return;
  const wasDownAt = cmdDownAt;
  cmdDownAt = 0;
  if (wasDownAt === 0) return;

  const now = Date.now();
  const clean = !sawOtherKey && now - wasDownAt < TAP_MAX_MS;
  if (!clean) {
    lastTapAt = 0;
    return;
  }

  if (lastTapAt !== 0 && now - lastTapAt <= GAP_MS && now >= cooldownUntil) {
    lastTapAt = 0;
    cooldownUntil = now + COOLDOWN_MS;
    try {
      onTrigger && onTrigger();
    } catch (err) {
      console.error('[double-tap] trigger failed:', err);
    }
    return;
  }
  lastTapAt = now;
}

// Start the global hook. `trigger` is called on every detected ⌘⌘.
// Best-effort: if the hook can't start (no Input Monitoring
// permission, unsupported platform) we log and no-op — the manual
// ⌘⇧S hotkey still works.
function startDoubleTapCapture(trigger) {
  onTrigger = trigger;
  if (started) return;
  try {
    uIOhook.on('keydown', handleKeydown);
    uIOhook.on('keyup', handleKeyup);
    uIOhook.start();
    started = true;
    console.log('[double-tap] ⌘⌘ capture armed');
  } catch (err) {
    console.warn(
      '[double-tap] could not start global key hook — grant Input ' +
        'Monitoring to enable ⌘⌘ capture:',
      err.message,
    );
  }
}

function stopDoubleTapCapture() {
  if (!started) return;
  try {
    uIOhook.stop();
  } catch {}
  started = false;
}

module.exports = { startDoubleTapCapture, stopDoubleTapCapture };

// Testing hooks: feed synthetic events at a controlled clock.
module.exports._test = {
  reset() {
    cmdDownAt = 0;
    sawOtherKey = false;
    lastTapAt = 0;
    cooldownUntil = 0;
    onTrigger = null;
  },
  setTrigger(fn) {
    onTrigger = fn;
  },
  keydown: handleKeydown,
  keyup: handleKeyup,
};
