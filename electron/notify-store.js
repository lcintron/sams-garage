/* SAM's Garage desktop app - where the notification settings live (main process): <userData>/notify.json.
 *
 *   { "version": 1, "settings": {...}, "state": {...}, "watchlist": [...], "profiles": [...], "plaintextSecrets": bool }
 *
 * settings is the shared shape (site/js/notify/core.js normalizeSettings). Each channel's secret fields (webhook URLs,
 * API keys, tokens, phone numbers) are stored encrypted with the injected cipher (main.js passes Electron's
 * safeStorage: DPAPI on Windows, the Keychain on macOS, libsecret/kwallet on Linux) as {"$enc": "<base64>"}. When the
 * system has no such store, they are stored as they are and "plaintextSecrets" is set, which the page shows as a
 * warning. A value that can no longer be decrypted (another user, a new keychain) is dropped and must be entered again.
 *
 * No Electron imports: the tests run this in plain Node with a fake cipher.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;

/**
 * @param {{ file: string, N: object, cipher?: { available(): boolean, encrypt(s: string): string, decrypt(b64: string): string },
 *           onNote?: (msg: string) => void }} o
 *   N: the shared engine (globalThis.SgNotify). cipher.encrypt returns base64; decrypt takes it back.
 */
function createStore(o) {
  const { file, N, cipher = null, onNote = () => {} } = o;
  const canEncrypt = () => { try { return !!(cipher && cipher.available()); } catch (e) { return false; } };
  let cache = null;
  let lost = false; // some secrets could not be decrypted on the last load

  function secretKeys(ch) { return N.fieldsOf(ch).filter(f => f.secret).map(f => f.key); }

  function seal(settings) {
    const enc = canEncrypt();
    const channels = settings.channels.map(ch => {
      const out = { ...ch };
      if (enc) for (const k of secretKeys(ch)) if (out[k]) out[k] = { $enc: cipher.encrypt(out[k]) };
      return out;
    });
    return { settings: { ...settings, channels }, plaintext: !enc && settings.channels.some(ch => secretKeys(ch).some(k => ch[k])) };
  }

  function open(stored) {
    lost = false;
    const raw = stored && typeof stored === 'object' ? stored : {};
    const channels = Array.isArray(raw.channels) ? raw.channels.map(ch => {
      if (!ch || typeof ch !== 'object') return ch;
      const out = { ...ch };
      for (const [k, v] of Object.entries(out)) {
        if (!v || typeof v !== 'object' || typeof v.$enc !== 'string') continue;
        try {
          if (!canEncrypt()) throw new Error('no keychain');
          out[k] = cipher.decrypt(v.$enc);
        } catch (e) {
          out[k] = '';
          lost = true;
        }
      }
      return out;
    }) : [];
    if (lost) onNote('some notification secrets could not be decrypted and must be entered again');
    return N.normalizeSettings({ ...raw, channels });
  }

  function read() {
    if (cache) return cache;
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') onNote('notify.json could not be read (' + e.message + '); starting from defaults');
    }
    cache = {
      settings: open(doc.settings),
      state: N.cloneState(doc.state),
      watchlist: Array.isArray(doc.watchlist) ? doc.watchlist.filter(x => typeof x === 'string') : [],
      profiles: Array.isArray(doc.profiles) ? doc.profiles : []
    };
    return cache;
  }

  /** Write via a temporary file and a rename (owner-only permissions where the OS has them). */
  function write() {
    const c = read();
    const { settings, plaintext } = seal(c.settings);
    const doc = { version: VERSION, settings, state: c.state, watchlist: c.watchlist, profiles: c.profiles, plaintextSecrets: plaintext };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }

  return {
    file,
    /** The settings with secrets in clear (for the page and the scheduler). */
    getSettings: () => read().settings,
    saveSettings(s) { read().settings = N.normalizeSettings(s); write(); return read().settings; },
    getState: () => read().state,
    setState(st) { read().state = N.cloneState(st); write(); },
    getWatchlist: () => read().watchlist,
    setWatchlist(ids) {
      const list = [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x.length <= 200))].sort().slice(0, 5000);
      if (JSON.stringify(list) === JSON.stringify(read().watchlist)) return;
      read().watchlist = list;
      write();
    },
    getProfiles: () => read().profiles,
    setProfiles(list) {
      const clean = (Array.isArray(list) ? list : []).map(N.normalizeProfile).filter(Boolean).slice(0, 100);
      if (JSON.stringify(clean) === JSON.stringify(read().profiles)) return;
      read().profiles = clean;
      write();
    },
    /** true: secrets encrypted with the system keychain; false: stored as they are. */
    encryption: canEncrypt,
    secretsLost: () => (read(), lost),
    reload() { cache = null; return read(); }
  };
}

module.exports = { createStore, VERSION };
