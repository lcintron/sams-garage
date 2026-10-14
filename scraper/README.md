# scraper — SAM's Garage data pipeline

`python -m scraper` fetches open and upcoming SBIR/STTR opportunities from three federal sources,
merges them into the database committed under `data/`, and builds the static files the site reads
from `site/data/`. It needs Python 3.12+ with `requests` and `beautifulsoup4` (`pip install -r requirements.txt`).

```sh
pip install -r requirements-dev.txt                       # requests, beautifulsoup4, pytest
python -m scraper scrape --all                            # about 2-3 minutes; updates data/
python -m scraper validate                                # schema-check data/
python -m scraper build --out site/data                   # data/ -> site/data/
python -m scraper status                                  # last run, per-source health, counts
python -m pytest -q                                       # offline tests (saved fixtures)
```

## CLI reference

Global options (they go before the subcommand): `--data-dir DIR` (default `data`) and `-v/--verbose` (debug logging).
Progress logs go to stderr. Each command prints a one-line summary to stdout.

| Command | Options | What it does |
|---|---|---|
| `scrape` | `--all` or `--source NAME` (repeatable: `sbir_gov`, `dod_dsip`, `grants_gov`) | Scrapes the chosen sources one after another, merges them into `data/`, then appends to the changelog and rewrites `meta.json`. |
| | `--limit N` | Caps each source at N records, for debugging. A limited run is **incomplete**, so it never marks anything missing or closed and never shrinks a snapshot. |
| | `--workers N` (default 8, capped at 8) | Number of detail pages fetched in parallel. |
| | `--delay S` (default 0.2) | Minimum seconds between the starts of two requests, across all workers. |
| | `--timeout S` (default 30) | Timeout for each request. |
| `build` | `--out DIR` (default `site/data`) | Writes the artifacts listed in [Site artifacts](#site-artifacts). |
| `status` | | Summarizes `data/meta.json`. |
| `validate` | | Checks every record against the schema and confirms ids are sorted and unique. It also checks the snapshots and the shape of the changelog. Exits 1 if it finds a problem. |

Exit codes for `scrape`: it exits 0 when at least one source succeeded. A failed source is logged,
recorded in `meta.json`, and printed as a `::warning::` annotation under GitHub Actions. It exits 1
only when every selected source failed. In that case only `meta.json` is rewritten.

## Data layout (`data/`, committed)

| File | Contents |
|---|---|
| `solicitations.jsonl` | The canonical merged records, one JSON object per line, sorted by `id`, with keys in schema order. |
| `sources/<source>.jsonl` | Each source's **snapshot**: the normalized records it listed on its last successful run, before merging. Lifecycle fields are null here. |
| `changelog.jsonl` | Append-only events: `{"at", "id", "event", "from", "to"}`. `updated` events also carry `"fields"`. |
| `meta.json` | `last_run`; per source `{ran_at, ok, complete, fetched, failed, error, records}`; `counts {total, by_status, by_agency}`; `last_run_events {new, status, updated, missing}`. |

Files are UTF-8 with LF line endings and are written atomically.

## Record schema

This restates PLAN.md §4. Every key is always present and is `null` when unknown.

| Key | Type | Notes |
|---|---|---|
| `id` | string | `<prefix>:<native id>`. The prefixes are `sbirgov` (sbir.gov topic node id), `dsip` (DSIP `topicCode`) and `grants` (Grants.gov opportunity id). Native ids are limited to `[A-Za-z0-9._-]`. |
| `source` | string | Where the content comes from now, the preferred source that lists the record: `dod_dsip`, `sbir_gov` or `grants_gov`. It can differ from the id's prefix (ids are stable; see the merge rules). |
| `links` | object | Always has the keys `dod_dsip`, `sbir_gov`, `grants_gov` and `official`. These are human URLs. The DSIP topics app has no per-topic deep link (`?searchText=` is ignored and `/topic-details/<id>` returns 404), so `dod_dsip` is the app root, `https://www.dodsbirsttr.mil/topics-app/`. For DSIP topics, `official` is the topic PDF (`/topics/api/public/topics/<topicId>/download/PDF`). |
| `alt_ids` | string[] | Ids this record absorbed through dedupe, sorted. |
| `title`, `agency`, `sub_agency` | string | `agency` is one of DOD, HHS, NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC or OTHER. sbir.gov's "DOW" (Department of War) maps to DOD. |
| `program` | string | `SBIR`, `STTR` or `SBIR/STTR`. sbir.gov tags topics that are open to both programs with a bare "BOTH" (all NSF topics). "BOTH" is also its phase tag, as in `["SBIR", "BOTH"]`, so it only means `SBIR/STTR` when there is no explicit SBIR or STTR tag. |
| `phases` | string[] | Ordered values from `I, II, IIB, III, DP2, SPII`. sbir.gov's "BOTH" means I and II. |
| `topic_number`, `solicitation_number`, `solicitation_title` | string | |
| `status` | string | `open`, `pre_release`, `forecasted`, `closed` or `unknown`. |
| `release_date`, `open_date`, `close_date`, `qa_open_date`, `qa_close_date` | `YYYY-MM-DD` | DSIP epoch-ms values are converted in US Eastern time. |
| `summary` | string ≤ 400 | The first whole sentences of the objective, description or listing summary. |
| `description` | string | Plain text. Paragraphs are separated by a blank line and list items start with `• `. NSF topics come from sbir.gov without a description, so they get their parent topic's description from seedfund.nsf.gov (see Sources). |
| `keywords` | string[] | The source's own keywords, lowercased and deduped, most relevant first. DSIP technology areas go in `technology_areas` and DSIP focus areas go in `extra.focus_areas`. Neither is copied into `keywords`. |
| `technology_areas` | string[] | |
| `year` | int | |
| `first_seen` | ISO-8601 UTC timestamp | Set once. |
| `last_seen` | **`YYYY-MM-DD` date** | See the note below. |
| `last_changed` | ISO-8601 UTC timestamp | The time `content_hash` last changed. |
| `content_hash` | sha1 hex | Hash of title, status, the five dates, description and keywords. |
| `extra` | object | Source-specific leftovers, kept under 2 KB: long strings are capped at 300 characters, then the largest keys are dropped. sbir.gov's boilerplate "NOTE" is never stored. |

**Date granularity (a decision on top of PLAN.md §4):** `last_seen` is stored as a **date**, not a
timestamp. Every run updates `last_seen` on every record it sees, so a timestamp would rewrite every
line of `solicitations.jsonl` on each run. With a date, re-running the scrape on the same day leaves
`data/` byte-identical except for the run timestamps in `meta.json`. The daily diff is one changed
date per live record plus the real changes. `first_seen` and `last_changed` stay full timestamps
because they change rarely.

## Lifecycle (merge.py)

Each run does the following:

1. **Snapshots.** A source that ran OK replaces its snapshot with what it listed this run. A source
   that failed, or wasn't run, keeps its previous snapshot. A `--limit` run updates its snapshot but
   never drops anything from it. When a detail page fails, that record keeps its previous content and
   takes the status from the listing, so a flaky endpoint never churns descriptions.
2. **Clustering (dedupe).** Snapshot records and the previous canonical records are grouped when
   they share a dedupe key or are linked through `alt_ids`. The key is the agency plus the normalized
   topic number: case-insensitive, with spaces, dashes and underscores removed, and at least 4
   characters. A key only links records when no source has two *different* records with that key, so
   two distinct topics from the same source are never folded together.
3. **Combine.** The primary record comes from the preferred source (dod_dsip > sbir_gov > grants_gov).
   Secondary records fill empty fields and add their links and keywords, and the longest non-empty
   description wins. **Ids are stable:** a new record takes the primary's id, and a published id never
   changes. If a better source appears later (for example DSIP after sbir.gov), or the source that first
   listed a record drops it while another still lists it, the record keeps its id: `source` and the
   content follow the preferred source that lists it now, and the other ids go into `alt_ids`. When two records
   that were published separately turn out to be the same topic, the one published first (earliest
   `first_seen`) keeps its id.
   `first_seen` is kept, and the site's `records/<id>.json` also shows the events logged under its
   `alt_ids`. So an id's prefix names the source that *first* published the record, which can differ
   from `source`. (Two records re-keyed by the older "the id moves" rule keep their current ids.)
4. **Status.**
   - Rule 1: when a source reported the record this run, the record takes that source's status
     (the most preferred reporter wins) and `last_seen` is set to today.
   - Rule 2: when no source reported the record and every source that ever listed it ran OK and
     complete this run, it becomes `closed` if `close_date < today`. Otherwise it keeps its status and
     one `missing` event is logged. The event is not repeated until the record has been seen again.
   - Rule 3: if any of those sources failed or was partial, the record is left untouched.
5. **Events.** The first time a record is seen it gets a `new` event and `first_seen = last_changed = now`.
   When `content_hash` changes, `last_changed` is set to now. A status difference logs `status` (from → to).
   Changes to any other hashed field log `updated`, with `from`/`to` set to the old and new hash and
   `fields` listing what changed. A pure status change therefore logs one event, not two.

Records are never deleted.

## Sources

| Source | How it is fetched | Notes |
|---|---|---|
| `sbir_gov` | HTML listing `/topics?status=Open&page=N` (10 per page), then `/topics/<id>` for each topic. | The parsing is ported from the original `scrape_sbir_topics.py`. sbir.gov has **no stable sort**: hundreds of topics share the same dates, so a single walk over the pages returns duplicates and misses about 5% of topics. The listing is re-walked (up to 6 passes) until the unique count reaches the page's "of N results" total. If it never does, the run is marked incomplete. A topic listed as "Open" with a future open date becomes `pre_release`, which matches DSIP. |
| `dod_dsip` | `GET /topics/api/public/topics/search?searchParam=<json>&size=100&page=N` for statuses 591 (Open) and 592 (Pre-Release), then `/topics/<topicId>/details`. | POST to search fails. Closed topics (593) are never fetched. The description is assembled from objective, description, the Phase I/II/III text and references. `phaseHierarchy` is parsed from its JSON string, and only phases with `hasConfiguration: "Y"` are kept. |
| NSF enrichment (inside `sbir_gov`, `sources/nsf_enrich.py`) | `seedfund.nsf.gov/sitemap.xml`, then each `/topics/<slug>/` page. | sbir.gov lists about 270 NSF subtopics, such as "AM3 Metals and Ceramics", with no description. NSF publishes one page per technology topic, with the topic description and its list of subtopics. There are no pages for individual subtopics. Every NSF record without a description gets its parent topic's description, under the heading `NSF technology topic: <name> (<code>)`, and `extra.description_source` points to the page. Records are matched by the letters of the topic number (`AM3` matches `AM`, `AV1` matches `AV/VR/MR`). When a page doesn't state its code, the match falls back to the parent topic's name (sbir.gov lists each parent topic as its own record, for example `DL Distributed Ledger`). This step is best-effort: if it fails, the NSF records are still produced, just without descriptions. The old `/topics/` index and `/technology-topics/` both return 404. The combined-topics PDF is from 2023 and doesn't extract cleanly, so it isn't used. |
| `grants_gov` | `POST api.grants.gov/v1/api/search2` with keywords SBIR and STTR and `oppStatuses: forecasted\|posted`, then `POST fetchOpportunity` for each hit. | Hits are kept only when the title or number names SBIR or STTR (or the NIH codes R41–R44 or SB1). If `fetchOpportunity` fails, the record falls back to the listing fields. For forecasts, the open and close dates are the forecast's *estimated* dates (`extra.estimated_dates`). |

Politeness: every request goes through `scraper/http.py`, which provides:

- a descriptive User-Agent, `SAMs-Garage/<version> (+https://github.com/<GITHUB_REPOSITORY>; …; data refresh bot)` (outside GitHub Actions it names `lcintron/sams-garage`)
- a timeout on every request
- up to 3 attempts with exponential backoff on connection errors, 429 and 5xx responses (`Retry-After` is honored)
- a global minimum gap between requests
- at most 8 workers

## Site artifacts

`python -m scraper build` writes the following files to `site/data/`:

| File | Contents |
|---|---|
| `meta.json` | `schema_version`, `build_time`, `data_version` (16 hex characters that change whenever records or the changelog change), `last_run`, `sources`, and `counts` (`total`, `by_status`, `by_agency`, `by_source`). |
| `catalog.json` | Every record without `description`, `extra` and `content_hash`. `summary` is trimmed to 240 characters and `keywords` is capped at 15. The full record is in `records/`. Sorted by id with sorted keys. |
| `records/<id-safe>.json` | The full record plus `"changelog": [...]`, which holds its events, including events logged under its `alt_ids`. `id-safe` is the id with `:` replaced by `__`. |
| `search-index.json` | **An array of documents, not a serialized MiniSearch index.** Each document is `{id, title, summary, keywords (space-joined), technology_areas (technology areas plus DSIP focus areas, space-joined), topic_number, solicitation_number, agency, sub_agency, description (first 4,000 characters)}`. The site builds the MiniSearch index in the browser, which is fast for a few thousand documents, and joins on `id`. Emitting MiniSearch's internal serialized format from Python would tie us to its private layout. |
| `solicitations.sqlite` | Tables `solicitations` (scalar columns plus JSON-text `phases`, `keywords`, `technology_areas`, `alt_ids` and `extra`, and `url_<link>` columns), `keywords(id, keyword)`, `changelog(at, id, event, from_value, to_value, fields)` and `meta(key, value)`. Views `open_now` and `closing_soon` (open and closing within 14 days of `date('now')`). |
| `agencies.json` | `[{code, name, count, by_status, sub_agencies: [{code, name, count}]}]`. |
| `changes.json` | `{last_run, since, events}`: the changelog events of the 30 days up to `meta.last_run` (`since` exclusive), in their `changelog.jsonl` shape, sorted by time, id and kind. The notification reports read it (README "Notifications"). Added in site format 1: an added file needs no format bump. |

The build is deterministic. Two builds of the same `data/` are byte-identical except for
`meta.json`'s `build_time`, which honors `SOURCE_DATE_EPOCH`. `changes.json`'s window ends at the data's `last_run`,
never at the clock.

## Adding a source

1. Create `scraper/sources/<name>.py` with `NAME = "<name>"` and
   `scrape(client: HttpClient, options: ScrapeOptions) -> SourceResult`. Keep the parsing in pure
   functions such as `parse_*` and `build_record`, so it can be tested against fixtures.
2. Build each `Record` with the helpers in `model.py` (`make_id`, `to_iso_date`, `html_to_text`,
   `normalize_*`) and call `.finalize()` on it.
3. Return `SourceResult(ok=False, error=...)` when the source failed entirely, so its records are
   left alone. Set `complete=True` only when the result is everything the source lists. Put ids
   built without their detail payload in `partial_ids`.
4. Register the module in `scraper/sources/__init__.py`. Add its id prefix to `ID_PREFIXES` in
   `model.py`, add a link key to `LINK_KEYS`, and add the source to `SOURCE_NAMES` in preference order.
5. Save one live response of each kind under `scraper/tests/fixtures/` (trimmed, with tokens
   redacted) and add parser tests to `scraper/tests/test_sources.py`.

## Tests

`python -m pytest -q` runs offline in under a second:

- `test_sources.py` checks each parser against the saved sbir.gov listing and detail pages, the DSIP
  search and details responses, and the Grants.gov search2 and fetchOpportunity responses (posted and
  forecasted). It also checks the multi-pass listing walk and the NSF enrichment: parsing the sitemap
  and topic pages, matching by code and by parent name, and the failure path.
- `test_merge.py` covers the lifecycle: new records, status changes, closing on a passed close date,
  `missing` logged once, failed and partial sources never closing anything, partial details, and dedupe
  (including a DSIP topic that appears after sbir.gov has already listed it).
- `test_build.py` checks the artifact contents (including `changes.json`'s window and order), the SQLite schema and views, and byte-identical rebuilds.
- `test_cli_http.py` checks the CLI's exit codes, that a crashing source is contained, and the HTTP
  client's retries and User-Agent.
- `test_model.py` checks the normalization helpers and `validate`.

The keyword profiles (UAS, Counter-UAS, Acoustic) and their scoring weights, first written for the
removed `analyze_sbir_hashtags.py`, live in the site's `site/js/profiles.js`.

## Automation

The workflows live in `.github/workflows/`:

- `scrape.yml` runs daily at 06:15 UTC and can be started manually with an optional `limit`. It scrapes, validates and commits `data/`, then (scheduled runs, or manual runs with `notify` ticked) sends the notification reports for that run's events with `scripts/notify.mjs` and the `SG_NOTIFY_CONFIG` secret. The deploy job then publishes Pages: the code of the latest release tag with the data of that exact commit.
- Every Pages deploy (`scrape.yml`, `release.yml`, and `pages.yml` by hand) goes through `scripts/assemble-site.sh <code-ref> <data-ref>`: it takes `site/` and `scraper/` from the code ref, `data/` from the data ref, runs `python -m scraper build --out site/data` with the code ref's scraper, and leaves out `site/tests`, `site/icons/make-icons.py` and `site/package.json`, so development files are never published.
- `release.yml` (by hand) tags a release, builds the desktop installers, each with a `site/data` snapshot built from the newest `data/` on main, and deploys Pages.
- `ci.yml` runs pytest, the data validation, a build smoke test, a dry run of the site assembly, a check that the latest release's scraper still builds the data (once there is a release), and the site's `npm test`.

**Schema changes need a release.** The live site is the latest release's code with the newest data, built by
that release's scraper, and installed desktop apps read the data of the live site. So a change to the database
schema in `data/`, or to the files under `site/data`, reaches users only through a release: merge it, then cut
one (README, "Releases"). CI fails a change to `data/` that the released scraper cannot build. When the shape of
the site data changes incompatibly, bump `SITE_FORMAT` in `build.py` together with `DATA_FORMAT` in
`site/js/data.js` and `electron/protocol.js`: apps that read an older format then keep the data they have and
ask for an update.
