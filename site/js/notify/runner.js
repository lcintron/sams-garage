/*
 * The browser's report run, shared by the service worker (Periodic Background Sync) and the page (on load and when it
 * becomes visible): read the settings and run state from IndexedDB, take the shared lock, fetch the live data, send
 * to the channels a browser can reach, show the device notification, store the new state. Best effort: a browser
 * runs this only while it runs (README "Notifications").
 *
 * A classic script (globalThis.SgNotifyRunner), loaded after core.js; the page imports it for its side effect and
 * sw.js with importScripts. Everything it touches comes in through `env`, so the tests run it with fakes.
 */
(function (root) {
  'use strict';
  const KEYS = { settings: 'notify-settings', state: 'notify-state', lastReport: 'notify-last-report', watchlist: 'watchlist', profiles: 'profiles' };
  const LOCK = 'notify';
  const LOCK_MS = 2 * 60000;
  const SEND_TIMEOUT_MS = 20000;
  const TAG = 'sg-daily-report';

  async function fetchJSON(env, rel) {
    const res = await env.fetch(new URL('data/' + rel, env.base).href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`data/${rel}: HTTP ${res.status}`);
    return res.json();
  }

  /** The live data in the format this app reads (else an error: the page then asks for an update). */
  function loaders(env) {
    const N = root.SgNotify;
    return {
      async loadMeta() {
        const meta = await fetchJSON(env, 'meta.json');
        const f = meta && meta.format;
        if (!(f == null || (Number.isInteger(f) && f <= N.DATA_FORMAT))) throw new Error('the live data is in a newer format than this app reads');
        return meta;
      },
      async loadData() {
        const [catalog, changes, docs] = await Promise.all([
          fetchJSON(env, 'catalog.json'), fetchJSON(env, 'changes.json'), fetchJSON(env, 'search-index.json').catch(() => [])
        ]);
        const desc = new Map((Array.isArray(docs) ? docs : []).map(d => [d.id, d.description || '']));
        const records = (Array.isArray(catalog) ? catalog : []).map(r => (desc.has(r.id) ? { ...r, description: desc.get(r.id) } : r));
        return { records, events: (changes && Array.isArray(changes.events)) ? changes.events : [] };
      }
    };
  }

  /** Send one request the way a browser can (browserMode); resolves {ok, status, error, opaque}. */
  async function send(env, req, channel) {
    const N = root.SgNotify;
    if (req.browserMode === 'unsupported') return { ok: false, error: 'This channel can only be sent from the desktop app or GitHub Actions.' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS) : null;
    try {
      const res = await env.fetch(req.url, {
        method: req.method, headers: req.headers, body: req.body == null ? undefined : req.body,
        mode: req.browserMode === 'no-cors' ? 'no-cors' : 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      });
      if (res.type === 'opaque') return { ok: true, opaque: true, status: 0 };
      const body = await res.text().catch(() => '');
      return { ...N.interpretResponse(channel, { status: res.status, body }), status: res.status };
    } catch (e) {
      return { ok: false, error: (e && e.name === 'AbortError') ? 'timed out' : String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The device notification for a report (when env.notify is given: permission granted). */
  function localNotifier(env) {
    if (typeof env.notify !== 'function') return undefined;
    const N = root.SgNotify;
    return async digest => {
      await env.notify(N.format.headline(digest), {
        body: N.format.summary(digest), tag: TAG, icon: new URL('icons/icon-192.png', env.base).href,
        data: { url: new URL('./#/notify?report=last', env.base).href }
      });
      return { ok: true };
    };
  }

  /**
   * One check. env: {kv (SgIdb-like), fetch, base (the app's URL, ending in /), owner ('sw' | 'page'), notify?(title,
   * options), now?, mode? ('scheduled' | 'now'), publicUrl?}. Resolves with runDue's result, or {reason} when it did
   * not run (paused, browser-off, locked).
   */
  async function run(env) {
    const N = root.SgNotify;
    const settings = N.normalizeSettings(await env.kv.get(KEYS.settings));
    const mode = env.mode === 'now' ? 'now' : 'scheduled';
    if (!settings.enabled && mode === 'scheduled') return { reason: 'paused', sent: 0, failed: 0, results: [] };
    if (!settings.background.browser && mode === 'scheduled') return { reason: 'browser-off', sent: 0, failed: 0, results: [] };
    if (!(await env.kv.lock(LOCK, env.owner, LOCK_MS))) return { reason: 'locked', sent: 0, failed: 0, results: [] };
    try {
      const [state, watchlist, custom] = await Promise.all([env.kv.get(KEYS.state), env.kv.get(KEYS.watchlist), env.kv.get(KEYS.profiles)]);
      const res = await N.runDue({
        settings, state, mode, now: env.now, runtime: 'browser',
        watchlist: Array.isArray(watchlist) ? watchlist : [],
        profiles: N.allProfiles(Array.isArray(custom) ? custom : []),
        ctx: { publicUrl: env.publicUrl || N.PUBLIC_URL },
        ...loaders(env),
        send: (req, ch) => send(env, req, ch),
        local: localNotifier(env)
      });
      await env.kv.set(KEYS.state, res.state);
      if (res.sent && res.state.lastReport) await env.kv.set(KEYS.lastReport, res.state.lastReport);
      return res;
    } finally {
      await env.kv.unlock(LOCK, env.owner).catch(() => {});
    }
  }

  /** "Send test" from a browser: the sample report to one channel; never touches the run state. */
  async function sendTest(env, channel) {
    const N = root.SgNotify;
    const v = N.validateChannel(channel);
    if (!v.ok) return { ok: false, error: v.errors.map(e => e.message).join(' ') };
    const req = N.buildRequest(channel, N.sampleDigest(env.now), { publicUrl: env.publicUrl || N.PUBLIC_URL });
    return send(env, req, channel);
  }

  root.SgNotifyRunner = { run, sendTest, send, loaders, KEYS, LOCK, TAG };
})(typeof globalThis !== 'undefined' ? globalThis : this);
