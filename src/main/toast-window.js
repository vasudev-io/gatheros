const { BrowserWindow, screen, app } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

// Window matches the pill's actual extents so macOS vibrancy
// (set below) frosts ONLY the pill area — extra window padding
// would show a visible halo of frosted glass around it.
// Sized to the editorial two-line card (cluster + title/subtitle +
// inline Undo). Taller and a touch wider than the old single-line pill.
const TOAST_WIDTH = 312;
const TOAST_HEIGHT = 70;
// Distance from the work-area corner. The visual gap used to be
// owned by the renderer's padding wrapper, but with vibrancy
// constrained to the window rect the gap has to live in the
// window's position instead.
const EDGE_INSET = 16;

let toastWin = null;
let ready = false;
let pending = [];

// Bottom-left corner of whichever display the main app window
// currently lives on. Re-evaluated every time we show a toast so
// that moving the app window between monitors keeps the toast on
// the same screen instead of stranding it on the primary display.
function targetBounds() {
  // Prefer the main window's display when one exists. If the toast
  // fires before any window does (e.g. tray-triggered capture at
  // launch), fall back to the focused window, then primary.
  const candidates = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w !== toastWin,
  );
  const ref = BrowserWindow.getFocusedWindow() && !BrowserWindow.getFocusedWindow().isDestroyed()
    && candidates.includes(BrowserWindow.getFocusedWindow())
    ? BrowserWindow.getFocusedWindow()
    : candidates[0];
  const display = ref
    ? screen.getDisplayMatching(ref.getBounds())
    : screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  return {
    // Bottom-right corner of the chosen display, inset by EDGE_INSET
    // on both axes. workArea already excludes the menu bar + Dock,
    // so this lands above whatever's anchored to those edges. The
    // gap from the corner used to live in renderer padding; with
    // the window now sized to the pill exactly, it has to live in
    // the window's position instead.
    x: x + width - TOAST_WIDTH - EDGE_INSET,
    y: y + height - TOAST_HEIGHT - EDGE_INSET,
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
  };
}

function ensureToastWindow() {
  if (toastWin && !toastWin.isDestroyed()) return toastWin;

  const bounds = targetBounds();

  toastWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    frame: false,
    // No `transparent: true` here on purpose — with vibrancy the
    // window background IS the frosted material, and transparent
    // mode used to cause a brief white flash before the vibrancy
    // layer kicked in. Letting the NSVisualEffectView be the
    // window background eliminates the flash.
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    acceptFirstMouse: true,
    // macOS-native blur of whatever's behind the window. Window
    // rect = pill rect (TOAST_WIDTH × TOAST_HEIGHT) so the frosted
    // material lines up with the visible pill — vibrancy fills
    // the whole window, so any extra padding would show a halo of
    // glass around the pill.
    vibrancy: 'hud',
    visualEffectState: 'active',
    // Rounds the NSVisualEffectView itself so the system blur stays
    // inside the pill's corner radius instead of poking out as a
    // 90° rectangle behind it.
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-toast.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // skipTransformProcessType: Electron implements visibleOnFullScreen
  // by flipping the whole app to the accessory activation policy, which
  // removes the Dock icon the moment the first toast window is created
  // (reproduced: ApplicationType Foreground → UIElement). We keep the
  // Dock icon instead; the toast just won't float over fullscreen-space
  // apps. ponytail: an NSPanel-type window could do both if it matters.
  toastWin.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  toastWin.setAlwaysOnTop(true, 'floating');
  // Start click-through; enabled only when there's a toast to interact with.
  toastWin.setIgnoreMouseEvents(true, { forward: true });

  toastWin.webContents.once('did-finish-load', () => {
    ready = true;
    // Mount the window invisibly so macOS attaches the
    // NSVisualEffectView once and keeps it attached for the
    // session. hide()/show() cycles between toasts used to flash
    // the system default appearance for one frame before vibrancy
    // re-painted; opacity 0 keeps the window mounted (vibrancy
    // alive) without any visible chrome.
    toastWin.setOpacity(0);
    toastWin.showInactive();
    const items = pending;
    pending = [];
    if (items.length > 0) {
      for (const p of items) toastWin.webContents.send('toast:show', p);
      toastWin.setOpacity(1);
    }
  });

  toastWin.on('closed', () => {
    toastWin = null;
    ready = false;
  });

  if (isDev) {
    toastWin.loadURL(`${DEV_URL}/toast.html`);
  } else {
    toastWin.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'toast.html'),
    );
  }

  return toastWin;
}

function showToast(record) {
  const win = ensureToastWindow();
  // Recompute bounds every time — the user may have moved the main
  // window between monitors since the toast window was created or
  // last shown. setBounds is a no-op if the rect hasn't changed.
  try { win.setBounds(targetBounds()); } catch {}
  if (ready) {
    win.webContents.send('toast:show', record);
    if (!win.isVisible()) win.showInactive();
    win.setOpacity(1);
  } else {
    pending.push(record);
  }
}

function destroyToastWindow() {
  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.destroy();
  }
  toastWin = null;
  ready = false;
  pending = [];
}

function setToastInteractive(interactive) {
  if (!toastWin || toastWin.isDestroyed()) return;
  toastWin.setIgnoreMouseEvents(!interactive, { forward: true });
}

// Called by the renderer once every toast has been dismissed. We
// keep the window MOUNTED (so the NSVisualEffectView material
// stays attached for the next show — re-mounting was causing a
// one-frame flash of the system default appearance) and just
// fade it out via setOpacity. Click-through is restored so the
// invisible window doesn't eat clicks at the screen corner.
function onToastsEmpty() {
  setToastInteractive(false);
  if (toastWin && !toastWin.isDestroyed()) toastWin.setOpacity(0);
}

module.exports = {
  showToast,
  destroyToastWindow,
  setToastInteractive,
  onToastsEmpty,
};
