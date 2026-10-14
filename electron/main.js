/* SAM's Garage - Electron wrapper.
 * Usage: npm start
 *        npm run smoke             (electron . --smoke-test: load the app, wait for the list, print SMOKE OK/FAIL, exit)
 *        electron . --hidden       start without showing the window (the tray's "Start at login" uses it)
 *        electron . --notify-dry-run   print today's notification report for each channel, built from live data with
 *                                  the saved settings, and the request each channel would get (secrets redacted);
 *                                  sends nothing
 *        electron . --notify-check     run one scheduled notification check (sends what is due), print it, exit
 *        --notify-file=<path>      use another settings file than <userData>/notify.json (with the two above: testing)
 *
 * The page is the web app itself (site/), served from app://sg/ by electron/protocol.js. Its data comes from the live
 * site when it can be reached, else from the last copy kept, else from the snapshot bundled with the app. The daily
 * notification reports run in this process (electron/notify.js), also from the tray when the window is closed.
 */
const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('path');
const { SCHEME, ORIGIN, APP_PAGE, createHandler } = require('./protocol');
const { createNotifications } = require('./notify');

// Where the desktop app gets fresh data: the published site (GitHub redirects this address to the custom domain
// once one is set up, so it keeps working). SG_LIVE_BASE replaces it for local testing only (a local `node serve.js`).
const LIVE_BASE = /^https?:\/\/[^\s]+\/$/.test(process.env.SG_LIVE_BASE || '') ? process.env.SG_LIVE_BASE : 'https://lcintron.github.io/sams-garage/';

const SITE_DIR = path.join(__dirname, '..', 'site');
const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_TIMEOUT_MS = 20000;
const DRY_RUN = process.argv.includes('--notify-dry-run');
const CHECK_ONCE = process.argv.includes('--notify-check');
const HIDDEN = process.argv.includes('--hidden');
const ONE_SHOT = SMOKE || DRY_RUN || CHECK_ONCE; // runs that exit by themselves: no tray, no single-instance lock
const NOTIFY_FILE = (process.argv.find(a => a.startsWith('--notify-file=')) || '').slice('--notify-file='.length) || null;
const USER_AGENT = () => `SAMs-Garage/${app.getVersion()} (Electron; desktop app; +https://github.com/lcintron/sams-garage)`;

// One app at a time: a second launch (a click on a shortcut while the app sits in the tray) shows the first one.
const PRIMARY = ONE_SHOT || app.requestSingleInstanceLock();
if (!PRIMARY) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('local.samsgarage'); // notifications on Windows need it (= build.appId)

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

let mainWindow = null;
let notifications = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });

/** Show the window (making it again if it was closed), optionally at a view such as '#/notify'. */
function openApp(hash) {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow({ show: true });
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (hash) {
    const go = () => mainWindow.webContents.send('app:navigate', hash);
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', go); else go();
  }
}

function createWindow({ show = !SMOKE && !HIDDEN } = {}) {
  const win = new BrowserWindow(Object.assign({
    width: 1400, height: 900, minWidth: 900, minHeight: 520,
    title: "SAM's Garage", backgroundColor: '#0b1118', autoHideMenuBar: true, show,
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

  // "Keep running in the tray" (Windows, Linux): closing the window hides it; the reports keep their schedule.
  // macOS keeps its usual behaviour (the app stays in the Dock when its window closes) and has the tray too.
  win.on('close', e => {
    if (!quitting && process.platform !== 'darwin' && notifications && notifications.keepInTray()) {
      e.preventDefault();
      win.hide();
    }
  });

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

/** --notify-dry-run and --notify-check: print, then exit (no window, no tray). */
async function notifyOnce() {
  const n = createNotifications({ file: NOTIFY_FILE || path.join(app.getPath('userData'), 'notify.json'), liveBase: LIVE_BASE, userAgent: USER_AGENT(), siteDir: SITE_DIR, log: m => console.error(m) });
  try {
    const out = DRY_RUN ? await n.dryRun() : await n.scheduler.check('--notify-check');
    if (CHECK_ONCE) delete out.state; // the run state is in the settings file; the results say what happened
    console.log(JSON.stringify(out, null, 2));
    app.exit(0);
  } catch (e) {
    console.error('notify: ' + (e && e.message || e));
    app.exit(1);
  }
}

app.on('second-instance', () => openApp());

app.whenReady().then(() => {
  if (!PRIMARY) return;
  if (DRY_RUN || CHECK_ONCE) return notifyOnce();
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
  if (!SMOKE) {
    notifications = createNotifications({ file: NOTIFY_FILE || path.join(app.getPath('userData'), 'notify.json'), liveBase: LIVE_BASE, userAgent: USER_AGENT(), siteDir: SITE_DIR, openApp });
    notifications.registerIpc(fromApp);
    notifications.createTray();
    notifications.start();
  }
  mainWindow = createWindow();
  if (SMOKE) smoke(mainWindow, sources);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow({ show: true }); else openApp(); });
});

app.on('window-all-closed', () => {
  // macOS: the app stays in the Dock. Elsewhere it quits, unless it keeps running in the tray (then the window was
  // hidden, not closed, and this does not happen).
  if (process.platform !== 'darwin' && !(notifications && notifications.keepInTray())) app.quit();
});
