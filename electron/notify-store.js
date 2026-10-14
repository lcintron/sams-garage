/* SAM's Garage desktop app - where the notification settings live (main process): <userData>/notify.json.
 *
 *   { "version": 1, "settings": {...}, "state": {...}, "watchlist": [...], "profiles": [...], "plaintextSecrets": bool }
 *
 * settings is the shared shape (site/js/notify/core.js normalizeSettings). Each channel's secret fields (webhook URLs,
 * API keys, tokens, phone numbers) are stored encrypted with the injected cipher (main.js passes Electron's
 * safeStorage: DPAPI on Windows, the Keychain on macOS, libsecret/kwallet on Linux) as {"$enc": "<base64>"}. When the
 * system has no such store, they are stored as they are and "plaintextSecrets" is set, which the page shows as a
 * warning.
 *
 * A value that cannot be decrypted (the keychain is locked or not ready yet, another user) reads as empty, and its
 * encrypted blob is kept as it is: written back unchanged with the settings, so a passing failure never wipes it, and
 * it decrypts again once the keychain answers. Only saveSettings writes the settings at all: storing the run state, the
 * watchlist or the profiles rewrites just that part of the file.
 *
 * The file is read again whenever it changed on disk (another process wrote it), and every write merges into what is
 * on disk now, so a stale copy in memory never overwrites newer data. Two processes using one file at the same time
 * (the tray app and `electron . --notify-check`) is still for testing only: each one's run state can overwrite the
 * other's.
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
  let cache = null;   // { mtime, settings, state, watchlist, profiles, kept, lost }

  const secretKeys = ch => N.fieldsOf(ch).filter(f => f.secret).map(f => f.key);
  const mtime = () => { try { return fs.statSync(file).mtimeMs; } catch (e) { return null; } };

  function readDoc() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') onNote('notify.json could not be read (' + e.message + '); starting from defaults');
      return {};
    }
  }

  /** Settings from the file, secrets decrypted; kept: id -> {field: blob} for values that could not be decrypted. */
  function open(stored) {
    const kept = new Map();
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
          if (typeof ch.id === 'string') { if (!kept.has(ch.id)) kept.set(ch.id, {}); kept.get(ch.id)[k] = v; }
        }
      }
      return out;
    }) : [];
    if (kept.size) onNote('some notification secrets could not be decrypted now; they are kept and will be read again later');
    return { settings: N.normalizeSettings({ ...raw, channels }), kept };
  }

  /** Settings as stored: secrets encrypted (or plain without a keychain); a kept blob stands in for an empty value. */
  function seal(settings, kept) {
    const enc = canEncrypt();
    let plaintext = false;
    const channels = settings.channels.map(ch => {
      const out = { ...ch };
      const blobs = kept.get(ch.id) || {};
      for (const k of secretKeys(ch)) {
        if (!out[k]) { if (blobs[k]) out[k] = blobs[k]; continue; }
        if (enc) out[k] = { $enc: cipher.encrypt(out[k]) }; else plaintext = true;
      }
      return out;
    });
    return { settings: { ...settings, channels }, plaintext };
  }

  function read() {
    const m = mtime();
    if (cache && cache.mtime === m) return cache;
    const doc = readDoc();
    const { settings, kept } = open(doc.settings);
    cache = {
      mtime: m, settings, kept,
      state: N.cloneState(doc.state),
      watchlist: Array.isArray(doc.watchlist) ? doc.watchlist.filter(x => typeof x === 'string') : [],
      profiles: Array.isArray(doc.profiles) ? doc.profiles : []
    };
    return cache;
  }

  /** Merge `part` into the file as it is on disk now; write via a temporary file and a rename (owner-only). */
  function write(part) {
    const doc = readDoc();
    const next = { version: VERSION, ...doc, ...part };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    cache = null; // read back (and decrypt) on the next access
  }

  return {
    file,
    /** The settings with secrets in clear (for the page and the scheduler). */
    getSettings: () => read().settings,
    saveSettings(s) {
      const c = read();
      const settings = N.normalizeSettings(s);
      const { settings: sealed, plaintext } = seal(settings, c.kept);
      const part = { settings: sealed, plaintextSecrets: plaintext };
      if (typeof N.pruneState === 'function') part.state = N.pruneState(c.state, settings); // removed channels
      write(part);
      return read().settings;
    },
    getState: () => read().state,
    setState(st) { write({ state: N.cloneState(st) }); },
    getWatchlist: () => read().watchlist,
    setWatchlist(ids) {
      const list = [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x.length <= 200))].sort().slice(0, 5000);
      if (JSON.stringify(list) !== JSON.stringify(read().watchlist)) write({ watchlist: list });
    },
    getProfiles: () => read().profiles,
    setProfiles(list) {
      const clean = (Array.isArray(list) ? list : []).map(N.normalizeProfile).filter(Boolean).slice(0, 100);
      if (JSON.stringify(clean) !== JSON.stringify(read().profiles)) write({ profiles: clean });
    },
    /** true: secrets encrypted with the system keychain; false: stored as they are. */
    encryption: canEncrypt,
    /** Some secrets could not be decrypted on the last read (they are kept, and must be entered again if it lasts). */
    secretsLost: () => read().kept.size > 0,
    /** "Clear local data": delete the file (settings, secrets, run state, copies of the watchlist and profiles). */
    reset() { fs.rmSync(file, { force: true }); cache = null; }
  };
}

module.exports = { createStore, VERSION };
