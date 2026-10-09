/* Cage Rules desktop shell: splash screen, then the web game served from app://game/. */
'use strict';
const { app, BrowserWindow, protocol, net, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Packaged builds carry a copy of the game in resources/game (extraResources in package.json);
// `npm start` runs straight off the repo root.
const GAME_DIR = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..');
const SPLASH_MIN_MS = 2500;  // how long the studio logo stays up at minimum
const SPLASH_FADE_MS = 450;  // matches the CSS transition in splash/splash.html

// A real origin (not file://) keeps localStorage saves stable and lets fetch/media behave normally.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- window settings (fullscreen / size), kept in userData ----------
const settingsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadSettings() {
  try { return Object.assign({ fullscreen: true, width: 1600, height: 900 }, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch (_) { return { fullscreen: true, width: 1600, height: 900 }; }
}
function saveSettings(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(settingsFile(), JSON.stringify({ fullscreen: win.isFullScreen(), width: b.width, height: b.height }));
  } catch (_) {}
}

function serveGame() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url); // drops the ?v=NN cache tags
    const file = path.normalize(path.join(GAME_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(GAME_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createSplash() {
  const splash = new BrowserWindow({
    width: 480, height: 520, frame: false, resizable: false, movable: false,
    center: true, show: false, backgroundColor: '#ffffff', alwaysOnTop: true,
    skipTaskbar: true, webPreferences: { sandbox: true }
  });
  splash.loadFile(path.join(__dirname, 'splash', 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

function createGameWindow(settings) {
  const win = new BrowserWindow({
    width: settings.width, height: settings.height, minWidth: 960, minHeight: 540,
    fullscreen: settings.fullscreen, show: false, backgroundColor: '#000000',
    title: 'Cage Rules', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false // the fight sim must keep ticking while the host is alt-tabbed
    }
  });
  win.removeMenu();

  // F11 or Alt+Enter toggles fullscreen.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // Keep the game in this window; anything external goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://game/')) e.preventDefault();
  });

  win.on('close', () => saveSettings(win));
  win.loadURL('app://game/index.html');
  return win;
}

app.whenReady().then(() => {
  serveGame();
  const splash = createSplash();
  const win = createGameWindow(loadSettings());
  const shown = Date.now();

  win.once('ready-to-show', () => {
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - shown));
    setTimeout(() => {
      if (splash.isDestroyed()) { win.show(); return; }
      splash.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => {});
      setTimeout(() => {
        win.show();
        win.focus();
        if (!splash.isDestroyed()) splash.destroy();
      }, SPLASH_FADE_MS);
    }, wait);
  });

  ipcMain.on('quit', () => app.quit());
  ipcMain.on('toggle-fullscreen', () => win.setFullScreen(!win.isFullScreen()));

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
});

app.on('window-all-closed', () => app.quit());
