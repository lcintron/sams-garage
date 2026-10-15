# SAM's Garage (Sg) — Build Plan

SAM's Garage (Sg), formerly "SBIR Portal", is a static, installable web app (PWA), also packaged as an
Electron desktop app, that lists every open and upcoming U.S. federal SBIR/STTR topic and solicitation,
backed by a database that lives in this git repository, is refreshed daily by a GitHub Action, and is
queried entirely in the browser from GitHub Pages.

Authored by Fable 5.1 (architect + reviewer). Built by Opus 5.5 subagents. Reviewed before merge.

---

## 1. Goals and non-goals

Goals
- One place to search all federal SBIR/STTR opportunities (DoD, HHS/NIH, NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC/NIST/NOAA, …).
- Daily automated refresh with zero servers: GitHub Actions scrapes, commits the data, builds, deploys to GitHub Pages.
- Fast: the list renders instantly from a compact catalog; full-text search runs client-side from a prebuilt index; detail text loads on demand.
- Web-queryable "database": a structured filter UI plus an SQL console (sql.js over a SQLite file built from the data).
- PWA like GenGIS (C:\Development\gengis): vanilla ES modules, no bundler, service worker, manifest, install prompt, works offline on the last-synced data.
- History: records are never deleted. Status transitions (pre-release → open → closed) and first/last-seen dates are tracked.

Non-goals
- No backend, no accounts, no server-side search.
- No backfill of DSIP's ~33k historical closed topics. Closed records accumulate naturally from things we once saw open/pre-release.
- No SAM.gov (needs an API key). Can be added later as an optional source gated on a secret.

---

## 2. Verified data sources (probed 2026-10-09)

### 2.1 sbir.gov topics (all agencies, aggregated)
- Listing: `https://www.sbir.gov/topics?status=Open&page=N` (Drupal). 10 per page, "Showing 1-10 of 352 results". Also `status=Closed`, `program=SBIR|STTR`, `phase=1|2`, `keywords`, `open_date_from/to`, `close_date_from/to`.
- Detail: `https://www.sbir.gov/topics/<id>`; fields: title, Funding Agency, Year, Topic Number, Solicitation Number, Release Schedule (release/open/due/close dates), "View Official Solicitation" link, tags (SBIR/STTR, Phase I/II), Description.
- The existing `scrape_sbir_topics.py` in this repo already parses listing + detail correctly. Port it, don't rewrite it.
- Be polite: ≤ 8 workers, small delay, retries with backoff, a real User-Agent string that identifies this project.

### 2.2 DoD DSIP (dodsbirsttr.mil) — richest DoD source
- Search (GET, not POST — POST returns a generic error):
  `https://www.dodsbirsttr.mil/topics/api/public/topics/search?searchParam=<urlencoded JSON>&size=100&page=0`
  with searchParam = `{"searchText":null,"components":null,"programYear":null,"solicitationCycleNames":null,"releaseNumbers":[],"topicReleaseStatus":[591,592],"modernizationPriorities":[],"sortBy":"finalTopicCode,asc","technologyAreaIds":[],"component":null,"program":null}`
  Response: `{"total":N,"data":[...]}`. Status codes: **591 = Open, 592 = Pre-Release, 593 = Closed** (do not fetch 593 in the daily run).
  Fields seen: topicId, topicCode, topicTitle, topicStatus, program (SBIR/STTR), component (ARMY/NAVY/…), solicitationNumber, solicitationTitle, cycleName, topicStartDate/topicEndDate (epoch ms), topicPreReleaseStartDate/EndDate, topicQAStartDate/EndDate, phaseHierarchy (JSON string), releaseNumber.
- Detail: `https://www.dodsbirsttr.mil/topics/api/public/topics/<topicId>/details` (200). Contains objective/description/keywords/technology areas/modernization priorities/references/TPOC. Inspect the live response and map the useful fields.
- Human URL for a topic: `https://www.dodsbirsttr.mil/topics-app/` (SPA; link to it with the topic code in search: `https://www.dodsbirsttr.mil/topics-app/?searchText=<topicCode>` if that works, else the app root).

