# Contributing to SAM's Garage

The [README](README.md#contributing) has the requirements and the quick start. This page has the rest.

## Project layout

| Path | Role |
|---|---|
| `site/` | the web app, deployed as-is: vanilla ES modules, no framework and no bundler (`js/app.js` boot and routing, `js/ui/*` views, `js/notify/*` the notification engine shared with the service worker, the desktop app and Actions, `sw.js` offline cache versioned by `VERSION`, `vendor/` pinned MiniSearch and sql.js) |
| `scraper/` | the Python data pipeline (`python -m scraper …`); its schema, merge rules, CLI and how to add a source are in [scraper/README.md](scraper/README.md) |
| `data/` | the database, committed daily by the scrape workflow |
| `electron/` | the desktop app: window, `app://` protocol and data fallback, tray and notification reports |
| `scripts/` | `release.js` (versions and tags), `assemble-site.sh` (what Pages publishes), `notify.mjs` (notification reports from GitHub Actions) |
| `branding/` | the logo artwork and its traced master vector `svg/sg-logo.svg` |

The architecture plan is in [PLAN.md](PLAN.md).

## Local development

```sh
pip install -r requirements-dev.txt
npm run dev                                   # quick scrape (~40 records per source), build site/data, serve on :8091
```

Or step by step: `python -m scraper scrape --all --limit 40`, then `python -m scraper build --out site/data`, then
`node serve.js 8091`. `npm run scrape` (or `make scrape`) runs the full scrape. On `localhost` the service worker loads
the app shell network-first, so edits show up on a normal reload.

**Tests:** `make test`, or `python -m pytest -q` and `npm test`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs both
on every push and pull request.

### Desktop app

```sh
npm install                       # Electron and electron-builder
npm start                         # run it (build site/data first: make data)
npm run smoke                     # load it, wait for the list, print SMOKE OK <n> cards (or SMOKE FAIL) and exit
npx electron . --notify-dry-run   # print today's notification report per channel, send nothing
npm run dist:win                  # installer in dist/ (also dist:mac, dist:linux); make build-* bundle fresh data
```

The app serves the site from a private `app://sg/` address. Data requests go to the live site first and fall back to
the last copy it kept, then to the snapshot bundled in the installer.

## Data pipeline and deploys

[`scrape.yml`](.github/workflows/scrape.yml) runs daily at 06:15 UTC (and by hand): it scrapes every source into
`data/`, commits `data: refresh YYYY-MM-DD (N open, M new)` when something changed, then deploys. Every Pages deploy
goes through [`scripts/assemble-site.sh`](scripts/assemble-site.sh): **the code of the latest release** plus **the
newest data**. So the live site's code changes only with a release, while its data changes every day.
[`pages.yml`](.github/workflows/pages.yml) redeploys the latest (or a chosen) release by hand.

**One-time setup:** Settings → Pages → Source: **GitHub Actions**. For the custom domain (`sg.luiscintron.com`, a DNS
CNAME to `lcintron.github.io`), set it in Settings → Pages → Custom domain, then change `SITE_URL` in `release.yml`,
`scrape.yml` and `pages.yml`.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); they decide the
[semantic version](https://semver.org/) bump since the last tag:

| Commits since the last release | Bump |
| --- | --- |
| a `BREAKING CHANGE:` footer, or `type!:` | major |
| `feat:` | minor |
| `fix:`, `perf:`, `revert:` | patch |
| only `chore:`, `docs:`, `ci:`, `build:`, `test:`, `refactor:`, `style:`, `data:` | none |

Releases are cut by hand: **Actions → Release → Run workflow** on `main` (or `gh workflow run release.yml -f bump=auto`).
It commits `chore(release): vX.Y.Z`, tags it, builds the Windows, macOS and Linux installers, publishes a GitHub
Release and deploys the site. A pre-release is published with its installers but never deployed. `make release DRY=1`
shows the next version.

## Logo and icons

Every icon and image is generated from [`branding/svg/sg-logo.svg`](branding/svg/sg-logo.svg). After editing it, run
`python site/icons/make-icons.py`. For new artwork, replace `branding/source/sams-garage-logo.png` and trace it first
with `python branding/trace-logo.py` (needs `numpy` and the `potrace` bindings).
