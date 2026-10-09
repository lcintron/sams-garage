# SBIR Portal

**Every open and upcoming U.S. federal SBIR/STTR topic and solicitation in one fast, searchable, installable web app.**

SBIR Portal collects opportunities from DoD (Army, Navy, Air Force, DARPA, SOCOM, …), HHS/NIH, NSF, DOE, NASA, USDA, DHS,
DOT, EPA, ED, DOC and others. Three public sources feed it: [SBIR.gov](https://www.sbir.gov/topics), the
[DoD SBIR/STTR portal (DSIP)](https://www.dodsbirsttr.mil/topics-app/) and [Grants.gov](https://www.grants.gov/). A GitHub
Action refreshes the data every day and commits it to this repository, which serves as the database. The site is
plain static files on GitHub Pages, and all searching runs in your browser. It has no servers, accounts or tracking.

## Features

- **Instant list.** The app renders from a compact catalog, then builds a full-text index ([MiniSearch](https://lucaong.github.io/minisearch/)) in the background. Search covers titles, descriptions, keywords and topic numbers, with prefix and typo tolerance.
- **Filters** for status (open, pre-release, forecasted, closed), agency and sub-agency (with counts), program (SBIR/STTR), phase (I, II, direct to II), "closing within 7/14/30/60 days" and "opens on or after". The URL holds every filter, so you can bookmark or share any view.
- **Keyword profiles.** **#UAS**, **#Counter-UAS** and **#Acoustic** are built in, and you can add your own. They flag matching topics, show which terms matched, and rank by relevance.
- **New since your last visit.** Topics first seen after your previous visit get a NEW badge and a filter chip.
- **Watchlist.** Star topics to keep them in one place on this device.
- **Topic detail.** Every field, a release → Q&A → close timeline, the full description, links to the official solicitation and source pages, and a status history.
- **SQL console** (`#/sql`). Run read-only SQL against the whole database in your browser ([sql.js](https://sql.js.org/)). It includes example queries, a schema browser, and a download link for the `.sqlite` file.
- **Export** the current results as CSV (opens cleanly in Excel) or JSON.
- **Installable PWA.** It works offline on the last data you loaded and shows an "update available" prompt when a new version ships.
- **Usability.** Dark and light themes, keyboard support (<kbd>/</kbd> to search, <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close), and layouts for phone through desktop.

## Run it locally

You need Python 3.12+ and Node 18+. Node has no packages to install; it only runs the zero-dependency dev server.

```sh
pip install -r requirements.txt
python -m scraper scrape --all --limit 40     # quick scrape (~40 records per source) into data/
python -m scraper build --out site/data       # data/ -> site/data/ (catalog, index, records, sqlite)
npm run serve                                 # node serve.js 8091
# open http://localhost:8091
```

`npm run dev` runs the quick scrape, the build and the server in one go. Other scripts: `npm run scrape` (full scrape),
`npm run build`, and `npm test` (front-end unit tests with `node --test`; no dependencies). The scraper has its own
tests: `pip install -r requirements-dev.txt && python -m pytest -q`.

The dev server uses port 8091 because 8080 is commonly taken by other local tools; `node serve.js <port>` overrides it. On `localhost` the service worker loads the app shell network-first,
so your edits appear on a normal reload.

## How the data stays fresh

[`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) runs every day at 06:15 UTC and can also be started by hand.

1. **Scrape.** `python -m scraper scrape --all` fetches all three sources and merges them into `data/`. Records are never deleted. Status changes (pre-release → open → closed), first-seen and last-seen dates are tracked, and each change goes into `data/changelog.jsonl`. If one source fails, its records are left untouched and the failure is noted in `data/meta.json`. The job fails only when every source fails.
2. **Commit.** A bot commits `data/` with a message like `data: refresh 2026-10-09 (352 open, 4 new)`, but only when something changed.
3. **Build and deploy.** `python -m scraper build --out site/data` generates the site data, and `site/` is deployed to GitHub Pages. This step runs even when nothing changed, so the "updated" time stays current.

[`pages.yml`](.github/workflows/pages.yml) redeploys on every push to `main` that touches the site, scraper or data.
[`ci.yml`](.github/workflows/ci.yml) runs the Python and JavaScript tests on every push and pull request.

**One-time setup:** in the GitHub repository, go to **Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**.

In the app, the header pill shows when the data was last refreshed. It turns amber when a source failed on the last
run. When newer data is published while the app is open, the app reloads the catalog and shows a "Data updated" toast.

## Data model

`data/solicitations.jsonl` holds one JSON record per opportunity, sorted by `id`. The id is stable and prefixed with
its source: `dsip:…`, `sbirgov:…` or `grants:…`. The main fields are:

| Field | Meaning |
|---|---|
| `title`, `summary`, `description` | text; summary ≤ 400 chars |
| `agency`, `sub_agency` | canonical codes, e.g. `DOD` / `ARMY`, `HHS` / `NIH` |
| `program`, `phases` | `SBIR`, `STTR` or `SBIR/STTR`; `["I", "II"]`, `["DP2"]`, … |
| `topic_number`, `solicitation_number`, `solicitation_title` | identifiers as published |
| `status` | `open`, `pre_release`, `forecasted`, `closed` or `unknown` |
| `release_date`, `open_date`, `qa_open_date`, `qa_close_date`, `close_date` | ISO `YYYY-MM-DD` |
| `keywords`, `technology_areas` | lowercased tags |
| `links` | human URLs: `official`, `dod_dsip`, `sbir_gov`, `grants_gov` |
| `first_seen`, `last_seen`, `last_changed` | when the scraper first and last saw it, and when its content last changed |

The same opportunity found in several sources is merged into one record. `alt_ids` and `links` keep the other ids and
links. The build turns `data/` into the files the site reads from `site/data/`:

- `catalog.json`: compact records for the list.
- `search-index.json`: documents indexed in the browser.
- `records/<id>.json`: full records, loaded when a detail opens.
- `agencies.json`
- `meta.json`
- `solicitations.sqlite`: the database for the SQL console, with the `solicitations`, `keywords` and `changelog` tables and the `open_now` and `closing_soon` views.

The full schema, the merge and lifecycle rules, the CLI reference and **how to add a new source** are documented in
**[scraper/README.md](scraper/README.md)**. The architecture plan is in [PLAN.md](PLAN.md).

## Front end

`site/` is deployed as-is: vanilla ES modules, no framework and no bundler.

| Path | Role |
|---|---|
| `js/app.js` | boot, hash routing (`#/`, `#/s/<id>`, `#/watch`, `#/sql`, `#/about`), service worker and install prompt |
| `js/data.js` | loading `site/data/*`, data-version checks |
| `js/search.js`, `js/filters.js`, `js/profiles.js` | the search and filter pipeline, filters ↔ URL, keyword profiles (pure, unit-tested) |
| `js/store.js` | localStorage: watchlist, saved searches, profiles, last visit, preferences |
| `js/sql.js`, `js/export.js` | read-only SQL engine (loaded only on `#/sql`), CSV/JSON export |
| `js/ui/*.js` | list, detail, filter panel, stats bar, toasts, SQL console, about, profiles dialog |
| `sw.js` | precached shell (versioned by `VERSION`). Data caching: `meta.json` network-first; catalog, index and agencies stale-while-revalidate; records and sqlite cache-first |
| `vendor/` | pinned [MiniSearch 7.2.0](site/vendor/minisearch/) and [sql.js 1.13.0](site/vendor/sqljs/), each with its license |
| `icons/` | app icons; regenerate with `python site/icons/make-icons.py` (Pillow) |

When you change shell files, bump `VERSION` in `site/sw.js` so installed copies update.

## Install as an app

- **Desktop Chrome or Edge:** click **Install** in the header, or the install icon in the address bar.
- **Android Chrome:** use the menu, then **Add to Home screen** or **Install app**.
- **iPhone or iPad Safari:** tap Share, then **Add to Home Screen**.

The installed app opens in its own window. It keeps working offline with the last data it loaded; topics you have
opened show their full text, and others show their summary. When a new version is ready, the app offers to reload.

## Disclaimer and license

SBIR Portal is not affiliated with the SBA, SBIR.gov, the Department of Defense, Grants.gov or any agency. Always
confirm dates and requirements in the official solicitation before you propose.

[MIT](LICENSE) © Luis Cintron. Bundled third-party code: MiniSearch (MIT) and sql.js (MIT); see `site/vendor/*/LICENSE*`.