### 2.3 Grants.gov search2 (grant-based SBIR/STTR: NIH, HHS, USDA, DOE, NSF, ED, …)
- `POST https://api.grants.gov/v1/api/search2` JSON body `{"keyword":"SBIR","oppStatuses":"forecasted|posted","rows":100,"startRecordNum":0}` → `data.hitCount`, `data.oppHits[]` with id, number, title, agencyCode, agency, openDate (MM/DD/YYYY), closeDate, oppStatus (forecasted|posted), docType, cfdaList. Repeat with keyword "STTR". Page with startRecordNum.
- Detail: `POST https://api.grants.gov/v1/api/fetchOpportunity` body `{"opportunityId": <id>}` (verify live; if it fails, keep the listing fields and link out). Human URL: `https://www.grants.gov/search-results-detail/<id>`.
- Filter to hits whose title or number actually mentions SBIR/STTR/"Small Business Innovation"/"Small Business Technology Transfer" (keyword search is fuzzy).

---

## 3. Repository layout

```
/
├─ PLAN.md                      this file
├─ README.md                    user-facing: what it is, run locally, deploy, data model (frontend agent owns; links to scraper/README.md)
├─ LICENSE                      MIT, "Luis Cintron"
├─ .gitignore                   site/data/, __pycache__, .venv, node_modules, dist, .pytest_cache
├─ requirements.txt             requests, beautifulsoup4, (pytest in requirements-dev.txt)
├─ package.json                 scripts (serve, build, scrape, test, start, smoke, dist:*, release) + electron-builder config
├─ serve.js                     zero-dependency static server for site/ (copy of GenGIS pattern)
├─ .claude/launch.json          {"name":"sams-garage","runtimeExecutable":"node","runtimeArgs":["serve.js","8091"],"port":8091}
├─ .github/workflows/
│   ├─ scrape.yml               daily cron + manual: scrape → commit data/ → deploy Pages (latest release + this data)
│   ├─ release.yml              manual: semver tag → installers (Win/macOS/Linux) → GitHub Release → deploy Pages
│   ├─ pages.yml                manual: redeploy the latest (or a given) release with today's data
│   └─ ci.yml                   on push/PR: pytest + node --test + build and site-assembly smoke tests
├─ scraper/                     Python package (python -m scraper ...)
│   ├─ __init__.py, __main__.py, cli.py
│   ├─ model.py                 Record dataclass, normalization helpers, validate()
│   ├─ http.py                  shared session: UA, retries, backoff, timeout, polite delay
│   ├─ sources/{__init__,base,sbir_gov,dod_dsip,grants_gov}.py
│   ├─ merge.py                 dedupe across sources, status lifecycle, first/last_seen, changelog
│   ├─ build.py                 data/ → site/data/ artifacts (catalog, records, search index, sqlite, meta)
│   ├─ README.md                scraper internals, CLI reference, adding a source
│   └─ tests/                   pytest; HTML/JSON fixtures saved from live responses
├─ data/                        THE DATABASE (committed; diff-friendly JSONL, sorted by id)
│   ├─ sources/sbir_gov.jsonl
│   ├─ sources/dod_dsip.jsonl
│   ├─ sources/grants_gov.jsonl
│   ├─ solicitations.jsonl      canonical merged records
│   ├─ changelog.jsonl          append-only events
│   └─ meta.json                last run time per source, counts, failures
└─ site/                        the PWA (deployed as-is to GitHub Pages, plus generated site/data/)
    ├─ index.html
    ├─ manifest.webmanifest
    ├─ sw.js
    ├─ css/app.css
    ├─ js/                      ES modules, no bundler
    │   ├─ app.js               boot, routing (js/nav.js), side panel, SW registration, install prompt
    │   ├─ data.js              fetch catalog/meta/index/records; caching; "new since last visit"
    │   ├─ search.js            MiniSearch load + query + filter/sort pipeline (pure, testable)
    │   ├─ filters.js           filter state ↔ URL query string
    │   ├─ ui/*.js              list, detail, filters panel, stats bar, toasts, sql console
    │   ├─ profiles.js          preset keyword profiles ported from analyze_sbir_hashtags.py (UAS, Counter-UAS, Acoustic) + user-defined
    │   ├─ store.js             localStorage: watchlist, saved searches, last-visit, prefs
    │   ├─ sql.js               sql.js loader + query runner (lazy; only on #/sql)
    │   └─ export.js            CSV/JSON export of current results
    ├─ vendor/minisearch/       pinned minisearch (ESM build), with LICENSE
    ├─ vendor/sqljs/            pinned sql.js (sql-wasm.js + sql-wasm.wasm), with LICENSE
    ├─ icons/                   icon.svg, icon-192/512.png, maskable variants, apple-touch-icon, favicon
    ├─ tests/                   node --test for pure modules (search/filters/profiles)
    └─ data/                    GENERATED, gitignored (see §5)
```

