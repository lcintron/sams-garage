/*
 * SAM's Garage notifications engine, shared by every place a daily report can be sent from (PLAN.md "Notifications").
 *
 * A CLASSIC script on purpose: no import/export statements, everything is assigned to globalThis.SgNotify. That lets
 * one file load in all four runtimes:
 *   - the page:            import './notify/core.js'                 (an ES module with a side effect)
 *   - the service worker:  importScripts('js/notify/core.js')        (sw.js stays a classic worker: module workers
 *                                                                      would break Firefox's offline support)
 *   - Electron's main:     electron/notify-core.js runs it with vm    (works whether or not site/package.json, which
 *                                                                      the installer leaves out, is there)
 *   - Node (Actions, tests): import                                   (scripts/notify.mjs, site/tests)
 *
 * Pure: no DOM, no fetch, no storage, no timers. The runtimes pass data and I/O in (runDue's loadMeta, loadData, send).
 *
 * Contents
 *   term matching      normalizeText, cleanTerm, findTerms, recordText (profiles.js uses these: one implementation)
 *   profiles           PRESET_PROFILES, parseTerms, normalizeProfile, allProfiles
 *   settings           defaultSettings, normalizeSettings, normalizeChannel, validateChannel, secrets, redaction
 *   digest             buildDigest, sampleDigest
 *   formatters         format.slack | discord | teams | whatsapp | whatsappTemplate | text | summary
 *   requests           buildRequest -> {url, method, headers, body, browserMode}, interpretResponse
 *   scheduling         localDate, isDue, channelDue, runDue
 */
