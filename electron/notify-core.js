/* SAM's Garage desktop app - loads the shared notifications engine (site/js/notify/core.js) into the main process.
 *
 * core.js is a classic script that sets globalThis.SgNotify (it also loads in the page, the service worker and Node).
 * It is run here with vm in this context rather than import()ed: how Node would treat the file depends on
 * site/package.json ("type": "module"), which the installer leaves out, and on ESM support inside the app's asar
 * archive. Reading the file and running it works the same in development and in an installed app. No Electron imports.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = path.join(__dirname, '..', 'site', 'js', 'notify', 'core.js');

/** globalThis.SgNotify, loading core.js once. */
function loadCore(file = CORE) {
  if (!globalThis.SgNotify) vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  return globalThis.SgNotify;
}

module.exports = { loadCore, CORE };