Delete `scrape_sbir_topics.py`, `analyze_sbir_hashtags.py`, `open_sbir_topics.json` once ported (keep useful bits as fixtures under `scraper/tests/fixtures/`).

---

## 4. Canonical record schema (the contract between scraper and site)

One JSON object per line in `data/solicitations.jsonl`, sorted by `id`. All keys always present (null when unknown). Dates are ISO `YYYY-MM-DD` strings. Timestamps are ISO-8601 UTC.

```jsonc
{
  "id": "dsip:ARM26BX06-NV012",          // "<source>:<native id>"; stable forever. sources: sbirgov | dsip | grants
  "source": "dod_dsip",                   // primary source: sbir_gov | dod_dsip | grants_gov
  "links": {                              // every place this record was seen; human URLs
    "dod_dsip": "https://www.dodsbirsttr.mil/topics-app/?searchText=ARM26BX06-NV012",
    "sbir_gov": "https://www.sbir.gov/topics/13020",
    "grants_gov": null,
    "official": "https://..."             // "View Official Solicitation" / agency page
  },
  "alt_ids": ["sbirgov:13020"],           // ids this record absorbed via dedupe
  "title": "…",
  "agency": "DOD",                        // canonical top-level code, see table below
  "sub_agency": "ARMY",                   // component / institute / office, or null
  "program": "SBIR",                      // SBIR | STTR | SBIR/STTR | null
  "phases": ["I", "II"],                  // normalized: I, II, III, DP2 (direct to phase II), SPII …
  "topic_number": "ARM26BX06-NV012",
  "solicitation_number": "26.B",
  "solicitation_title": "DoD SBIR 26.B",
  "status": "open",                       // open | pre_release | forecasted | closed | unknown
  "release_date": "2026-09-24",
  "open_date": "2026-10-15",
  "close_date": "2026-11-12",
  "qa_open_date": null, "qa_close_date": null,
  "summary": "≤ 400 chars, plain text",   // first sentences of description or listing summary
  "description": "full plain text …",     // may be long; newline-separated paragraphs
  "keywords": ["acoustic", "UAS"],        // tags, keywords, tech areas, modernization priorities, lowercased and deduped
  "technology_areas": ["Sensors"],
  "year": 2026,
  "first_seen": "2026-10-09T06:15:00Z",
  "last_seen": "2026-10-09T06:15:00Z",
  "last_changed": "2026-10-09T06:15:00Z", // when content_hash last changed
  "content_hash": "sha1 of title|status|dates|description|keywords",
  "extra": {}                             // bounded (< 2 KB) source-specific leftovers
}
```

Agency codes: DOD, HHS (NIH, CDC, FDA, ACL…), NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC (NIST, NOAA), plus `OTHER`. Map DSIP components (ARMY, NAVY, USAF, DARPA, MDA, SOCOM, DHA, DTRA, DLA, OSD, CBD, NGA, DMEA…) to agency DOD + sub_agency component. Map Grants.gov agencyCode prefixes (HHS-NIH11 → HHS/NIH, USDA-NIFA → USDA/NIFA, …). Map sbir.gov "Funding Agency" strings (e.g. "Department of Defense", "DOT") to codes.

