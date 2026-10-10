# 🛠️ [SAM's Garage (Sg)](https://lcintron.github.io/sams-garage/)

[![SAM's Garage Live](https://img.shields.io/badge/Live-lcintron.github.io%2Fsams--garage-success?style=for-the-badge&logo=githubpages&logoColor=white)](https://lcintron.github.io/sams-garage/)
[![Latest release](https://img.shields.io/github/v/release/lcintron/sams-garage?style=for-the-badge&logo=github&label=Release)](https://github.com/lcintron/sams-garage/releases/latest)
[![PWA and Electron](https://img.shields.io/badge/PWA%20%2B%20Electron-Web%20%26%20Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://github.com/lcintron/sams-garage/releases/latest)

![SAM's Garage](branding/png/sg-banner-1200x300.png)

Every open and upcoming U.S. federal SBIR/STTR topic and solicitation in one fast, searchable list: DoD (Army, Navy,
Air Force, DARPA, SOCOM, …), HHS/NIH, NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC and more, gathered daily from
[SBIR.gov](https://www.sbir.gov/topics), the [DoD SBIR/STTR portal (DSIP)](https://www.dodsbirsttr.mil/topics-app/) and
[Grants.gov](https://www.grants.gov/). It runs in the browser (installable, works offline) or as a desktop app
([installers](https://github.com/lcintron/sams-garage/releases/latest) for Windows, macOS and Linux). All searching
happens on your device: no servers, accounts or tracking. The site is at <https://lcintron.github.io/sams-garage/>
for now; it will move to sg.luiscintron.com once that custom domain is configured (steps under "One-time setup" in
[How the data stays fresh](#how-the-data-stays-fresh)).

## Features

- **Instant list.** The app renders from a compact catalog, then builds a full-text index ([MiniSearch](https://lucaong.github.io/minisearch/)) in the background. Search covers titles, descriptions, keywords and topic numbers, with prefix and typo tolerance.
- **Filters** for status (open, pre-release, forecasted, closed), agency and sub-agency (with counts), program (SBIR/STTR), phase (I, II, direct to II), "closing within 7/14/30/60 days" and "opens on or after". The URL holds every filter, so you can bookmark or share any view.
- **Keyword profiles.** **#UAS**, **#Counter-UAS** and **#Acoustic** are built in, and you can add your own. They flag matching topics, show which terms matched, and rank by relevance.
- **New since your last visit.** Topics first seen after your previous visit get a NEW badge and a filter chip.
- **Watchlist.** Star topics to keep them in one place on this device.
- **Topic detail.** Every field, a release → Q&A → close timeline, the full description, links to the official solicitation and source pages, and a status history.
- **SQL console** (`#/sql`). Run read-only SQL against the whole database in your browser ([sql.js](https://sql.js.org/)), with example queries, a schema browser, and a download link for the `.sqlite` file.
- **Export** the current results as CSV (opens cleanly in Excel) or JSON.
- **Installable and offline.** The web app works offline on the last data it loaded and offers to reload when a new version ships. The desktop app always has data: today's from the live site, else the last copy it kept, else the snapshot in its installer.
- **Usability.** Dark and light themes, keyboard support (<kbd>/</kbd> to search, <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close), and layouts for phone through desktop.

Informational only: always confirm dates and requirements in the official solicitation before you propose.

## Run it locally

You need Python 3.12+ and Node 22+ (`npm test` passes a glob to `node --test`).

```sh
pip install -r requirements.txt
python -m scraper scrape --all --limit 40     # quick scrape (~40 records per source) into data/
python -m scraper build --out site/data       # data/ -> site/data/ (catalog, index, records, sqlite)
node serve.js 8091                            # web app at http://localhost:8091
```

`npm run dev` (or `make scrape-quick data serve`) does the same in one go; `npm run scrape` / `make scrape` runs the
full scrape. Any static web server works for `site/`. The dev server uses port 8091 because 8080 is commonly taken by
other local tools. On `localhost` the service worker loads the app shell network-first, so edits show up on a normal
reload.

Tests: `make test`, or `python -m pytest -q` (scraper, needs `pip install -r requirements-dev.txt`) and `npm test`
(site and desktop handler, `node --test`, nothing to install).

## Desktop app

The desktop app is the same web app in an [Electron](https://www.electronjs.org/) window whose top bar is the window's
title bar.

```sh
npm install                 # Electron and electron-builder (no lock file is kept)
npm start                   # run it (build site/data first: make data)
npm run smoke               # load it, wait for the result list, print SMOKE OK <n> cards (or SMOKE FAIL) and exit
npm run dist:win            # NSIS installer in dist/ (also dist:mac, dist:linux, or dist for this OS)
```

`make build`, `make build-win`, `make build-mac` and `make build-linux` build `site/data` first, so the installer
bundles a data snapshot.

It serves the app from a private `app://sg/` address (ES modules and `fetch()` do not work from `file://`). Requests for
data go to the live site first (`https://lcintron.github.io/sams-garage/data/…`, a single constant in
[`electron/main.js`](electron/main.js)); a good answer is also kept in the app's user-data folder (`data-cache/`). When
the site cannot be reached within a few seconds, the app uses that copy, else the snapshot bundled in the installer.
It registers no service worker, opens links in the system browser, and saves exports and the `.sqlite` file through the
usual Save dialog.

## How the data stays fresh

[`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) runs every day at 06:15 UTC and can also be started by
hand.

1. **Scrape.** `python -m scraper scrape --all` fetches all three sources and merges them into `data/`. Records are never deleted. Status changes (pre-release → open → closed), first-seen and last-seen dates are tracked, and each change goes into `data/changelog.jsonl`. If one source fails, its records are left untouched and the failure is noted in `data/meta.json`. The job fails only when every source fails.
2. **Commit.** A bot commits `data/` with a message like `data: refresh 2026-10-09 (352 open, 4 new)`, but only when something changed.
3. **Deploy.** [`scripts/assemble-site.sh`](scripts/assemble-site.sh) assembles the site from **the code of the latest release** and **the data of that commit** (built into `site/data` by the release's own scraper), and GitHub Pages is redeployed. This runs even when nothing changed, so the "updated" time stays current.

So, as in GenGIS, the live site's code changes only with a release, while its data changes every day. Every Pages
deploy goes through the same script: the daily refresh, each release, and [`pages.yml`](.github/workflows/pages.yml),
which redeploys the latest (or a chosen) release by hand. [`ci.yml`](.github/workflows/ci.yml) runs the tests on every
push and pull request.

**One-time setup:** in the GitHub repository, go to **Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**. The custom domain is set in **Settings → Pages → Custom domain** (`sg.luiscintron.com`, with a
DNS CNAME record to `lcintron.github.io`); `site/CNAME` is kept for reference only, since GitHub ignores it for
Actions deployments. Until then the public address is `https://lcintron.github.io/sams-garage/`: it is the
`SITE_URL` in the workflows, which [`scripts/site-url.sh`](scripts/site-url.sh) writes into the link-preview tags of
`index.html` and into `site/js/config.js` (where the desktop app's shared links point). Once the domain works,
change `SITE_URL` in `release.yml`, `scrape.yml` and `pages.yml` to `https://sg.luiscintron.com/`.

In the app, the header pill shows when the data was last refreshed. It turns amber when a source failed on the last
run. When newer data is published while the app is open, the app reloads the catalog and shows a "Data updated" toast.

## Releases

Releases run in CI on demand: **Actions → Release → Run workflow** on `main` (or
`gh workflow run release.yml -f bump=auto`). Nothing is released by a merge. The workflow works out the version,
commits `chore(release): vX.Y.Z` with the new version in the app, tags `vX.Y.Z`, builds the Windows, macOS and Linux
installers (each with today's data), publishes a GitHub Release, and deploys the site from the tag with today's data.
A pre-release (`prerelease` bump, or a label such as `Beta`) is published as a GitHub pre-release with its installers
but never deployed to the site, which keeps showing the latest stable release. **Dry run** only reports the version it would release. Locally: `make release DRY=1` (or
`node scripts/release.js auto --dry`) shows the next version, and `make version` the current one.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), and with **auto** (the default)
they decide the [semantic version](https://semver.org/) bump since the last tag:

| Commits since the last release | Bump | Example |
| --- | --- | --- |
| a `BREAKING CHANGE:` footer line, or `type!:` | major | `feat!: drop the v1 data format` |
| `feat:` | minor | `feat: export the watchlist as CSV` |
| `fix:`, `perf:`, `revert:` | patch | `fix: keep the filter drawer open on resize` |
| only `chore:`, `docs:`, `ci:`, `build:`, `test:`, `refactor:`, `style:`, `data:` | none | `data: refresh 2026-10-09 (352 open, 4 new)` |

Choose **patch**, **minor**, **major** or **prerelease** (with a label such as `Beta`) in the form to override it.

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

The same opportunity found in several sources is merged into one record; `alt_ids` and `links` keep the other ids and
links. The build turns `data/` into what the site reads from `site/data/`: `catalog.json` (compact records for the
list), `search-index.json`, `records/<id>.json` (full records, loaded when a detail opens), `agencies.json`,
`meta.json`, and `solicitations.sqlite` for the SQL console (tables `solicitations`, `keywords` and `changelog`, views
`open_now` and `closing_soon`).

The full schema, the merge and lifecycle rules, the CLI reference and **how to add a new source** are in
**[scraper/README.md](scraper/README.md)**. The architecture plan is in [PLAN.md](PLAN.md).

## Project layout

| Path | Role |
|---|---|
| `site/` | the web app, deployed as-is: vanilla ES modules, no framework and no bundler (`js/app.js` boot and routing, `js/ui/*` views, `sw.js` offline cache versioned by `VERSION`, `vendor/` pinned MiniSearch 7.2.0 and sql.js 1.13.0) |
| `scraper/` | the Python data pipeline (`python -m scraper …`) |
| `data/` | the database, committed daily by the scrape workflow |
| `electron/` | the desktop app: `main.js` (window), `preload.js` (bridge), `protocol.js` (`app://` and the data fallback) |
| `scripts/` | `release.js` (versions and tags), `assemble-site.sh` (what Pages publishes) |
| `branding/` | marks, wordmarks, banner, social image and app icon (`svg/`, `png/`), drawn with the site icons by `python site/icons/make-icons.py` |

## Install as an app

- **Desktop:** the [installers](https://github.com/lcintron/sams-garage/releases/latest), or **Install** in the header of the web app (Chrome, Edge).
- **Android Chrome:** the menu, then **Add to Home screen** or **Install app**.
- **iPhone or iPad Safari:** Share, then **Add to Home Screen**.

## Disclaimer and license

SAM's Garage is not affiliated with the SBA, SBIR.gov, the Department of Defense, Grants.gov or any agency. Always
confirm dates and requirements in the official solicitation before you propose.

[MIT](LICENSE) © Luis Cintron. Bundled third-party code: MiniSearch (MIT) and sql.js (MIT); see `site/vendor/*/LICENSE*`.
