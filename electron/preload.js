/* SAM's Garage desktop app - the page's small bridge to the window. Runs sandboxed: only contextBridge and
 * ipcRenderer are used. Its presence (window.sgDesktop) also tells the page it runs in the desktop app, which then
 * skips the service worker: the app's files are on disk and electron/protocol.js keeps the data fresh. */
const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own page gets it (the main process also ignores requests from anything else).
if (location.protocol === 'app:' && location.host === 'sg') contextBridge.exposeInMainWorld('sgDesktop', {
  titleBar: process.platform === 'darwin' ? 'mac' : 'overlay', // where the window buttons are (electron/main.js)
  // the window buttons' colors (Windows, Linux), kept in step with the page's theme: { color, symbolColor } as #rrggbb
  setTitleBarColors: c => ipcRenderer.send('app:titlebar-colors', { color: String(c && c.color), symbolColor: String(c && c.symbolColor) }),
  // the daily notification reports (electron/notify.js): settings (secrets in clear for the page's forms; encrypted
  // on disk), "Send test", "Send today's report now" and what runs where
  notify: {
    getSettings: () => ipcRenderer.invoke('notify:get'),
    saveSettings: s => ipcRenderer.invoke('notify:save', s),
    sendTest: channel => ipcRenderer.invoke('notify:test', channel),
    sendNow: () => ipcRenderer.invoke('notify:now'),
    status: () => ipcRenderer.invoke('notify:status')
  },
  // copies of the watchlist and the user's keyword profiles, which the reports use while the window is closed
  setWatchlist: ids => ipcRenderer.send('notify:watchlist', Array.isArray(ids) ? ids.map(String) : []),
  setProfiles: list => ipcRenderer.send('notify:profiles', Array.isArray(list) ? list : []),
  // the main process opens a view (a click on the report notification): '#/notify?report=last'
  onNavigate: fn => ipcRenderer.on('app:navigate', (e, hash) => { if (typeof hash === 'string') fn(hash); })
});