`data/changelog.jsonl` events: `{"at": ts, "id": …, "event": "new"|"status"|"updated"|"missing", "from": …, "to": …}`.

`data/meta.json`: `{"last_run": ts, "sources": {"sbir_gov": {"ran_at", "ok", "fetched", "failed", "error"}, …}, "counts": {"total", "by_status": {…}, "by_agency": {…}}}`.

Status lifecycle (merge.py)
1. A record reported by a source this run gets that source's status and `last_seen = now`.
2. A record not reported this run: if `close_date < today` → `closed`; else keep previous status and log `missing` once (not every day).
3. Any run where a source fails entirely must NOT mark its records closed or missing (skip step 2 for that source).
4. `first_seen` is set once. `content_hash` change → `last_changed = now` + `updated` event.

Dedupe (merge.py): records from different sources are the same opportunity when normalized `topic_number` matches (case-insensitive, strip spaces/dashes) and agency matches. Primary source preference: dod_dsip > sbir_gov > grants_gov. Secondary records are folded into `links`/`alt_ids`; the richer non-empty description wins.

---

## 5. Site data artifacts (build.py → site/data/, gitignored, regenerated in CI)

| File | Purpose | Notes |
|---|---|---|
| `meta.json` | build time, data last_run, counts, data version | fetched network-first; drives "Data updated 3h ago" and update detection |
| `catalog.json` | array of compact records | every field except `description`, `extra`; summary trimmed; this is what the list renders from. Keep it under ~2 MB raw for 5k records. |
| `records/<id-safe>.json` | full record | id-safe = id with `:` → `__`; loaded when a detail opens; runtime-cached by the SW |
| `search-index.json` | MiniSearch serialized index | fields: title, summary, description, keywords, topic_number, solicitation_number, agency, sub_agency; storeFields: none (join with catalog by id) |
| `solicitations.sqlite` | SQLite DB for the SQL console | tables: `solicitations` (one row per record, scalar columns + `keywords` as JSON text + `description`), `keywords(id, keyword)`, `changelog`; views: `open_now`, `closing_soon`. Built with Python's stdlib sqlite3 |
| `agencies.json` | agency/sub-agency display names + counts | for the filter panel |

Build must be deterministic (sorted keys, sorted ids) so Pages deploys only differ when data differs.

---

## 6. Frontend behaviour

Shell: header (menu button, logo, search box, data-freshness pill, watchlist star, install button), a left side panel (navigation, the filters on the list, and a footer with the theme, Settings and About; docked and collapsible ≥ 1280px, a drawer below), results list, detail pane (side-by-side ≥ 1024px, full-screen route on mobile). Routes via hash: `#/` list, `#/s/<id>` detail, `#/sql` console, `#/watch` watchlist, `#/notify`, `#/settings`, `#/about`; each view other than the list has a back link to `#/` with the filters kept.

Search & filters (all reflected in the URL so views are shareable)
- Full-text (MiniSearch: prefix + fuzzy 0.2, field boosts title 3 / keywords 2 / topic_number 3).
- Status chips: Open (default on), Pre-release (default on), Forecasted, Closed.
- Agency multi-select with counts; sub-agency when DOD selected.
- Program: SBIR / STTR. Phase: I / II / DP2.
- Closing within: 7 / 14 / 30 / 60 days; "Opens after" date.
- Keyword profiles (profiles.js): toggleable presets UAS, Counter-UAS, Acoustic from the old hashtag analyzer; each is a list of terms; a record matches if any term appears in title/summary/description/keywords; show a relevance score and matched terms on the card. Users can add their own profiles (stored in localStorage).
- Sort: close date ↑ (default), recently added, recently changed, relevance (when text query), title.
- "New since your last visit" badge + chip filter (first_seen > stored last-visit timestamp; the timestamp updates when the app is closed/hidden, not on load).

