# SAM's Garage build, data and release targets.
#   make serve        run the web app locally at http://localhost:8091
#   make install      install the Electron build tooling
#   make scrape       refresh the database in data/ from every source (a few minutes)
#   make scrape-quick quick scrape for development (about 40 records per source)
#   make data         build the site data (site/data) from the database in data/
#   make test         run the scraper tests (pytest) and the site tests (node --test)
#   make build        build the desktop app for this machine's OS (output in dist/), with a data snapshot
#   make build-win    build the Windows installer (NSIS)
#   make build-mac    build the macOS disk image (needs macOS)
#   make build-linux  build the Linux AppImage and .deb
#   make dist-all     build all three on one machine (fully supported only on macOS)
#   make release      used by the Release workflow (CI=1): bump the version from the conventional commits
#                     since the last tag, update the version shown in the app, commit, tag and push. The
#                     workflow then builds the installers and deploys GitHub Pages. Releases are started
#                     by hand: Actions -> Release -> Run workflow (nothing is released by a merge).
#                     Local use (needs permission to push main): BUMP=major|minor|patch|prerelease, PRE=Beta, DRY=1
#   make version      print the current version

NPX ?= npx
PYTHON ?= python
BUMP ?= auto
PRE ?=
RELEASE_FLAGS := $(if $(PRE),--pre=$(PRE),) $(if $(DRY),--dry,) $(if $(CI),--ci,)

.PHONY: help serve install scrape scrape-quick data test build build-win build-mac build-linux dist-all release version clean

help:
	@sed -n '2,18p' Makefile

serve:
	node serve.js 8091

install:
	npm install

scrape:
	$(PYTHON) -m scraper scrape --all

scrape-quick:
	$(PYTHON) -m scraper scrape --all --limit 40

data:
	$(PYTHON) -m scraper build --out site/data

test:
	$(PYTHON) -m pytest -q
	npm test

# The installers bundle a data snapshot (site/data), used when the live site cannot be reached.
build: install data
	$(NPX) electron-builder --publish never

build-win: install data
	$(NPX) electron-builder --win --publish never

build-mac: install data
	$(NPX) electron-builder --mac --publish never

build-linux: install data
	$(NPX) electron-builder --linux --publish never

dist-all: install data
	$(NPX) electron-builder -wml --publish never

release:
	node scripts/release.js $(BUMP) $(RELEASE_FLAGS)

version:
	@node scripts/release.js --show

clean:
	rm -rf dist
