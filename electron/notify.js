/* SAM's Garage desktop app - daily notification reports (main process): the settings store, the scheduler, the
 * page's bridge (IPC), the device notification and the tray icon. The desktop app is the main way to get reports
 * while no browser is open: with "Keep running in the tray" on, closing the window leaves the app (and its schedule)
 * running, and "Start at login" starts it hidden (--hidden).
 *
 * The logic is in modules without Electron imports, tested in plain Node: notify-store.js (notify.json, secrets
 * encrypted with safeStorage), notify-scheduler.js (when to check, what to send) and site/js/notify/core.js (the
 * report itself, shared with the web app and GitHub Actions).
 */
const { app, ipcMain, Menu, Notification, Tray, nativeImage, net, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const { loadCore } = require('./notify-core');
const { createStore } = require('./notify-store');
const { createScheduler } = require('./notify-scheduler');

const CHECK_MS = 15 * 60000;   // a check every 15 minutes (cheap: meta.json only, unless a report is due)
const FIRST_CHECK_MS = 15000;  // the first one shortly after start, once the network is up
const REPORT_HASH = '#/notify?report=last';

/** Electron's safeStorage as notify-store's cipher. Linux's "basic_text" backend is no real protection: not used. */
function safeStorageCipher() {
  return {
    available() {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text';
      }
      return true;
    },
    encrypt: s => safeStorage.encryptString(s).toString('base64'),
    decrypt: b64 => safeStorage.decryptString(Buffer.from(b64, 'base64'))
  };
}

/**
 * @param {{ file: string, liveBase: string, userAgent: string, siteDir: string, log?: Function,
 *           openApp?: (hash?: string) => void }} o   openApp shows the window (at a view)
 */
function createNotifications(o) {
  const log = o.log || (m => console.log(m));
  const N = loadCore();
  const store = createStore({ file: o.file, N, cipher: safeStorageCipher(), onNote: m => log('notifications: ' + m) });
  const shown = new Set(); // live notifications (else they can be garbage-collected before a click)
  const icon = path.join(o.siteDir, 'icons', 'icon-192.png');
  const notifier = Notification.isSupported() ? (title, body) => {
    const n = new Notification({ title, body, icon });
    const done = () => shown.delete(n);
    n.on('click', () => { done(); if (o.openApp) o.openApp(REPORT_HASH); });
    n.on('close', done);
    shown.add(n);
    n.show();
    return true;
  } : null;
  const scheduler = createScheduler({ N, store, fetch: (url, init) => net.fetch(url, init), liveBase: o.liveBase, userAgent: o.userAgent, notify: notifier, log });

  let tray = null;
  let timer = null;

  function start() {
    setTimeout(() => scheduler.check('start').catch(e => log('notifications: ' + e.message)), FIRST_CHECK_MS).unref?.();
    timer = setInterval(() => scheduler.check('timer').catch(e => log('notifications: ' + e.message)), CHECK_MS);
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => scheduler.check(ev).catch(() => {}));
  }

  /** The page's bridge (preload.js sgDesktop.notify, setWatchlist, setProfiles); only the app's own page may call. */
  function registerIpc(fromApp) {
    const guard = fn => async (e, ...args) => { if (!fromApp(e)) throw new Error('not allowed'); return fn(...args); };
    ipcMain.handle('notify:get', guard(() => ({ settings: store.getSettings(), state: store.getState(), encryption: store.encryption(), secretsLost: store.secretsLost() })));
    ipcMain.handle('notify:save', guard(s => { const out = store.saveSettings(s); refreshTray(); return out; }));
    ipcMain.handle('notify:test', guard(ch => scheduler.sendTest(ch)));
    ipcMain.handle('notify:now', guard(() => scheduler.check('send now', 'now')));
    ipcMain.handle('notify:status', guard(() => status()));
    ipcMain.on('notify:watchlist', (e, ids) => { if (fromApp(e)) store.setWatchlist(ids); });
    ipcMain.on('notify:profiles', (e, list) => { if (fromApp(e)) store.setProfiles(list); });
  }

  function status() {
    let openAtLogin = false;
    try { openAtLogin = app.getLoginItemSettings().openAtLogin; } catch (e) { /* not on this OS */ }
    return { ...scheduler.status(), encryption: store.encryption(), secretsLost: store.secretsLost(), openAtLogin, tray: !!tray, keepInTray: keepInTray() };
  }

  /** "Keep running in the tray": closing the window hides it (Windows, Linux). Needs a tray to come back from. */
  const keepInTray = () => !!tray && store.getSettings().background.tray;

  function trayImage() {
    const dir = path.join(o.siteDir, 'icons');
    if (process.platform === 'win32') return nativeImage.createFromPath(path.join(dir, 'icon.ico'));
    const img = nativeImage.createFromPath(path.join(dir, 'favicon-32.png'));
    return process.platform === 'darwin' ? img.resize({ width: 16, height: 16 }) : img;
  }

  function sendNow() {
    scheduler.check('tray', 'now').then(r => {
      const msg = r.sent ? `Report sent to ${r.sent} ${r.sent === 1 ? 'channel' : 'channels'}${r.failed ? `, ${r.failed} failed` : ''}.`
        : r.failed ? 'The report could not be sent.' : r.reason === 'not-due' ? "Today's report was already sent."
        : r.reason === 'no-channels' ? 'No notification channels are set up.' : r.reason === 'data-error' ? 'The data could not be loaded: ' + r.error : 'Nothing new to report.';
      if (notifier && !r.sent) notifier("SAM's Garage", msg);
      refreshTray();
    }).catch(e => log('notifications: ' + e.message));
  }

  function menu() {
    const s = store.getSettings();
    let login = false;
    try { login = app.getLoginItemSettings().openAtLogin; } catch (e) { /* ignore */ }
    return Menu.buildFromTemplate([
      { label: "Open SAM's Garage", click: () => o.openApp && o.openApp() },
      { label: "Send today's report now", click: sendNow },
      { label: s.enabled ? 'Pause notifications' : 'Resume notifications', click: () => { store.saveSettings({ ...s, enabled: !s.enabled }); refreshTray(); } },
      { label: 'Notification settings…', click: () => o.openApp && o.openApp('#/notify') },
      { type: 'separator' },
      {
        label: 'Start at login', type: 'checkbox', checked: login, enabled: process.platform !== 'linux',
        click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ['--hidden'] }); refreshTray(); }
      },
      { label: 'Keep running in the tray', type: 'checkbox', checked: s.background.tray, click: item => { store.saveSettings({ ...s, background: { ...s.background, tray: item.checked } }); refreshTray(); } },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ]);
  }

  function refreshTray() {
    if (!tray) return;
    tray.setContextMenu(menu());
    tray.setToolTip("SAM's Garage" + (store.getSettings().enabled ? '' : ' (notifications paused)'));
  }

  function createTray() {
    try {
      tray = new Tray(trayImage());
    } catch (e) {
      log('tray: not available (' + e.message + ')');
      tray = null;
      return null;
    }
    refreshTray();
    if (process.platform !== 'darwin') tray.on('click', () => o.openApp && o.openApp());
    return tray;
  }

  return { N, store, scheduler, start, registerIpc, createTray, refreshTray, keepInTray, status, dryRun: () => scheduler.dryRun(), stop: () => clearInterval(timer) };
}

module.exports = { createNotifications, safeStorageCipher, REPORT_HASH };