Result card: title, agency/sub-agency badge, program + phases, topic number, status pill, close date with "in N days" (red < 7 days), keywords (first 6), matched profile terms, star (watchlist).

Detail: all fields, date timeline (release → open → Q&A → close), description with paragraphs preserved, links (official solicitation, source pages), "Copy link", "Export JSON", star. Changelog events for that id if present.

SQL console (#/sql): lazy-loads sql.js and `solicitations.sqlite`; textarea + Run (Ctrl/Cmd+Enter); results table (virtualized or capped at 1,000 rows with a note); example queries dropdown; schema sidebar; errors shown inline; read-only (reject non-SELECT/WITH/EXPLAIN).

Export: CSV and JSON of current filtered results.

PWA
- `manifest.webmanifest` (standalone, theme/background colors, icons incl. maskable), `<meta theme-color>`, apple-touch-icon.
- `sw.js`: `VERSION` constant; precache the shell (html, css, js, vendor, icons, manifest) with `cache: 'reload'` on install; `skipWaiting` + `clients.claim`; delete old shell caches on activate. Data strategy: `data/meta.json` network-first (fallback cache); `data/catalog.json`, `search-index.json`, `agencies.json` stale-while-revalidate into a `data` cache; `data/records/*` and the sqlite cache-first with network fallback and `data` cache; on a `meta.json` whose `data_version` differs from the cached one, the app refetches catalog/index and shows a "Data updated" toast. On a localhost dev host the shell is network-first (GenGIS pattern).
- Install prompt (beforeinstallprompt → header button), "Update available — Reload" toast when a new SW is waiting.
- Theme: dark default following `prefers-color-scheme`, toggle in header, CSS variables on `:root`.
- Accessibility: keyboard navigable list, focus management on detail open, aria-live for result counts, sufficient contrast.
- Performance: render list incrementally (first 50, then on scroll); never block on the sqlite download.

---

## 7. GitHub Actions

`scrape.yml`
```yaml
on: { schedule: [{ cron: '15 6 * * *' }], workflow_dispatch: { inputs: { limit: { description: 'per-source record cap (debug)', default: '' } } } }
permissions: { contents: write, pages: write, id-token: write }
concurrency: { group: scrape, cancel-in-progress: false }
jobs:
  scrape:  checkout (fetch-depth 1) → setup-python 3.12 (pip cache) → pip install → python -m scraper scrape --all
           → git config bot identity → git add data → commit "data: refresh YYYY-MM-DD (N open, M new)" if changed → git push
           → outputs.changed
  build-deploy: needs scrape; always() && scrape didn't fail; checkout ref main (after push) → setup-python → python -m scraper build --out site/data
           → configure-pages → upload-pages-artifact (path: site) → deploy-pages
```
- The scrape step must exit 0 when one source fails but others succeed (record the failure in meta.json and a `::warning::`); exit non-zero only when all sources fail.
- Never fail the deploy because nothing changed; still redeploy so `meta.json` build time is fresh (cheap).

`pages.yml`: workflow_dispatch only (optional `ref`, default the latest release tag). Since the SAM's Garage rename every deploy runs `scripts/assemble-site.sh`: the latest release's code with the newest data (see README "How the data stays fresh"); `release.yml` cuts releases (README "Releases").

`ci.yml`: on push/PR → `pip install -r requirements-dev.txt && pytest -q`, `node --test site/tests`, and `python -m scraper build --out /tmp/site-data` from the committed data (smoke).

Repository setting the user must set once: Settings → Pages → Source: GitHub Actions.

---

## 8. CLI (python -m scraper)

```
python -m scraper scrape --all [--limit N] [--source sbir_gov|dod_dsip|grants_gov ...] [--workers 8] [--delay 0.2]
python -m scraper build  [--out site/data]
python -m scraper status          # print meta.json summary: counts by status/agency, last run, failures
python -m scraper validate        # schema-check data/solicitations.jsonl
```
`--limit N` caps records per source for quick local runs (and the workflow_dispatch input).
Logging to stderr with per-source progress; final one-line summary to stdout.

npm scripts: `serve` (node serve.js 8091), `build` (python -m scraper build), `scrape` (python -m scraper scrape --all), `scrape:quick` (… --limit 40), `test` (node --test site/tests), `dev` (scrape:quick && build && serve).

---

## 9. Quality bar (what the reviewer will check)

- Scraper: fixtures-based tests for each source parser; merge tests for lifecycle + dedupe; a failed source never closes records; output is sorted and deterministic; no secrets; requests identify themselves; retries + timeouts everywhere; no unbounded growth in `extra`.
- Data: `python -m scraper validate` passes; `data/*.jsonl` sorted by id; re-running scrape with unchanged inputs produces no diff.
- Site: no bundler, no framework, vendored libs pinned with licenses; works from `file:` off? (no — from `node serve.js`), works on mobile widths; Lighthouse PWA installable; offline reload shows last data; filters ↔ URL round-trip; SQL console rejects writes; CSV export escapes properly; no console errors.
- Workflows: least-privilege permissions, pinned major versions of actions, inputs only via env vars, concurrency groups, bot commit identity, never fails on "nothing to commit".
- Docs: README explains run-locally in ≤ 6 commands, how the daily refresh works, how to add a source, the schema.

---

## 10. Work split

Agent A — "backend" (owns scraper/, data/, .github/, requirements*.txt, scraper/README.md, LICENSE, .gitignore)
Agent B — "frontend" (owns site/, serve.js, package.json, .claude/launch.json, README.md)

B must not wait for A: generate a fixture `site/data/` from `open_sbir_topics.json` with a tiny throwaway script (delete it after A's build works) that follows §4/§5 exactly, so UI work can start immediately. A must produce `site/data/` from real scrapes via `python -m scraper build`. Fable integrates: runs a real quick scrape + build, serves, reviews, sends fixes back to the owning agent.

Neither agent commits. Fable commits once the review passes; the user pushes after giving the GitHub location.

---

## 11. Notifications (daily reports to messaging platforms)

Users connect channels (Slack, Discord, Microsoft Teams, WhatsApp) and choose keywords, hashtags and keyword profiles.
Each channel gets **at most one report per local calendar day, and only when there is something to report**. User
documentation: README "Notifications".

### 11.1 What a report holds
Three triggers, each can be switched off:
- **starred**: any `status` / `updated` / `missing` event on a watchlist topic, whatever the keywords;
- **new**: a `new` event on a topic that matches the terms;
- **updated**: a `status` or `updated` event on a topic that matches the terms.

The terms are the keywords as typed (`#tag` allowed) plus the terms of the chosen profiles. Matching is the profiles'
matching (whole word or phrase, any case, hyphen ≈ space, leading `#` stripped). It now lives in one place,
`site/js/notify/core.js`, and `profiles.js` re-exports it. A topic appears once, in its highest-priority section
(starred > new > updated). Each section lists at most 15 topics, sorted by close date, with an "and N more" note.
Events logged under an absorbed id (`alt_ids`) count for the record that holds it now; watchlist ids are resolved the
same way. Every message ends with a link to the app, and every topic links to `<PUBLIC_URL>#/s/<id>`.

### 11.2 One engine, four runtimes
`site/js/notify/core.js` is a **classic script** that sets `globalThis.SgNotify`. It has no import/export, no DOM, no
fetch and no storage, so the same file runs in all four runtimes:

| Runtime | How it loads core.js | Sends with | Schedule |
|---|---|---|---|
| Page | `import './notify/core.js'` (side effect), via `js/notify/page.js` | `fetch` (`cors` / `no-cors`) | on load and when visible |
| Service worker | `importScripts` (sw.js stays a classic worker: module workers break Firefox offline) | `fetch` | Periodic Background Sync `sg-daily-report`, min 12 h |
| Electron main | `electron/notify-core.js` runs the file with `vm` (works with or without `site/package.json`, which the installer drops) | `net.fetch` | every 15 min, `powerMonitor` resume / unlock-screen |
| GitHub Actions | `import` from `scripts/notify.mjs` | `fetch` | after each scheduled scrape |

core.js provides:
- term matching;
- `buildDigest({records, events, since, until, settings, watchlist, profiles})`, which returns null or `{sections, counts, since, until}`;
- one formatter per platform, plus `format.summary` for OS notifications;
- `buildRequest(channel, digest, ctx)`, which returns `{url, method, headers, body, browserMode}`;
- `interpretResponse`;
- secret discovery and redaction;
- the scheduling helpers `localDate`, `isDue` and `channelDue`;
- `runDue`, the run loop that every runtime except Actions shares. The runtimes pass the I/O in: `loadMeta`, `loadData`, `send` and `local`.

`browserMode`:

| Channel | browserMode | How a browser sends it |
|---|---|---|
| Discord | `cors` | A normal request. |
| Slack | `no-cors` | The body is form-encoded as `payload=<json>`, which Slack accepts and which needs no preflight. |
| CallMeBot | `no-cors` | A GET. |
| Teams, WhatsApp Cloud | `unsupported` | It cannot. Desktop app or Actions only. |

Platform limits enforced by the formatters:
- **Slack:** at most 50 blocks and 3,000 characters per section text; `& < >` escaped in mrkdwn.
- **Discord:** at most 10 embeds, 4,096 characters per description and 6,000 in all. A long report is split into embeds, never into extra messages. `allowed_mentions: {parse: []}` is set, and markdown is escaped.
- **Teams:** an Adaptive Card 1.4 sent through a Workflows webhook.
- **CallMeBot:** plain text of at most 1,500 characters.
- **Cloud API:** a template message whose one body parameter is a single line of at most 1,000 characters. Graph refuses new lines, tabs and runs of 4 or more spaces in template parameters.

### 11.3 Scheduling
Each channel has its own run state: `{date, at, slot, through, failDate, tries, error}`.
- `date` is the last local date a report was sent. A channel never gets two reports on one date.
- `slot` is the last report slot that was checked. A slot is today once the configured time has passed, else yesterday.
- `through` is the data watermark: the `last_run` of the data the last report (or an empty check) covered.

`isDue` sends at or after the time. A slot that was never checked (the device was off) is caught up at the next check,
even before that day's time. After the time, a checked slot keeps being watched for the rest of the day: a check reads
`meta.json` only, and fetches more only when `last_run` has passed `through`. So data published later that day is
still reported that day. A failed send is retried once at the next check that day (`channelDue`). Its window does not
move, so the next report still includes what failed. A report dated after today (the clock moved backwards) means not
due, so a date never gets two reports. `runDue` hands the run state to a `persist` hook after every channel's result,
so a crash or a closed tab in the middle of a run never resends what already went out. Errors are redacted (every
secret value of the settings) before they are stored or returned.

The window is by **data**, not wall time: events with `through < at <= meta.last_run`. Scrape runs stamp every event
with the run's `last_run`, so this is exact even when a deploy lands after a check. A channel's first report covers the
24 h of data before `last_run`. Calendar dates come from local calendar fields, never by adding hours, so DST changes
are safe. When a window starts before the oldest event `changes.json` holds (its `since`), the digest is `partial`
and every format says "Some earlier changes are not included; open the app for the full history."

The OS notification is a pseudo-channel `__local` with the same rules. It is opt-out with `background.osNotification`.

### 11.4 Data
`scraper/build.py` also writes `site/data/changes.json`: `{last_run, since, events}`. It holds the changelog events of
the 30 days up to `last_run`, sorted by (at, id, kind), in the shape of changelog.jsonl. It is a pure function of
`data/`, so it is deterministic. An added file is backward compatible, so the site format stays 1. The service worker
treats it like catalog.json (stale-while-revalidate, network-first with `no-store`).

### 11.5 Settings and storage
```
{ enabled, time: "08:00",
  channels: [{id, type: "slack"|"discord"|"teams"|"whatsapp", provider?: "callmebot"|"cloud", name, enabled, ...fields}],
  triggers: {profiles: [ids], keywords: [strings, '#tags' allowed], newMatches, updatedMatches, starred},
  lastSent: {date, at},
  background: {tray, browser, osNotification} }
```
`enabled` defaults to false: nothing is sent, and no OS notification shown, until the user switches the reports on.

| Runtime | Settings | Run state, last report | Secrets |
|---|---|---|---|
| Web | IndexedDB `sg` / `kv` (`notify-settings`) | `notify-state`, `notify-last-report` | Only for channels a browser sends to (Slack, Discord, CallMeBot). Teams and Cloud API secrets are typed at export time and never stored (`browserStorable`, `buildExport`). On `*.github.io` the channel form warns that the origin is shared. |
| Desktop | `<userData>/notify.json`, through the preload bridge | The same file | Encrypted per field with `safeStorage`. Without a keychain they are stored plain, flagged, and the page warns. |
| Actions | The `SG_NOTIFY_CONFIG` secret | None (one report per run) | The repository secret. Every value is `::add-mask::`ed first. |

The page also mirrors the watchlist and the user's profiles into IndexedDB (web) or the bridge (desktop) on every
change. On the web, a lease lock in IndexedDB (`lock:notify`) stops two tabs and the service worker from sending
twice. Each execution context has its own owner (`page:<uuid>`, `sw:<uuid>`). The lease (90 s) covers loading the data
(two fetches of at most 30 s each) and is renewed before every send (`beforeSend`); a sender that lost it stops.

The page loads the notification code after its first paint (`js/notify/page.js` by dynamic import). `core.js` itself
stays on the boot path because `profiles.js` matches with it. The view saves with a debounce that is flushed on
`pagehide` and when the page is hidden. Each save reloads the stored settings and re-applies the view's pending
changes, so it never writes back a stale value; the desktop tray's changes reach the view through `notify:changed`.
**Clear local data** also deletes the notification keys (or `notify.json` on the desktop, through `notify:reset`),
and a removed channel's run state is dropped (`pruneState`).

Secrets never go in the app's own URLs or in logs. `redactRequest` and the dry run replace them with `[redacted]`.

### 11.6 Desktop specifics
- **Tray menu:** Open, Send today's report now, Pause/Resume, Notification settings, Start at login, Keep running in the tray, Quit.
- **Start at login:** Windows uses `openAtLogin` with `--hidden`. macOS ignores the arguments (and `openAsHidden` on 13+), so the app starts hidden when `getLoginItemSettings().wasOpenedAtLogin` is true. Linux has no login items in Electron.
- **Closing the window:** with keep-in-tray on (Windows, Linux), closing hides the window. macOS keeps its Dock behaviour and has the tray too. `session-end` (Windows shutdown or sign-out) lets the window close.
- **notify.json:** a secret that fails to decrypt keeps its encrypted blob and is written back unchanged. Writes of the run state, the watchlist or the profiles touch only that part. Every write merges into the file as it is on disk, which is read again whenever it changed.
- **Single instance:** `requestSingleInstanceLock`. A second launch shows the first window.
- **Notification click:** opens `#/notify?report=last`.
- **Checks:** `--notify-dry-run` prints each channel's report and redacted request without sending. `--notify-check` runs one scheduled check. `--notify-file=<path>` and `SG_LIVE_BASE` are for local testing only.

### 11.7 GitHub Actions
In `scrape.yml`, a job `notify` that `needs: [scrape, build-deploy]`, so the report's links open on the deployed data.
It checks out the pushed sha, sets up Node 22 with `setup-node@v7`, and runs `node scripts/notify.mjs` with
`SG_NOTIFY_CONFIG` from the secret. It has `contents: read` only.

The job runs when the scrape succeeded, and only for `schedule` or for `workflow_dispatch` with the boolean input
`notify` (default false). It has `continue-on-error`. The script reports the events whose `at` equals `meta.last_run`, so there is no state to keep.
A send failure is a warning, and the script exits 0.
