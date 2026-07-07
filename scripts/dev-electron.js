// Dev launcher: start Electron through macOS LaunchServices (`open`)
// instead of spawning `electron .` directly. A spawned Electron is a
// grandchild of the terminal and macOS keeps it as a background
// UIElement (no dock icon); launching via `open` registers it normally
// so it shows in the dock — matching how the packaged app behaves.
//
// The tradeoff `open` brings is that the app is detached (its stdout
// doesn't reach us), so we redirect it to a log file and tail that into
// this terminal, and we kill the app ourselves when the dev run ends.
//
// Non-macOS falls back to a plain spawn.
const { spawn, spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const electronApp = path.join(
  projectRoot,
  'node_modules/electron/dist/Electron.app',
);
const electronBin = path.join(electronApp, 'Contents/MacOS/Electron');

if (process.platform !== 'darwin') {
  const child = spawn(electronBin, ['.'], { cwd: projectRoot, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const logPath = path.join(os.tmpdir(), 'gatheros-electron-dev.log');
fs.writeFileSync(logPath, '');

// LaunchServices launch → real dock icon. --stdout/--stderr capture the
// detached app's console output to a file we can stream.
spawnSync(
  'open',
  ['-n', electronApp, '--stdout', logPath, '--stderr', logPath, '--args', projectRoot],
  { stdio: 'inherit' },
);

const tail = spawn('tail', ['-f', logPath], { stdio: ['ignore', 'inherit', 'inherit'] });

// The app is detached, so on Ctrl+C / concurrently's kill we must reap
// it ourselves. Scope the pattern to THIS project's Electron binary so
// we never touch other Electron apps.
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { execSync(`pkill -9 -f "${electronBin}"`, { stdio: 'ignore' }); } catch {}
  try { tail.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
