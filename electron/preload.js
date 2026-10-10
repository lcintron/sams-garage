/* SAM's Garage desktop app - the page's small bridge to the window. Runs sandboxed: only contextBridge and
 * ipcRenderer are used. Its presence (window.sgDesktop) also tells the page it runs in the desktop app, which then
 * skips the service worker: the app's files are on disk and electron/protocol.js keeps the data fresh. */
const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own page gets it (the main process also ignores requests from anything else).
if (location.protocol === 'app:' && location.host === 'sg') contextBridge.exposeInMainWorld('sgDesktop', {
  titleBar: process.platform === 'darwin' ? 'mac' : 'overlay', // where the window buttons are (electron/main.js)
  // the window buttons' colors (Windows, Linux), kept in step with the page's theme: { color, symbolColor } as #rrggbb
  setTitleBarColors: c => ipcRenderer.send('app:titlebar-colors', { color: String(c && c.color), symbolColor: String(c && c.symbolColor) })
});
