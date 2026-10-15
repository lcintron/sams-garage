/* SAM's Garage desktop app - the daily notification report's scheduler (main process).
 *
 * electron/notify.js calls check() every 15 minutes and when the computer wakes or is unlocked. Each check reads the
 * live meta.json (the same site as electron/protocol.js, with the same data format gate), and only when a channel is
 * due and there is newer data does it fetch catalog.json, changes.json and search-index.json, build the report with
 * the shared engine (site/js/notify/core.js runDue) and send it. The rules are the engine's: one report per channel
 * per local date, at or after the configured time, a missed day caught up at the next check, a failed channel retried
 * once at the next check that day, each report covering everything since that channel's last one.
 *
 * No Electron imports: main passes net.fetch and a notifier in, and the tests run this in plain Node.
 */
const { formatSupported } = require('./protocol');

const SEND_TIMEOUT_MS = 20000;
const DATA_TIMEOUT_MS = 30000;

/**
 * @param {{ N: object, store: object, fetch: Function, liveBase: string, userAgent?: string, now?: () => number,
 *           notify?: (title: string, body: string) => boolean | Promise<boolean>, ctx?: object,
 *           log?: (msg: string) => void }} o
 *   store: electron/notify-store.js. notify shows the device notification (false when the system has none).
 *   ctx: formatter/request options (publicUrl; callmebotUrl and graphBase for tests).
 */
function createScheduler(o) {
  const { N, store, fetch, liveBase, userAgent, now = () => Date.now(), notify = null, log = () => {} } = o;
  const ctx = { publicUrl: N.PUBLIC_URL, ...(o.ctx || {}) };
  const ua = userAgent ? { 'User-Agent': userAgent } : {};
  let running = null;
  let last = { at: null, reason: null, error: null, results: [] };

  async function withTimeout(ms, fn) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fn(ctl.signal); } finally { clearTimeout(t); }
  }
  async function getJSON(rel) {
    return withTimeout(DATA_TIMEOUT_MS, async signal => {
      const res = await fetch(liveBase + 'data/' + rel, { headers: ua, cache: 'no-store', signal });
      if (!res.ok) throw new Error(`data/${rel}: HTTP ${res.status}`);
      return res.json();
    });
  }
  async function loadMeta() {
    const meta = await getJSON('meta.json');
    if (!formatSupported(meta)) throw new Error('the live data is in a newer format than this app reads (update the app)');
    return meta;
  }
  async function loadData() {
    const [catalog, changes, docs] = await Promise.all([getJSON('catalog.json'), getJSON('changes.json'), getJSON('search-index.json').catch(() => [])]);
    const desc = new Map((Array.isArray(docs) ? docs : []).map(d => [d.id, d.description || '']));
    return {
      records: (Array.isArray(catalog) ? catalog : []).map(r => (desc.has(r.id) ? { ...r, description: desc.get(r.id) } : r)),
      events: changes && Array.isArray(changes.events) ? changes.events : [],
      dataSince: (changes && changes.since) || null // where changes.json starts: an older window is reported as partial
    };
  }
  /** Send one request; resolves {ok, status, error}. */
  async function send(req, channel) {
    try {
      return await withTimeout(SEND_TIMEOUT_MS, async signal => {
        const res = await fetch(req.url, { method: req.method, headers: { ...ua, ...req.headers }, body: req.body == null ? undefined : req.body, signal, cache: 'no-store' });
        const body = await res.text().catch(() => '');
        return { ...N.interpretResponse(channel, { status: res.status, body }), status: res.status };
      });
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e) };
    }
  }
  const local = typeof notify === 'function'
    ? async digest => ({ ok: (await notify(N.format.headline(digest), N.format.summary(digest))) !== false, error: 'notifications are not supported here' })
    : undefined;

  /** One check. mode 'now': Send today's report now. Never runs twice at once. */
  function check(reason = 'timer', mode = 'scheduled') {
    if (running) return running;
    running = (async () => {
      const secrets = N.secretValues(store.getSettings()); // this check's secrets: redacted from everything kept or shown
      const res = await N.runDue({
        settings: store.getSettings(), state: store.getState(), now: now(), mode, runtime: 'desktop', ctx,
        watchlist: store.getWatchlist(), profiles: N.allProfiles(store.getProfiles()),
        loadMeta, loadData, send, local,
        persist: st => store.setState(st) // after every channel: a crash mid-run never resends
      });
      store.setState(res.state);
      const clean = v => (v == null ? v : N.redact(v, secrets));
      res.error = clean(res.error);
      for (const r of res.results) r.error = clean(r.error);
      last = { at: new Date(now()).toISOString(), reason: res.reason, error: res.error || null, results: res.results, trigger: reason };
      if (res.results.length || res.error) {
        const parts = res.results.map(r => `${r.id} ${r.status}${r.error ? ' (' + r.error + ')' : ''}`);
        log(`notifications (${reason}): ${res.reason}${res.error ? ' - ' + res.error : ''}${parts.length ? ': ' + parts.join(', ') : ''}`);
      }
      return res;
    })().finally(() => { running = null; });
    return running;
  }

  /** "Send test": the sample report to one channel, whatever the schedule; no state change. */
  async function sendTest(channel) {
    const v = N.validateChannel(channel);
    if (!v.ok) return { ok: false, error: v.errors.map(e => e.message).join(' ') };
    const r = await send(N.buildRequest(channel, N.sampleDigest(now()), ctx), N.normalizeChannel(channel));
    return { ...r, error: r.error == null ? r.error : N.redact(r.error, N.secretValues({ channels: [channel, ...store.getSettings().channels] })) };
  }

  /**
   * --notify-dry-run: today's report for every enabled channel, from live data and the saved settings, with each
   * channel's request (secrets redacted). Sends nothing and changes nothing.
   */
  async function dryRun() {
    const settings = store.getSettings();
    const state = store.getState();
    const meta = await loadMeta();
    const until = meta.last_run || new Date(now()).toISOString();
    const data = await loadData();
    const channels = settings.channels.filter(c => c.enabled).map(c => {
      const cs = state.channels[c.id] || {};
      const since = cs.through || new Date(Date.parse(until) - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const digest = N.buildDigest({ records: data.records, events: data.events, since, until, dataSince: data.dataSince, settings, watchlist: store.getWatchlist(), profiles: N.allProfiles(store.getProfiles()) });
      const valid = N.validateChannel(c);
      return {
        id: c.id, type: N.kindOf(c), name: c.name, since, until,
        due: N.channelDue(now(), settings.time, cs, 'scheduled'),
        valid: valid.ok ? true : valid.errors.map(e => `${e.field}: ${e.message}`),
        digest,
        request: digest && valid.ok ? N.redactRequest(N.buildRequest(c, digest, ctx), settings) : null
      };
    });
    return { enabled: settings.enabled, time: settings.time, liveBase, last_run: meta.last_run || null, data_version: meta.data_version || null, channels };
  }

  function status() {
    const s = store.getSettings();
    return { enabled: s.enabled, paused: !s.enabled, time: s.time, lastCheck: last.at, lastResult: last, state: store.getState(), running: !!running };
  }

  return { check, sendTest, dryRun, status, loadMeta, loadData };
}

module.exports = { createScheduler };