(function (root) {
  'use strict';

  // The public app. scripts/site-url.sh rewrites this together with site/js/config.js PUBLIC_URL (tested to match).
  const PUBLIC_URL = 'https://lcintron.github.io/sams-garage/';
  // The site data format this engine reads (scraper/build.py SITE_FORMAT, site/js/data.js DATA_FORMAT).
  const DATA_FORMAT = 1;
  const APP_NAME = "SAM's Garage";
  const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';
  // The Graph API version for WhatsApp Cloud API messages. Meta supports each version for about two years: before
  // v21.0 is retired, bump it here after checking the /messages template request (buildRequest) against Meta's
  // changelog. Tests override the base URL, never the version.
  const GRAPH_VERSION = 'v21.0';
  const GRAPH_BASE = 'https://graph.facebook.com/' + GRAPH_VERSION + '/';
  const MAX_ITEMS = 15;          // per section
  const MAX_CHANNELS = 20;
  const LOCAL_ID = '__local';    // the OS notification of the device that runs the check (a pseudo-channel)
  const DAY_MS = 86400000;

  const TYPES = ['slack', 'discord', 'teams', 'whatsapp'];
  const PROVIDERS = { whatsapp: ['callmebot', 'cloud'] };
  // Fields of each channel kind. secret: kept on the device, masked in logs, never in the app's own URLs.
  const FIELDS = {
    slack: [{ key: 'url', secret: true }],
    discord: [{ key: 'url', secret: true }],
    teams: [{ key: 'url', secret: true }],
    'whatsapp:callmebot': [{ key: 'phone', secret: true }, { key: 'apikey', secret: true }],
    'whatsapp:cloud': [{ key: 'phoneNumberId', secret: true }, { key: 'accessToken', secret: true }, { key: 'to', secret: true },
      { key: 'template' }, { key: 'language' }]
  };
  const KIND_LABELS = {
    slack: 'Slack', discord: 'Discord', teams: 'Microsoft Teams',
    'whatsapp:callmebot': 'WhatsApp (CallMeBot)', 'whatsapp:cloud': 'WhatsApp (Cloud API)', local: 'This device'
  };
  // How a page or service worker can send each kind (see buildRequest).
  const BROWSER_MODES = { slack: 'no-cors', discord: 'cors', teams: 'unsupported', 'whatsapp:callmebot': 'no-cors', 'whatsapp:cloud': 'unsupported' };

  const SECTION_ORDER = ['starred', 'new', 'updated'];
  const SECTION_TITLES = { starred: 'Starred updates', new: 'New matches', updated: 'Updated matches' };
  const SECTION_NOUNS = { starred: ['starred update', 'starred updates'], new: ['new match', 'new matches'], updated: ['updated match', 'updated matches'] };
  const STATUS_LABELS = { open: 'Open', pre_release: 'Pre-release', forecasted: 'Forecasted', closed: 'Closed', unknown: 'Unknown' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…'; };
  const errText = e => clip((e && (e.message || e.code)) || String(e), 300);

  // ------------------------------------------------------------------------------------------------------------------
  // Term matching (moved here from profiles.js so the list, the reports and every runtime use one implementation)
  // ------------------------------------------------------------------------------------------------------------------

  /** Lowercase and fold hyphens/underscores/whitespace runs to single spaces, so "Counter-UAS" ≈ "counter uas". */
  function normalizeText(s) {
    return ' ' + String(s || '').toLowerCase().replace(/[‐-―−]/g, '-').replace(/[-_\s]+/g, ' ').trim() + ' ';
  }

  /** A term as it is matched: trimmed, lowercase, leading "#"s removed ("#Counter-UAS" -> "counter-uas"). */
  function cleanTerm(t) {
    return String(t == null ? '' : t).trim().replace(/^#+/, '').trim().toLowerCase();
  }

  const termCache = new Map();
  /** A regex that finds a term as a whole word or phrase inside normalizeText() output (null for an empty term). */
  function termRegex(term) {
    if (termCache.has(term)) return termCache.get(term);
    const t = normalizeText(cleanTerm(term)).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = t ? new RegExp('(?<![a-z0-9])' + t + '(?![a-z0-9])') : null;
    if (termCache.size > 5000) termCache.clear();
    termCache.set(term, re);
    return re;
  }

  /** Terms from `terms` that occur in the (already normalized) text, as given. */
  function findTerms(normText, terms) {
    return (terms || []).filter(t => { const re = t && termRegex(t); return !!re && re.test(normText); });
  }

  /**
   * The searchable text of a record: title, agency, sub-agency, topic and solicitation numbers, summary, description,
   * keywords and technology areas. `description` overrides rec.description (the list gets it from the search index).
   */
  function recordText(rec, description) {
    rec = rec || {};
    const join = v => (Array.isArray(v) ? v.join(' ') : v || '');
    return normalizeText([rec.title, rec.agency, rec.sub_agency, rec.topic_number, rec.solicitation_number, rec.summary,
      description != null ? description : rec.description, join(rec.keywords), join(rec.technology_areas)].filter(Boolean).join(' \n '));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Keyword profiles (definitions; the scoring stays in profiles.js)
  // ------------------------------------------------------------------------------------------------------------------

  const PRESET_PROFILES = Object.freeze([
    {
      id: 'uas', name: 'UAS', bonus: 3, preset: true,
      terms: ['uas', 'uav', 'unmanned aerial', 'uncrewed aerial', 'drone', 'drones', 'aerial system', 'autonomous air']
    },
    {
      id: 'cuas', name: 'Counter-UAS', bonus: 6, preset: true,
      terms: ['c-uas', 'cuas', 'counter-uas', 'counter uas', 'counter-unmanned', 'counter unmanned', 'counter-drone',
        'counter drone', 'drone detection', 'detect drones']
    },
    {
      id: 'acoustic', name: 'Acoustic', bonus: 3, preset: true,
      terms: ['acoustic', 'acoustics', 'audio', 'sound', 'sounds', 'sonar', 'microphone', 'passive sensing']
    }
  ].map(p => Object.freeze({ ...p, terms: Object.freeze(p.terms) })));

  /** Parse a free-form term list (commas, semicolons or new lines) into clean, deduplicated, lowercase terms. */
  function parseTerms(text) {
    const seen = new Set();
    for (const t of String(text || '').split(/[,\n;]+/)) {
      const v = cleanTerm(t);
      if (v) seen.add(v);
    }
    return [...seen];
  }

  /** Validate/normalize a user profile; null if unusable. */
  function normalizeProfile(p) {
    if (!isObj(p)) return null;
    const name = String(p.name || '').trim().slice(0, 40);
    const terms = Array.isArray(p.terms) ? parseTerms(p.terms.join(',')) : parseTerms(p.terms);
    if (!name || !terms.length || !/^u-[a-z0-9-]+$/.test(p.id || '')) return null;
    const bonus = Math.max(0, Math.min(10, parseInt(p.bonus, 10) || 0));
    return { id: p.id, name, terms: terms.slice(0, 100), bonus, preset: false };
  }

  /** Presets followed by the user's valid profiles. */
  function allProfiles(userProfiles) {
    return [...PRESET_PROFILES, ...(Array.isArray(userProfiles) ? userProfiles : []).map(normalizeProfile).filter(Boolean)];
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------------------------------------------------------

  /** Channel kind: slack | discord | teams | whatsapp:callmebot | whatsapp:cloud. */
  function kindOf(ch) {
    if (!ch) return '';
    if (ch.type === 'whatsapp') return 'whatsapp:' + (ch.provider === 'cloud' ? 'cloud' : 'callmebot');
    return ch.type === 'local' ? 'local' : TYPES.includes(ch.type) ? ch.type : '';
  }
  const kindLabel = ch => KIND_LABELS[kindOf(ch)] || 'Unknown';
  const browserMode = ch => BROWSER_MODES[kindOf(ch)] || 'unsupported';
  const fieldsOf = ch => FIELDS[kindOf(ch)] || [];

  function defaultSettings() {
    return {
      enabled: false, // opt-in: nothing is sent, and no OS notification shown, until notifications are switched on
      time: '08:00',
      channels: [],
      triggers: { profiles: [], keywords: [], newMatches: true, updatedMatches: true, starred: true },
      lastSent: { date: null, at: null },
      background: { tray: true, browser: true, osNotification: true }
    };
  }

  /** A channel with known fields only (unknown keys dropped, strings trimmed). null for an unknown type. */
  function normalizeChannel(c, index) {
    if (!isObj(c) || !TYPES.includes(c.type)) return null;
    const out = {
      id: /^[A-Za-z0-9_-]{1,40}$/.test(c.id || '') && c.id !== LOCAL_ID ? c.id : 'c' + (index == null ? 0 : index),
      type: c.type
    };
    if (c.type === 'whatsapp') out.provider = c.provider === 'cloud' ? 'cloud' : 'callmebot';
    out.name = str(c.name, 60) || KIND_LABELS[kindOf(out)];
    out.enabled = c.enabled !== false;
    for (const f of FIELDS[kindOf(out)]) out[f.key] = str(c[f.key], f.key === 'accessToken' ? 4000 : 2000);
    if (kindOf(out) === 'whatsapp:cloud' && !out.language) out.language = 'en_US';
    return out;
  }

  function cleanKeywords(list) {
    const out = [], seen = new Set();
    for (const k of Array.isArray(list) ? list : []) {
      const v = str(k, 60).replace(/\s+/g, ' ');
      const key = normalizeText(cleanTerm(v)).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
      if (out.length >= 100) break;
    }
    return out;
  }

  /** Settings in the one shape every runtime uses (see defaultSettings); anything malformed falls back to defaults. */
  function normalizeSettings(s) {
    const d = defaultSettings();
    if (!isObj(s)) return d;
    const t = isObj(s.triggers) ? s.triggers : {};
    const b = isObj(s.background) ? s.background : {};
    const ls = isObj(s.lastSent) ? s.lastSent : {};
    const channels = [];
    const ids = new Set();
    (Array.isArray(s.channels) ? s.channels : []).forEach((c, i) => {
      const n = normalizeChannel(c, i);
      if (!n || channels.length >= MAX_CHANNELS) return;
      while (ids.has(n.id)) n.id = n.id + '-' + i;
      ids.add(n.id);
      channels.push(n);
    });
    return {
      enabled: s.enabled === true,
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') ? s.time : d.time,
      channels,
      triggers: {
        profiles: [...new Set((Array.isArray(t.profiles) ? t.profiles : []).filter(p => typeof p === 'string' && /^[a-z0-9-]{1,60}$/.test(p)))].slice(0, 50),
        keywords: cleanKeywords(t.keywords),
        newMatches: t.newMatches !== false,
        updatedMatches: t.updatedMatches !== false,
        starred: t.starred !== false
      },
      lastSent: { date: typeof ls.date === 'string' ? ls.date : null, at: typeof ls.at === 'string' ? ls.at : null },
      background: { tray: b.tray !== false, browser: b.browser !== false, osNotification: b.osNotification !== false }
    };
  }

  const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
  const DIGITS_PHONE = v => String(v || '').replace(/[\s().-]/g, '');

  /**
   * Check a channel's fields. Returns { ok, errors: [{field, message}], warnings: [string] }. Webhook URLs must be
   * https (http only on this machine, for local testing); a host that does not look like the platform's is a warning.
   */
  function validateChannel(c) {
    const ch = normalizeChannel(c);
    const errors = [], warnings = [];
    if (!ch) return { ok: false, errors: [{ field: 'type', message: 'Unknown channel type.' }], warnings };
    const kind = kindOf(ch);
    const need = (field, ok, message) => { if (!ok) errors.push({ field, message }); };
    if (kind === 'slack' || kind === 'discord' || kind === 'teams') {
      let u = null;
      try { u = new URL(ch.url); } catch (e) { /* below */ }
      need('url', !!u, 'Paste the full webhook URL.');
      if (u) {
        need('url', u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname)), 'The webhook URL must start with https://.');
        const host = u.hostname.toLowerCase();
        if (kind === 'slack' && host !== 'hooks.slack.com' && !LOOPBACK.test(host)) warnings.push('Slack webhook URLs usually start with https://hooks.slack.com/.');
        if (kind === 'discord' && !(/(^|\.)discord(app)?\.com$/.test(host) && u.pathname.startsWith('/api/webhooks/')) && !LOOPBACK.test(host)) warnings.push('Discord webhook URLs usually start with https://discord.com/api/webhooks/.');
        if (kind === 'teams') {
          need('url', !/webhook\.office\.com$|outlook\.office(365)?\.com$/.test(host), 'That is an Office 365 connector URL; connectors are retired. Create a Workflows webhook instead.');
          if (!/(logic\.azure\.com|powerplatform\.com|powerautomate\.com)$/.test(host) && !LOOPBACK.test(host)) warnings.push('Teams Workflows URLs usually end in logic.azure.com or powerplatform.com.');
        }
      }
    } else if (kind === 'whatsapp:callmebot') {
      need('phone', /^\+?\d{6,15}$/.test(DIGITS_PHONE(ch.phone)), 'Phone number with country code, e.g. +15551234567.');
      need('apikey', /^[A-Za-z0-9]{3,64}$/.test(ch.apikey), 'The API key CallMeBot sent you.');
    } else if (kind === 'whatsapp:cloud') {
      need('phoneNumberId', /^\d{5,30}$/.test(ch.phoneNumberId), 'The Phone number ID from the WhatsApp API setup page (digits).');
      need('accessToken', ch.accessToken.length >= 20 && !/\s/.test(ch.accessToken), 'A WhatsApp Cloud API access token.');
      need('to', /^\+?\d{6,15}$/.test(DIGITS_PHONE(ch.to)), 'Recipient number with country code.');
      need('template', /^[a-z0-9_]{1,512}$/.test(ch.template), 'The approved template name (lowercase, digits, underscores).');
      need('language', /^[a-z]{2,3}(_[A-Z]{2})?$/.test(ch.language), 'The template language code, e.g. en_US.');
    }
    return { ok: !errors.length, errors, warnings };
  }

  /** Every secret value in some settings (with their URL-encoded forms), for masking. Longest first. */
  function secretValues(settings) {
    const out = new Set();
    const chans = isObj(settings) && Array.isArray(settings.channels) ? settings.channels : [];
    chans.forEach((c, i) => {
      const ch = normalizeChannel(c, i);
      if (!ch) return;
      for (const f of fieldsOf(ch)) {
        if (!f.secret || !ch[f.key] || ch[f.key].length < 3) continue;
        out.add(ch[f.key]);
        out.add(encodeURIComponent(ch[f.key]));
        if (f.key === 'phone' || f.key === 'to') { out.add(DIGITS_PHONE(ch[f.key])); out.add(encodeURIComponent(DIGITS_PHONE(ch[f.key]))); }
      }
    });
    return [...out].filter(v => v.length >= 3).sort((a, b) => b.length - a.length);
  }

  /** Replace every secret value in a string. */
  function redact(text, secrets) {
    let s = String(text == null ? '' : text);
    for (const v of secrets || []) if (v) s = s.split(v).join('[redacted]');
    return s;
  }

  /** A copy of a request that is safe to print: secret values and the Authorization header replaced. */
  function redactRequest(req, settingsOrChannel) {
    const secrets = secretValues(isObj(settingsOrChannel) && Array.isArray(settingsOrChannel.channels) ? settingsOrChannel : { channels: [settingsOrChannel] });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[k] = /^authorization$/i.test(k) ? '[redacted]' : redact(v, secrets);
    return { ...req, url: redact(req.url, secrets), headers, body: req.body == null ? req.body : redact(req.body, secrets) };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Digest
  // ------------------------------------------------------------------------------------------------------------------

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** The terms the triggers name: keywords as typed, then the terms of the chosen profiles; deduplicated. */
  function triggerTerms(settings, profiles) {
    const t = normalizeSettings(settings).triggers;
    const byId = new Map((Array.isArray(profiles) ? profiles : PRESET_PROFILES).map(p => [p.id, p]));
    const out = [], seen = new Set();
    const add = term => {
      const key = normalizeText(cleanTerm(term)).trim();
      if (key && !seen.has(key)) { seen.add(key); out.push(term); }
    };
    t.keywords.forEach(add);
    for (const id of t.profiles) for (const term of (byId.get(id) || {}).terms || []) add(term);
    return out;
  }

  /** The trigger terms a record matches (as given). */
  function matchRecord(rec, terms) {
    return terms.length ? findTerms(recordText(rec), terms) : [];
  }

  const byClose = (a, b) => (a.close_date || '9999') < (b.close_date || '9999') ? -1 : (a.close_date || '9999') > (b.close_date || '9999') ? 1
    : String(a.title).localeCompare(String(b.title)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** One item: the record's display fields and what changed (from the record's events in the window, oldest first). */
  function digestItem(rec, evs, kind, matched) {
    const status = evs.filter(e => e.event === 'status');
    const fields = [...new Set(evs.filter(e => e.event === 'updated').flatMap(e => (Array.isArray(e.fields) ? e.fields : [])))];
    let event, from = null, to = null;
    if (kind === 'new') { event = 'new'; to = rec.status || null; }
    else if (status.length) { event = 'status'; from = status[0].from ?? null; to = status[status.length - 1].to ?? null; }
    else if (evs.some(e => e.event === 'updated')) event = 'updated';
    else { event = 'missing'; const m = evs.find(e => e.event === 'missing'); from = m ? m.from ?? null : null; }
    return {
      id: rec.id, title: rec.title || rec.id, agency: rec.agency || null, sub_agency: rec.sub_agency || null,
      topic_number: rec.topic_number || null, status: rec.status || null, close_date: rec.close_date || null,
      matched, event, from, to, fields,
      missing: event !== 'missing' && evs.some(e => e.event === 'missing') // also no longer listed by its source
    };
  }

  /**
   * The report for a window of changelog events, or null when there is nothing to report.
   * @param {{records: Array, events: Array, since?: string|number|null, until?: string|number|null, settings: object,
   *          watchlist?: string[], profiles?: Array}} o
   *   records: catalog-like records (with description when available); events: changelog events
   *   {at, id, event, from, to, fields?}; the window is since < at <= until (either end open when null); ids absorbed
   *   by another record (alt_ids) resolve to that record, in events and in the watchlist; profiles: every profile the
   *   triggers may name (default: the presets); dataSince: where the events given start (changes.json "since"): a
   *   window that starts earlier sets `partial`, and the report says that some earlier changes are not included.
   * @returns {null | {sections: [{kind, title, total, more, items}], counts: {starred, new, updated, total}, since, until}}
   *   A topic appears once, in its highest-priority section: starred > new > updated. Each section lists at most 15.
   */
  function buildDigest(o) {
    o = o || {};
    const settings = normalizeSettings(o.settings);
    const tr = settings.triggers;
    const byId = new Map(), owner = new Map();
    for (const r of o.records || []) if (r && r.id) { byId.set(r.id, r); owner.set(r.id, r.id); }
    for (const r of byId.values()) for (const alt of r.alt_ids || []) if (!owner.has(alt)) owner.set(alt, r.id);
    const since = toMs(o.since), until = toMs(o.until), dataSince = toMs(o.dataSince);
    const watch = new Set();
    for (const id of o.watchlist || []) { const now = owner.get(id); if (now) watch.add(now); }
    const terms = triggerTerms(settings, o.profiles);

    const per = new Map();
    for (const e of o.events || []) {
      if (!e || !e.event) continue;
      const t = toMs(e.at);
      if (t == null || (since != null && t <= since) || (until != null && t > until)) continue;
      const id = owner.get(e.id);
      if (!id) continue;
      if (!per.has(id)) per.set(id, []);
      per.get(id).push(e);
    }

    const sections = { starred: [], new: [], updated: [] };
    for (const [id, evs] of per) {
      evs.sort((a, b) => toMs(a.at) - toMs(b.at));
      const rec = byId.get(id);
      const kinds = new Set(evs.map(e => e.event));
      const changed = kinds.has('status') || kinds.has('updated');
      let kind = null;
      if (tr.starred && watch.has(id) && (changed || kinds.has('missing'))) kind = 'starred';
      const wantsMatch = kind || (tr.newMatches && kinds.has('new')) || (tr.updatedMatches && changed);
      const matched = wantsMatch ? matchRecord(rec, terms) : [];
      if (!kind && matched.length) {
        if (tr.newMatches && kinds.has('new')) kind = 'new';
        else if (tr.updatedMatches && changed) kind = 'updated';
      }
      if (kind) sections[kind].push(digestItem(rec, evs, kind, matched));
    }

    const counts = { starred: sections.starred.length, new: sections.new.length, updated: sections.updated.length, total: 0 };
    counts.total = counts.starred + counts.new + counts.updated;
    if (!counts.total) return null;
    return {
      sections: SECTION_ORDER.filter(k => sections[k].length).map(k => {
        const items = sections[k].sort(byClose);
        return { kind: k, title: SECTION_TITLES[k], total: items.length, more: Math.max(0, items.length - MAX_ITEMS), items: items.slice(0, MAX_ITEMS) };
      }),
      counts,
      since: since == null ? null : iso(since),
      until: until == null ? null : iso(until),
      // the window starts before the oldest event the data holds (changes.json keeps 30 days): say so in the report
      partial: since != null && dataSince != null && since < dataSince
    };
  }

  /** A small fixed report for "Send test". */
  function sampleDigest(now) {
    const until = iso(toMs(now) == null ? Date.now() : toMs(now));
    const item = (id, title, extra) => ({ id, title, agency: 'DOD', sub_agency: 'ARMY', topic_number: null, status: 'open', close_date: null, matched: [], fields: [], from: null, to: null, ...extra });
    return {
      test: true,
      sections: [
        { kind: 'starred', title: SECTION_TITLES.starred, total: 1, more: 0, items: [item('test:1', 'Test message: a starred topic changed status', { event: 'status', from: 'pre_release', to: 'open' })] },
        { kind: 'new', title: SECTION_TITLES.new, total: 1, more: 0, items: [item('test:2', 'Test message: a new topic matching your keywords', { event: 'new', to: 'open', matched: ['example'] })] }
      ],
      counts: { starred: 1, new: 1, updated: 0, total: 2 },
      since: null,
      until
    };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Formatters
  // ------------------------------------------------------------------------------------------------------------------

  /** A shareable link to a topic: <base>#/s/<id> (same as site/js/config.js topicLink; tested to match). */
  function topicLink(base, id) {
    return base + '#/s/' + encodeURIComponent(id).replace(/%3A/gi, ':');
  }
  const baseOf = ctx => {
    const b = (ctx && ctx.publicUrl) || PUBLIC_URL;
    return b.endsWith('/') ? b : b + '/';
  };
  const linkFor = (ctx, it) => (/^test:/.test(it.id) ? baseOf(ctx) : topicLink(baseOf(ctx), it.id));
  const sectionLink = (ctx, kind) => baseOf(ctx) + (kind === 'starred' ? '#/watch' : '#/');
  const settingsLink = ctx => baseOf(ctx) + '#/notify';

  /** "2026-11-12" -> "Nov 12, 2026" (no locale, the same in every runtime). */
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? `${MONTHS[+m[2] - 1] || m[2]} ${+m[3]}, ${m[1]}` : '';
  }
  const statusLabel = s => STATUS_LABELS[s] || (s ? String(s) : 'Unknown');

  /** "2 new matches, 1 starred update" */
  function countPhrase(d) {
    return SECTION_ORDER.filter(k => d.counts[k]).map(k => `${d.counts[k]} ${SECTION_NOUNS[k][d.counts[k] === 1 ? 0 : 1]}`).join(', ');
  }
  const headline = d => (d.test ? 'Test message from ' + APP_NAME : APP_NAME + ': ' + countPhrase(d));
  const throughLine = d => (d.until ? 'Changes through ' + fmtDate(d.until) : '');
  const PARTIAL_NOTE = 'Some earlier changes are not included; open the app for the full history.';

  /** What changed, in words. */
  function changeText(it) {
    if (it.event === 'new') return 'New · ' + statusLabel(it.to || it.status);
    if (it.event === 'status') return `Status: ${statusLabel(it.from)} → ${statusLabel(it.to)}`;
    if (it.event === 'updated') return 'Updated' + (it.fields && it.fields.length ? ': ' + it.fields.map(f => String(f).replace(/_/g, ' ')).join(', ') : '') + (it.missing ? '; no longer listed by its source' : '');
    return 'No longer listed by its source';
  }
  /** Agency, topic number and close date. */
  function metaText(it) {
    return [[it.agency, it.sub_agency].filter(Boolean).join('/'), it.topic_number, it.close_date ? 'closes ' + fmtDate(it.close_date) : '']
      .filter(Boolean).join(' · ');
  }
  const matchedText = it => (it.matched && it.matched.length ? 'matched: ' + it.matched.join(', ') : '');
  const detailLine = it => [changeText(it), metaText(it), matchedText(it)].filter(Boolean).join(' · ');

  /** Short text for an OS notification. */
  function summary(d) {
    if (!d) return '';
    const titles = d.sections.flatMap(s => s.items).map(it => clip(it.title, 60));
    const shown = titles.slice(0, 3);
    const rest = d.counts.total - shown.length;
    return clip(countPhrase(d) + (shown.length ? ': ' + shown.join('; ') + (rest > 0 ? ` and ${rest} more` : '') : ''), 240);
  }

  // ---- Slack (mrkdwn; 50 blocks; 3000 characters per section text) ----
  const slackEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const SLACK_BLOCKS = 50, SLACK_TEXT = 3000;

  function slack(d, ctx) {
    const mr = text => ({ type: 'mrkdwn', text });
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: clip(d.test ? 'Test message from ' + APP_NAME : APP_NAME + ' daily report', 150), emoji: false } },
      { type: 'context', elements: [mr(slackEsc(clip([countPhrase(d), throughLine(d)].filter(Boolean).join(' · '), 2900)))] }
    ];
    if (d.partial) blocks.push({ type: 'context', elements: [mr(`_${slackEsc(PARTIAL_NOTE)}_ <${baseOf(ctx)}|Open ${slackEsc(APP_NAME)}>`)] });
    const tail = [{ type: 'divider' }, { type: 'context', elements: [mr(`<${baseOf(ctx)}|Open ${slackEsc(APP_NAME)}> · <${settingsLink(ctx)}|Notification settings>`)] }];
    const body = [];
    for (const sec of d.sections) {
      body.push({ type: 'section', text: mr(`*${slackEsc(sec.title)} (${sec.total})*`) });
      let buf = '';
      const flush = () => { if (buf) body.push({ type: 'section', text: mr(buf) }); buf = ''; };
      for (const it of sec.items) {
        const piece = clip(`<${linkFor(ctx, it)}|${slackEsc(clip(it.title, 250))}>\n${slackEsc(clip(detailLine(it), 600))}`, SLACK_TEXT);
        if (buf && buf.length + 2 + piece.length > SLACK_TEXT) flush();
        buf = buf ? buf + '\n\n' + piece : piece;
      }
      flush();
      if (sec.more) body.push({ type: 'context', elements: [mr(`and ${sec.more} more: <${sectionLink(ctx, sec.kind)}|open ${slackEsc(APP_NAME)}>`)] });
    }
    const room = SLACK_BLOCKS - blocks.length - tail.length;
    if (body.length > room) {
      body.length = room - 1;
      body.push({ type: 'context', elements: [mr(`The report is longer than Slack shows: <${baseOf(ctx)}|open ${slackEsc(APP_NAME)}> for the rest.`)] });
    }
    return { text: clip(`${headline(d)} — ${baseOf(ctx)}`, 3000), blocks: [...blocks, ...body, ...tail] };
  }

  // ---- Discord (embeds: 10 per message, 4096-character descriptions, 6000 characters in all) ----
  const discordEsc = s => String(s == null ? '' : s).replace(/([\\*_~`|[\]()<>])/g, '\\$1').replace(/@/g, '@\u200b');
  const DISCORD_EMBEDS = 10, DISCORD_DESC = 4096, DISCORD_TOTAL = 6000;
  const COLORS = { starred: 0xf2b84b, new: 0x1db3a9, updated: 0x7aa2ff };

  function discord(d, ctx) {
    const footer = { text: clip([APP_NAME, throughLine(d)].filter(Boolean).join(' · '), 200) };
    const secs = d.sections.map(sec => ({
      sec, title: clip(`${sec.title} (${sec.total})`, 256),
      lines: sec.items.map(it => clip(`**[${discordEsc(clip(it.title, 200))}](${linkFor(ctx, it)})**\n${discordEsc(clip(detailLine(it), 400))}`, 1000))
    }));
    const moreLine = (n, kind) => `…and ${n} more in [${APP_NAME}](${sectionLink(ctx, kind)})`;
    // What every section needs at least: its title, and room for an "and N more" line. The rest is shared by items.
    let budget = DISCORD_TOTAL - footer.text.length - secs.reduce((n, s) => n + s.title.length + 80, 0) - 40;
    const embeds = [];
    for (const s of secs) {
      const parts = [];
      let desc = '', shown = 0;
      for (const line of s.lines) {
        const need = line.length + 2;
        if (need > budget) break;
        if (desc && desc.length + need > DISCORD_DESC - 100) {
          if (embeds.length + parts.length + 1 >= DISCORD_EMBEDS - (secs.length - secs.indexOf(s) - 1)) break;
          parts.push(desc); desc = '';
        }
        desc = desc ? desc + '\n\n' + line : line;
        budget -= need;
        shown++;
      }
      const more = s.sec.total - shown;
      if (more > 0) desc = (desc ? desc + '\n\n' : '') + moreLine(more, s.sec.kind);
      parts.push(desc);
      parts.forEach((p, i) => embeds.push(Object.assign(i === 0 ? { title: s.title, url: sectionLink(ctx, s.sec.kind) } : {}, { description: p, color: COLORS[s.sec.kind] })));
    }
    embeds.length = Math.min(embeds.length, DISCORD_EMBEDS);
    embeds[embeds.length - 1].footer = footer;
    return {
      username: APP_NAME,
      avatar_url: baseOf(ctx) + 'icons/icon-192.png',
      content: clip(`**${discordEsc(headline(d))}** · <${baseOf(ctx)}>` + (d.partial ? `\n*${PARTIAL_NOTE}*` : ''), 2000),
      embeds,
      allowed_mentions: { parse: [] }
    };
  }

  // ---- Microsoft Teams (Adaptive Card 1.4 through a Workflows webhook) ----
  const teamsEsc = s => String(s == null ? '' : s).replace(/\[/g, '(').replace(/\]/g, ')').replace(/[*_]/g, ' ').replace(/\s{2,}/g, ' ');

  // A Workflows webhook takes about 28 KB; the card stays under TEAMS_BYTES (UTF-8) and says "and N more" past it.
  const TEAMS_BYTES = 24000;
  const utf8Len = s => (typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length);

  function teams(d, ctx) {
    const body = [
      { type: 'TextBlock', text: d.test ? 'Test message from ' + APP_NAME : APP_NAME + ' daily report', size: 'Large', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: [countPhrase(d), throughLine(d)].filter(Boolean).join(' · '), isSubtle: true, spacing: 'None', wrap: true }
    ];
    if (d.partial) body.push({ type: 'TextBlock', text: PARTIAL_NOTE, isSubtle: true, wrap: true, spacing: 'Small' });
    const moreBlock = (n, kind) => ({ type: 'TextBlock', text: `…and ${n} more in [${APP_NAME}](${sectionLink(ctx, kind)})`, wrap: true, isSubtle: true });
    const size = v => utf8Len(JSON.stringify(v)) + 1;
    const MORE_RESERVE = 300; // room kept for each section's "and N more" line
    let used = size(card([...body], ctx)) + MORE_RESERVE * d.sections.length;
    for (const sec of d.sections) {
      const title = { type: 'TextBlock', text: `${sec.title} (${sec.total})`, weight: 'Bolder', size: 'Medium', separator: true, spacing: 'Medium', wrap: true };
      body.push(title);
      used += size(title);
      let shown = 0;
      for (const it of sec.items) {
        const pair = [
          { type: 'TextBlock', text: `[${teamsEsc(clip(it.title, 250))}](${linkFor(ctx, it)})`, wrap: true, spacing: 'Small' },
          { type: 'TextBlock', text: teamsEsc(clip(detailLine(it), 600)), isSubtle: true, size: 'Small', wrap: true, spacing: 'None' }
        ];
        const cost = size(pair[0]) + size(pair[1]);
        if (used + cost > TEAMS_BYTES) break;
        body.push(...pair);
        used += cost;
        shown++;
      }
      if (sec.total > shown) body.push(moreBlock(sec.total - shown, sec.kind));
    }
    return card(body, ctx);
  }

  function card(body, ctx) {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body,
          actions: [
            { type: 'Action.OpenUrl', title: 'Open ' + APP_NAME, url: baseOf(ctx) },
            { type: 'Action.OpenUrl', title: 'Notification settings', url: settingsLink(ctx) }
          ],
          msteams: { width: 'Full' }
        }
      }]
    };
  }

  // ---- WhatsApp: CallMeBot plain text (≤ 1500 characters, ends with the app link) ----
  const WHATSAPP_MAX = 1500;

  function whatsapp(d, ctx) {
    const end = `\n\nOpen ${APP_NAME}: ${baseOf(ctx)}`;
    let out = `*${headline(d)}*` + (throughLine(d) ? '\n' + throughLine(d) : '') + (d.partial ? `\n_${PARTIAL_NOTE}_` : '');
    let full = true;
    for (const sec of d.sections) {
      const head = `\n\n*${sec.title} (${sec.total})*`;
      const moreReserve = 40;
      if (out.length + head.length + end.length + moreReserve > WHATSAPP_MAX) { full = false; break; }
      out += head;
      let shown = 0;
      for (const it of sec.items) {
        const line = `\n• ${clip(it.title, 120)} — ${clip(detailLine(it), 160)}\n  ${linkFor(ctx, it)}`;
        if (out.length + line.length + end.length + moreReserve > WHATSAPP_MAX) break;
        out += line;
        shown++;
      }
      if (sec.total > shown) out += `\n…and ${sec.total - shown} more`;
    }
    if (!full) out += '\n\n…more in the app';
    return clip(out, WHATSAPP_MAX - end.length) + end;
  }

  // ---- WhatsApp Cloud API: the template's one body parameter (≤ 1000 characters, one line, ends with the link) ----
  const TEMPLATE_MAX = 1000;

  function whatsappTemplate(d, ctx) {
    const link = ` More: ${baseOf(ctx)}`;
    const oneLine = s => String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
    let out = oneLine(d.test ? 'Test message from ' + APP_NAME + '.' : countPhrase(d) + '.' + (d.partial ? ' ' + PARTIAL_NOTE : ''));
    const room = TEMPLATE_MAX - link.length;
    let shown = 0;
    for (const sec of d.sections) {
      for (const it of sec.items) {
        const piece = ' ' + oneLine(`${sec.kind === 'starred' ? '★ ' : ''}${clip(it.title, 90)} (${changeText(it)});`);
        if (out.length + piece.length + 20 > room) break;
        out += piece;
        shown++;
      }
    }
    const rest = d.counts.total - shown;
    if (rest > 0) out += ` …and ${rest} more.`;
    return clip(out, room) + link;
  }

  /** Plain text (logs, the dry run). */
  function text(d, ctx) {
    const lines = [headline(d), throughLine(d), d.partial ? PARTIAL_NOTE : ''].filter(Boolean);
    for (const sec of d.sections) {
      lines.push('', `${sec.title} (${sec.total})`);
      for (const it of sec.items) lines.push(`- ${it.title}`, `  ${detailLine(it)}`, `  ${linkFor(ctx, it)}`);
      if (sec.more) lines.push(`  …and ${sec.more} more`);
    }
    lines.push('', `Open ${APP_NAME}: ${baseOf(ctx)}`);
    return lines.join('\n');
  }

  const format = { slack, discord, teams, whatsapp, whatsappTemplate, text, summary, headline, detail: detailLine };

  // ------------------------------------------------------------------------------------------------------------------
  // Requests
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * The HTTP request that delivers a report to a channel: {url, method, headers, body, browserMode}.
   * browserMode says whether and how a page or service worker can send it:
   *   cors        a normal fetch (Discord answers CORS requests)
   *   no-cors     an opaque fetch: only "simple" requests, so Slack gets its JSON as a form field (payload=<json>,
   *               which Slack webhooks accept) and CallMeBot is a GET; the answer cannot be read
   *   unsupported a browser cannot send it (Teams Workflows and the Graph API need headers or answer without CORS):
   *               the desktop app and GitHub Actions only
   * ctx: { publicUrl, callmebotUrl, graphBase } (the last two only for tests).
   */
  function buildRequest(channel, digest, ctx) {
    ctx = ctx || {};
    const ch = normalizeChannel(channel);
    const kind = kindOf(ch);
    const mode = browserMode(ch);
    const json = { 'Content-Type': 'application/json' };
    switch (kind) {
      case 'slack':
        return { url: ch.url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'payload=' + encodeURIComponent(JSON.stringify(slack(digest, ctx))), browserMode: mode };
      case 'discord':
        return { url: ch.url, method: 'POST', headers: json, body: JSON.stringify(discord(digest, ctx)), browserMode: mode };
      case 'teams':
        return { url: ch.url, method: 'POST', headers: json, body: JSON.stringify(teams(digest, ctx)), browserMode: mode };
      case 'whatsapp:callmebot': {
        const base = ctx.callmebotUrl || CALLMEBOT_URL;
        const url = base + (base.includes('?') ? '&' : '?') + 'phone=' + encodeURIComponent(DIGITS_PHONE(ch.phone)) +
          '&text=' + encodeURIComponent(whatsapp(digest, ctx)) + '&apikey=' + encodeURIComponent(ch.apikey);
        return { url, method: 'GET', headers: {}, body: null, browserMode: mode };
      }
      case 'whatsapp:cloud': {
        const base = ctx.graphBase || GRAPH_BASE;
        return {
          url: (base.endsWith('/') ? base : base + '/') + encodeURIComponent(ch.phoneNumberId) + '/messages',
          method: 'POST',
          headers: { ...json, Authorization: 'Bearer ' + ch.accessToken },
          body: JSON.stringify({
            messaging_product: 'whatsapp', recipient_type: 'individual', to: DIGITS_PHONE(ch.to).replace(/^\+/, ''), type: 'template',
            template: { name: ch.template, language: { code: ch.language || 'en_US' },
              components: [{ type: 'body', parameters: [{ type: 'text', text: whatsappTemplate(digest, ctx) }] }] }
          }),
          browserMode: mode
        };
      }
      default:
        throw new Error('Unknown channel type: ' + (channel && channel.type));
    }
  }

  const CALLMEBOT_FAILURE = /\bAPI ?Key (?:is )?(?:invalid|not valid|wrong|incorrect)\b|\b(?:invalid|wrong|incorrect) API ?key\b|\bphone(?: number)? (?:is )?not (?:registered|valid|activated|allowed)\b|\bnot (?:yet )?(?:registered|activated)\b|\byou need to (?:get|activate)\b/i;

  /** Whether a platform's answer means the message went out: { ok, error }. opaque: a no-cors answer (unknown). */
  function interpretResponse(channel, res) {
    res = res || {};
    if (res.opaque) return { ok: true, error: null };
    const status = Number(res.status) || 0;
    const body = String(res.body || '').slice(0, 2000);
    if (status < 200 || status >= 300) return { ok: false, error: clip(`HTTP ${status || 'error'}${body ? ': ' + body.replace(/\s+/g, ' ') : ''}`, 300) };
    if (kindOf(channel) === 'whatsapp:callmebot') {
      // CallMeBot answers 200 with an HTML page either way. Only its own wording for a bad key or an unknown phone, at
      // the start of the page, means not sent: the rest of a page may well contain words like "error".
      const head = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (CALLMEBOT_FAILURE.test(head)) return { ok: false, error: clip('CallMeBot: ' + head, 300) };
    }
    return { ok: true, error: null };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------------------------------------------------------

  const pad = n => String(n).padStart(2, '0');
  /** Calendar fields of a moment: local time, or UTC + tzOffset minutes when given (tests, Actions). */
  function fields(now, tzOffset) {
    const ms = toMs(now) == null ? Date.now() : toMs(now);
    if (typeof tzOffset === 'number') {
      const t = new Date(ms + tzOffset * 60000);
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
    }
    const t = new Date(ms);
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), min: t.getHours() * 60 + t.getMinutes() };
  }
  /** The local calendar date of a moment, "YYYY-MM-DD" (DST-safe: from the calendar fields, never by adding hours). */
  function localDate(now, tzOffset) {
    const f = fields(now, tzOffset);
    return `${f.y}-${pad(f.m)}-${pad(f.d)}`;
  }
  /** The date before a "YYYY-MM-DD" date (pure calendar arithmetic). */
  function prevDate(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d - 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const minutesOf = time => { const m = /^(\d{1,2}):(\d{2})$/.exec(time || ''); return m ? +m[1] * 60 + +m[2] : 8 * 60; };
  /** The report slot a check belongs to: today's once the time has come, else yesterday's. */
  function slotDate(now, time, tzOffset) {
    const f = fields(now, tzOffset);
    const today = `${f.y}-${pad(f.m)}-${pad(f.d)}`;
    return f.min >= minutesOf(time) ? today : prevDate(today);
  }

  /**
   * Whether a report is due. One report per local calendar day, at or after the configured time; a slot that was
   * never checked (the device was off) is caught up at the next check, even before today's time.
   * @param now Date | ms | ISO
   * @param opts {time: 'HH:MM', tzOffset?: minutes east of UTC (default: the Date's local time zone)}
   * @param last the date of the last report ("YYYY-MM-DD") or null; or a channel state {date, slot}: date = the
   *   last day a report was sent, slot = the last report slot that was checked (sent or found nothing new)
   * After the time, a slot that was checked without sending stays due (cheap: the runtimes compare meta.last_run
   * first), so data published later that day is still reported that day.
   */
  function isDue(now, opts, last) {
    opts = opts || {};
    const st = isObj(last) ? last : { date: last || null, slot: last || null };
    const today = localDate(now, opts.tzOffset);
    // A report dated today, or later: the clock moved backwards (a manual change, a bad RTC, a VM snapshot). Sending
    // again would break "never twice a day"; wait until the clock passes that date again.
    if (st.date && st.date >= today) return false;
    const slot = slotDate(now, opts.time, opts.tzOffset);
    if (st.slot && st.slot >= slot) return slot === today; // checked already: keep watching today, never yesterday again
    return true;
  }

  /**
   * isDue plus the retry rule for one channel: a send that failed today is retried once, at the next check.
   * mode 'now' (Send now) ignores the time and the retry cap, but still never sends twice on one date.
   */
  function channelDue(now, time, cs, mode, tzOffset) {
    cs = cs || {};
    const today = localDate(now, tzOffset);
    if (cs.date && cs.date >= today) return false; // sent today (or "later": the clock moved backwards, see isDue)
    if (mode === 'now') return true;
    if (cs.failDate === today) return (cs.tries || 0) < 2;
    return isDue(now, { time, tzOffset }, cs);
  }

  function cloneState(s) {
    s = isObj(s) ? s : {};
    const channels = {};
    for (const [k, v] of Object.entries(isObj(s.channels) ? s.channels : {})) if (isObj(v)) channels[k] = { ...v };
    return {
      channels,
      lastSent: isObj(s.lastSent) ? { date: s.lastSent.date || null, at: s.lastSent.at || null } : { date: null, at: null },
      lastReport: isObj(s.lastReport) ? s.lastReport : null,
      lastCheck: s.lastCheck || null
    };
  }

  /**
   * Check every channel and send the report where it is due. All I/O comes in:
   * @param {{settings, state, now?, tzOffset?, mode?: 'scheduled'|'now', runtime?: 'browser'|'desktop'|'actions',
   *          channelIds?: string[], watchlist?: string[], profiles?: Array, ctx?: object,
   *          loadMeta: () => Promise<{last_run}>, loadData: (meta) => Promise<{records, events, dataSince?}>,
   *          send: (request, channel) => Promise<{ok, status?, error?, opaque?}>,
   *          local?: (digest) => Promise<{ok, error?}>, persist?: (state) => Promise|void,
   *          beforeSend?: (channel) => Promise<boolean>}} o
   *   local: the device's own notification, checked like a channel (id "__local") when given
   *   persist: stores the run state; called after every channel's result, so a crash or a closed tab in the middle of
   *   a run never makes the channels that were already sent go out again
   *   beforeSend: called before each send (the browser renews its lock there); false stops the run, so a sender that
   *   lost its lock never sends next to the one that took it over
   * @returns {Promise<{state, results: [{id, status, error?}], digest, sent, failed, reason}>}
   *   state is the new run state {channels: {id: {date, at, slot, through, failDate, tries, error}}, lastSent, lastReport,
   *   lastCheck}. A channel's window runs from its last report's data (through = that data's last_run) to now, so a
   *   failed or missed report is caught up in the next one and nothing is lost.
   */
  async function runDue(o) {
    const now = toMs(o.now) == null ? Date.now() : toMs(o.now);
    const settings = normalizeSettings(o.settings);
    const mode = o.mode === 'now' ? 'now' : 'scheduled';
    const tz = o.tzOffset;
    const state = cloneState(o.state);
    state.lastCheck = iso(now);
    // errors can quote a request (a webhook URL, a key): every one is redacted before it is stored or returned
    const secrets = secretValues(settings);
    const safe = e => clip(redact(typeof e === 'string' ? e : errText(e), secrets), 300);
    const out = { state, results: [], digest: null, sent: 0, failed: 0, reason: '' };
    if (!settings.enabled && mode === 'scheduled') { out.reason = 'paused'; return out; }
    const today = localDate(now, tz);
    const slot = slotDate(now, settings.time, tz);
    let targets = settings.channels.filter(c => c.enabled && validateChannel(c).ok && (o.runtime !== 'browser' || browserMode(c) !== 'unsupported'));
    if (Array.isArray(o.channelIds)) targets = targets.filter(c => o.channelIds.includes(c.id));
    if (typeof o.local === 'function' && settings.background.osNotification) targets.push({ id: LOCAL_ID, type: 'local', name: KIND_LABELS.local });
    const due = targets.filter(c => channelDue(now, settings.time, state.channels[c.id], mode, tz));
    if (!due.length) { out.reason = targets.length ? 'not-due' : 'no-channels'; return out; }
    const cs = id => (state.channels[id] = state.channels[id] || {});
    const persist = async () => { if (typeof o.persist === 'function') { try { await o.persist(state); } catch (e) { /* the final state is still returned */ } } };

    let meta;
    try { meta = await o.loadMeta(); } catch (e) { out.reason = 'data-error'; out.error = safe(e); return out; }
    const until = (meta && meta.last_run) || iso(now);
    const untilMs = toMs(until);
    const fresh = due.filter(c => { const th = toMs(cs(c.id).through); return th == null || untilMs > th; });
    for (const c of due) if (!fresh.includes(c)) { cs(c.id).slot = slot; out.results.push({ id: c.id, status: 'no-new-data' }); }
    if (fresh.length < due.length) await persist();
    if (!fresh.length) { out.reason = 'no-new-data'; return out; }

    let data;
    try { data = await o.loadData(meta); } catch (e) { out.reason = 'data-error'; out.error = safe(e); return out; }
    const digests = new Map();
    for (const c of fresh) {
      const st = cs(c.id);
      const since = st.through || iso(untilMs - DAY_MS);
      if (!digests.has(since)) {
        digests.set(since, buildDigest({ records: data.records, events: data.events, since, until, dataSince: data.dataSince, settings, watchlist: o.watchlist, profiles: o.profiles }));
      }
      const d = digests.get(since);
      if (!d) { Object.assign(st, { slot, through: until }); out.results.push({ id: c.id, status: 'empty' }); await persist(); continue; }
      if (typeof o.beforeSend === 'function' && !(await o.beforeSend(c).catch(() => false))) {
        out.results.push({ id: c.id, status: 'skipped', error: 'the lock was lost' });
        out.reason = 'locked';
        break;
      }
      let r;
      try {
        if (c.id === LOCAL_ID) r = await o.local(d);
        else r = await o.send(buildRequest(c, d, o.ctx), c);
      } catch (e) { r = { ok: false, error: safe(e) }; }
      r = r || { ok: false, error: 'no answer' };
      if (r.ok) {
        Object.assign(st, { slot, through: until, date: today, at: iso(now), failDate: null, tries: 0, error: null, opaque: !!r.opaque });
        out.results.push({ id: c.id, status: 'sent', opaque: !!r.opaque });
        out.sent++;
        out.digest = out.digest || d; // the device's own notification is checked last: a channel's report wins
      } else {
        const tries = st.failDate === today ? (st.tries || 0) + 1 : 1;
        // the window stays where it was (a first report keeps the start it was given), so nothing is lost
        Object.assign(st, { slot, failDate: today, tries, error: safe(r.error || 'failed'), through: st.through || since });
        out.results.push({ id: c.id, status: 'failed', error: st.error });
        out.failed++;
      }
      if (out.sent) {
        state.lastSent = { date: today, at: iso(now) };
        state.lastReport = { at: iso(now), digest: out.digest };
      }
      await persist();
    }
    out.reason = out.reason || (out.sent ? 'sent' : out.failed ? 'failed' : 'empty');
    return out;
  }

  root.SgNotify = {
    PUBLIC_URL, DATA_FORMAT, APP_NAME, CALLMEBOT_URL, GRAPH_VERSION, GRAPH_BASE, MAX_ITEMS, PARTIAL_NOTE, LOCAL_ID, TYPES, PROVIDERS, FIELDS, KIND_LABELS,
    SECTION_TITLES, STATUS_LABELS,
    normalizeText, cleanTerm, termRegex, findTerms, recordText,
    PRESET_PROFILES, parseTerms, normalizeProfile, allProfiles,
    kindOf, kindLabel, browserMode, fieldsOf, defaultSettings, normalizeSettings, normalizeChannel, validateChannel,
    secretValues, redact, redactRequest,
    triggerTerms, matchRecord, buildDigest, sampleDigest,
    topicLink, fmtDate, countPhrase, format, buildRequest, interpretResponse,
    localDate, prevDate, slotDate, isDue, channelDue, cloneState, runDue
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
