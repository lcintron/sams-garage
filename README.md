# 🛠️ [SAM's Garage (Sg)](https://lcintron.github.io/sams-garage/)

[![SAM's Garage Live](https://img.shields.io/badge/Live-lcintron.github.io%2Fsams--garage-success?style=for-the-badge&logo=githubpages&logoColor=white)](https://lcintron.github.io/sams-garage/)
[![Latest release](https://img.shields.io/github/v/release/lcintron/sams-garage?style=for-the-badge&logo=github&label=Release)](https://github.com/lcintron/sams-garage/releases/latest)
[![PWA and Electron](https://img.shields.io/badge/PWA%20%2B%20Electron-Web%20%26%20Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://github.com/lcintron/sams-garage/releases/latest)

![SAM's Garage](branding/png/sg-banner-1200x300.png)

Every open and upcoming U.S. federal SBIR/STTR topic in one fast, searchable list. That covers DoD (Army, Navy, Air
Force, DARPA, SOCOM, …), HHS/NIH, NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC and more. It runs in the browser
(installable, works offline) or as a desktop app for Windows, macOS and Linux. All searching happens on your device:
no servers, accounts or tracking.

## What it provides

- **Search** across titles, descriptions, keywords and topic numbers, with prefix and typo tolerance.
- **Filters** for status (open, pre-release, forecasted, closed), agency and sub-agency, program (SBIR/STTR), phase,
  closing window and open date. The URL holds every filter, so any view can be bookmarked or shared.
- **Keyword profiles** (**#UAS**, **#Counter-UAS**, **#Acoustic** built in, plus your own) that flag and rank
  matching topics.
- **New since your last visit** badges, and a **watchlist** of starred topics.
- **Topic detail**: every field, the release → Q&A → close timeline, the full description, official links and a
  status history.
- **Daily notifications** to Slack, Discord, Microsoft Teams or WhatsApp. See [Notifications](#notifications).
- **SQL console** (`#/sql`): read-only SQL against the whole database in your browser, and the `.sqlite` file to
  download.
- **Export** of the current results as CSV or JSON.

## Usage

Open **<https://lcintron.github.io/sams-garage/>**. To install it:

- **Desktop:** the [installers](https://github.com/lcintron/sams-garage/releases/latest), or **Install** in the web
  app's header (Chrome, Edge).
- **Android Chrome:** the menu, then **Add to Home screen** or **Install app**.
- **iPhone or iPad Safari:** Share, then **Add to Home Screen**.

The menu button (☰) opens the side panel: Opportunities, Watchlist, Notifications, the SQL console, the filters, and
the theme, **Settings** and **About** at the bottom. Keyboard: <kbd>/</kbd> to search, <kbd>↑</kbd><kbd>↓</kbd> to
move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to go back.

## Notifications

You get one report a day per channel, and only when there is something to report. A report covers new topics that
match your keywords, changes to them, and any change to a starred topic. Set it up under **Notifications** in the app.
Reports are sent by the desktop app (from the tray, even with its window closed), by GitHub Actions (with every device
off), or by the browser while the app is open. The **[setup guide](docs/notifications.md)** covers each platform's
webhook or key, and where your secrets are kept.

## Sources and updates

| Source | What it provides |
|---|---|
| [SBIR.gov](https://www.sbir.gov/topics) | open topics from every participating agency |
| [DoD SBIR/STTR portal (DSIP)](https://www.dodsbirsttr.mil/topics-app/) | open and pre-release DoD topics, with the fullest descriptions |
| [Grants.gov](https://www.grants.gov/) | posted and forecasted grant-based SBIR/STTR opportunities (NIH, HHS, USDA, DOE, NSF, ED, …) |
| [NSF SBIR/STTR](https://seedfund.nsf.gov/) | descriptions for NSF topics that SBIR.gov lists without one |

The data is refreshed **once a day at 06:15 UTC**. The same opportunity found in several sources is merged into one
record. Records are never deleted: status changes (pre-release → open → closed) are tracked with their dates. The
header shows when the data was last refreshed, and turns amber when a source failed on the last run. An open app picks
up new data on its own.

SAM's Garage is informational only. Always confirm dates and requirements in the official solicitation before you
propose.

## Contributing

You need **Python 3.12+** and **Node 22+**.

```sh
pip install -r requirements-dev.txt
npm run dev        # quick scrape, build the site data, serve at http://localhost:8091
make test          # scraper tests (pytest) and site tests (node --test)
```

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …): they set the version
of the next release. Open a pull request against `main`, and CI runs the tests. The project layout, the desktop build,
deploys and releases are in [CONTRIBUTING.md](CONTRIBUTING.md). The data pipeline and how to add a source are in
[scraper/README.md](scraper/README.md).

## Disclaimer and license

SAM's Garage is not affiliated with the SBA, SBIR.gov, the Department of Defense, Grants.gov or any agency.

[MIT](LICENSE) © Luis Cintron. Bundled third-party code: MiniSearch (MIT) and sql.js (MIT); see `site/vendor/*/LICENSE*`.
