#!/usr/bin/env node
/* SAM's Garage - the daily notification report from GitHub Actions (scrape.yml, after "Commit and push data").
 *
 *   SG_NOTIFY_CONFIG='{"settings": {...}, "watchlist": [...], "profiles": [...]}' node scripts/notify.mjs [--data data]
 *
 * SG_NOTIFY_CONFIG is the repository secret the web app's "Export for GitHub Actions" copies (settings with secrets,
 * the watchlist, the user's own keyword profiles). Empty or unset: nothing to do (exit 0 with a notice).
 *
 * The report covers the events of THIS scrape run: the changelog events whose "at" is meta.json's last_run, which is
 * exactly what changed since the previous successful run. So there is no state to keep and at most one report per
 * run (the workflow runs it only for the daily schedule, or by hand with notify: true). The time of day in the
 * settings does not apply here: the report goes out when the data is refreshed.
 *
 * Every secret value is masked (::add-mask::) before anything is printed. Sending is best effort: a channel that
 * fails is a ::warning::, and the script exits 0 so the data workflow never fails because of a webhook.
 *
 * For tests only: SG_NOTIFY_TEST_CALLMEBOT_URL and SG_NOTIFY_TEST_GRAPH_BASE replace CallMeBot's and the Graph
 * API's base URLs, and are honoured only when they point at this machine (http://127.0.0.1 or localhost).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(root, 'site', 'js', 'notify', 'core.js')).href);
const N = globalThis.SgNotify;
const SEND_TIMEOUT_MS = 20000;

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };
const dataDir = path.resolve(opt('data') || path.join(root, 'data'));
const out = line => process.stdout.write(line + '\n');
const summaryLines = [];

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const testUrl = name => (LOCAL.test(process.env[name] || '') ? process.env[name] : undefined);
const siteUrl = /^https:\/\/[^\s]+\/$/.test(process.env.SITE_URL || '') ? process.env.SITE_URL : N.PUBLIC_URL;
const ctx = { publicUrl: siteUrl, callmebotUrl: testUrl('SG_NOTIFY_TEST_CALLMEBOT_URL'), graphBase: testUrl('SG_NOTIFY_TEST_GRAPH_BASE') };

function finish(code = 0) {
  if (process.env.GITHUB_STEP_SUMMARY && summaryLines.length) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Notifications', '', ...summaryLines, ''].join('\n') + '\n'); } catch (e) { /* no summary */ }
  }
  process.exit(code);
}
const note = msg => { out('::notice::' + msg); summaryLines.push(msg); };

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

async function send(req, channel, secrets) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      method: req.method, headers: { 'User-Agent': 'SAMs-Garage-notify (+https://github.com/lcintron/sams-garage)', ...req.headers },
      body: req.body == null ? undefined : req.body, signal: ctl.signal
    });
    const body = await res.text().catch(() => '');
    const r = N.interpretResponse(channel, { status: res.status, body });
    return { ...r, status: res.status, error: r.error && N.redact(r.error, secrets) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : N.redact(String(e.cause && e.cause.code || e.message || e), secrets) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const raw = (process.env.SG_NOTIFY_CONFIG || '').trim();
  if (!raw) { note('SG_NOTIFY_CONFIG is not set: no notifications to send.'); return finish(0); }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) {
    out('::warning::SG_NOTIFY_CONFIG is not valid JSON (export it again from the app: Notifications -> Export for GitHub Actions).');
    return finish(0);
  }
  const plain = cfg && typeof cfg === 'object' && !cfg.settings && Array.isArray(cfg.channels); // a bare settings object
  const settings = N.normalizeSettings(plain ? cfg : cfg && cfg.settings);
  const secrets = N.secretValues(settings);
  for (const v of secrets) out('::add-mask::' + v); // first, before anything that could print them
  const watchlist = Array.isArray(cfg.watchlist) ? cfg.watchlist.filter(x => typeof x === 'string') : [];
  const profiles = N.allProfiles(Array.isArray(cfg.profiles) ? cfg.profiles : []);

  if (!settings.enabled) { note('Notifications are paused in SG_NOTIFY_CONFIG ("enabled": false).'); return finish(0); }
  const channels = settings.channels.filter(c => c.enabled);
  if (!channels.length) { note('SG_NOTIFY_CONFIG has no enabled channel.'); return finish(0); }

  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8'));
  const lastRun = meta.last_run;
  if (!lastRun) { note('data/meta.json has no last_run: nothing to report.'); return finish(0); }
  const events = readJsonl(path.join(dataDir, 'changelog.jsonl')).filter(e => e && e.at === lastRun);
  const records = readJsonl(path.join(dataDir, 'solicitations.jsonl'));
  const digest = N.buildDigest({ records, events, since: null, until: lastRun, settings, watchlist, profiles });
  out(`Run ${lastRun}: ${events.length} changelog ${events.length === 1 ? 'event' : 'events'}.`);
  if (!digest) { note(`Nothing to report for the run of ${lastRun} (${events.length} events, none matching).`); return finish(0); }
  out(N.format.headline(digest));
  summaryLines.push(N.format.headline(digest) + ` (run ${lastRun})`, '');

  let sent = 0, failed = 0;
  for (const ch of channels) {
    const label = `${N.kindLabel(ch)} "${ch.name}"`;
    const v = N.validateChannel(ch);
    if (!v.ok) {
      out(`::warning::${label}: skipped, ${v.errors.map(e => `${e.field}: ${e.message}`).join(' ')}`);
      summaryLines.push(`- ${label}: skipped (incomplete settings)`);
      failed++;
      continue;
    }
    const r = await send(N.buildRequest(ch, digest, ctx), ch, secrets);
    if (r.ok) { sent++; out(`${label}: sent (HTTP ${r.status})`); summaryLines.push(`- ${label}: sent`); }
    else { failed++; out(`::warning::${label}: not sent: ${r.error}`); summaryLines.push(`- ${label}: not sent (${r.error})`); }
  }
  out(`Done: ${sent} sent, ${failed} not sent.`);
  return finish(0);
}

main().catch(e => {
  out('::warning::Notifications failed: ' + N.redact(String((e && e.message) || e), N.secretValues(N.normalizeSettings(safeSettings()))));
  finish(0);
});

function safeSettings() {
  try { const c = JSON.parse(process.env.SG_NOTIFY_CONFIG || '{}'); return c.settings || c; } catch (e) { return {}; }
}
