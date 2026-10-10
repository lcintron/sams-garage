/* SAM's Garage - Electron wrapper.
 * Usage: npm start
 *        npm run smoke        (electron . --smoke-test: load the app, wait for the list, print SMOKE OK/FAIL, exit)
 *
 * The page is the web app itself (site/), served from app://sg/ by electron/protocol.js. Its data comes from the live
 * site when it can be reached, else from the last copy kept, else from the snapshot bundled with the app.
 */
const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('path');
const { SCHEME, ORIGIN, APP_PAGE, createHandler } = require('./protocol');

// Where the desktop app gets fresh data: the published site (GitHub redirects this address to the custom domain
// once one is set up, so it keeps working).
const LIVE_BASE = 'https://lcintron.github.io/sams-garage/';

const SITE_DIR = path.join(__dirname, '..', 'site');
const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_TIMEOUT_MS = 20000;

// Before the app is ready: app:// behaves like https:// (a secure origin with fetch, CORS, storage and streaming).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// No system frame: the app's top bar is the window's title bar (css: html[data-titlebar]). On Windows and Linux the
// system's own window buttons are drawn over the bar's right end, in the bar's colors (the page keeps them in step
// with its theme: setTitleBarColors in preload.js); macOS keeps its traffic lights, at the bar's left. The overlay
// is the bar's height less its bottom border.
const TITLE_BAR = process.platform === 'darwin'
  ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 18 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#10171f', symbolColor: '#e6ebf2', height: 52 } };

const isAppUrl = url => String(url) === ORIGIN || String(url).startsWith(ORIGIN + '/');
const fromApp = e => !!(e.senderFrame && isAppUrl(e.senderFrame.url));

function createWindow() {
  const win = new BrowserWindow(Object.assign({
    width: 1400, height: 900, minWidth: 900, minHeight: 520,
    title: "SAM's Garage", backgroundColor: '#0b1118', autoHideMenuBar: true, show: !SMOKE,
    icon: path.join(SITE_DIR, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  }, TITLE_BAR));

  // The window shows the app and nothing else: links (official solicitations, sources, the releases page) open in
  // the system browser, never in this window.
  const external = url => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const stayHome = (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); external(url); } };
  win.webContents.on('will-navigate', stayHome);
  win.webContents.on('will-redirect', stayHome);
  // Downloads (CSV/JSON export, the .sqlite file) keep Electron's default: a Save dialog.

  win.loadURL(APP_PAGE);
  return win;
}

// The page asks for the window buttons' colors when its theme changes (Windows, Linux).
ipcMain.on('app:titlebar-colors', (e, c) => {
  if (!fromApp(e) || process.platform === 'darwin' || !c) return;
  const hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && hex(c.color) && hex(c.symbolColor)) {
    try { win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor }); } catch (err) { /* no overlay */ }
  }
});

/** --smoke-test: wait until the list shows at least one card, print the verdict, exit 0 or 1. The 20 s run from
 * the start, so a page that never finishes loading fails too. */
function smoke(win, sources) {
  let finished = false;
  const done = (ok, msg) => {
    if (finished) return;
    finished = true;
    const counts = Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ');
    if (counts) console.log(`data: ${counts}`);
    console.log(ok ? `SMOKE OK ${msg}` : `SMOKE FAIL ${msg}`);
    app.exit(ok ? 0 : 1);
  };
  const started = Date.now();
  setTimeout(() => done(false, `the app did not finish loading within ${SMOKE_TIMEOUT_MS / 1000} s`), SMOKE_TIMEOUT_MS + 1000).unref?.();
  win.webContents.on('console-message', (...args) => {
    const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
    if (d.level === 'error' || d.level === 3) console.error('[page] ' + d.message);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => done(false, `load failed: ${desc} (${code}) ${url}`));
  win.webContents.on('render-process-gone', (e, d) => done(false, `renderer gone: ${d.reason}`));
  const poll = async () => {
    if (finished) return;
    let n = 0;
    try { n = await win.webContents.executeJavaScript("document.querySelectorAll('#list .card').length"); } catch (e) { /* not ready */ }
    if (n > 0) return done(true, `${n} cards`);
    if (Date.now() - started > SMOKE_TIMEOUT_MS) {
      let why = `no .card rendered within ${SMOKE_TIMEOUT_MS / 1000} s`;
      try { why += ': ' + await win.webContents.executeJavaScript("(document.querySelector('#list')||{}).innerText || ''").then(t => t.trim().slice(0, 200) || 'empty list'); } catch (e) { /* ignore */ }
      return done(false, why);
    }
    setTimeout(poll, 250);
  };
  win.webContents.once('did-finish-load', poll);
}

app.whenReady().then(() => {
  const sources = {};
  protocol.handle(SCHEME, createHandler({
    siteDir: SITE_DIR,
    cacheDir: path.join(app.getPath('userData'), 'data-cache'),
    liveBase: LIVE_BASE,
    fetch: (url, init) => net.fetch(url, init),
    timeoutMs: 8000,
    userAgent: `SAMs-Garage/${app.getVersion()} (Electron; desktop app; +https://github.com/lcintron/sams-garage)`,
    onData: (rel, source, detail) => {
      sources[source] = (sources[source] || 0) + 1;
      if (SMOKE && (source !== 'live' || detail)) console.log(`data/${rel}: ${source}${detail ? ' (' + detail + ')' : ''}`);
    },
    onNote: (rel, note) => console.warn(`data/${rel}: ${note}`)
  }));
  // The app needs no device permissions; only writing to the clipboard ("Copy link") is allowed.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  const win = createWindow();
  if (SMOKE) smoke(win, sources);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
