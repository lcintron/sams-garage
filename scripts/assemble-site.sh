#!/usr/bin/env bash
# Assemble the GitHub Pages site: the code of the latest release with today's data.
#
#   scripts/assemble-site.sh [code-ref] [data-ref] [out-dir]
#     code-ref  the code to publish; default (or ""): the latest release tag (v*) on main, or main itself
#               while there is no release yet
#     data-ref  the commit whose data/ is published; default (or ""): main (origin/main when there is a remote)
#     out-dir   default: _site, what actions/upload-pages-artifact uploads
#
# The site is code-ref's site/, with site/data built from data-ref's data/ by code-ref's own scraper, so the data
# always comes in the format the published code reads. Development-only files are left out and VERSION.txt says
# what was deployed. Every Pages deploy goes through here: release.yml (each release), scrape.yml (the daily
# refresh) and pages.yml (by hand). Like GenGIS, the live site's code changes only with a release; its data
# changes every day.
#
# Needs both refs in the local repository (a full-history checkout: fetch-depth 0) and Python 3.12+. code-ref's
# requirements.txt is installed first unless ASSEMBLE_NO_PIP=1.
set -euo pipefail

if git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then MAIN=origin/main; else MAIN=main; fi
CODE_REF=${1:-}
DATA_REF=${2:-$MAIN}
OUT=${3:-_site}

if [ -z "$CODE_REF" ]; then
  CODE_REF=$(git describe --tags --abbrev=0 --match 'v*' "$MAIN" 2>/dev/null || true)
  if [ -z "$CODE_REF" ]; then
    CODE_REF=$MAIN
    echo "No release tag yet: publishing the code of $MAIN."
  fi
fi
for ref in "$CODE_REF" "$DATA_REF"; do
  if [[ "$ref" == -* ]] || ! git rev-parse -q --verify "$ref^{commit}" >/dev/null; then
    echo "::error::Not a commit, tag or branch in this checkout: '$ref'" >&2
    exit 1
  fi
done
case "$OUT" in
  '' | / | . | .. | ./ | ../* | */.. | */../*) echo "::error::Refusing to write the site to '$OUT'." >&2; exit 1 ;;
esac
code_sha=$(git rev-parse --short "$CODE_REF^{commit}")
data_sha=$(git rev-parse --short "$DATA_REF^{commit}")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive "$CODE_REF" site scraper requirements.txt | tar -x -C "$work"
git archive "$DATA_REF" data | tar -x -C "$work"

if [ "${ASSEMBLE_NO_PIP:-}" != 1 ]; then
  python -m pip install --quiet --disable-pip-version-check -r "$work/requirements.txt"
fi
(cd "$work" && python -m scraper build --out site/data)

rm -rf "$work/site/tests" "$work/site/icons/make-icons.py" "$work/site/package.json"
echo "$CODE_REF ($code_sha) with data from $data_sha, deployed $(date -u +%FT%TZ)" > "$work/site/VERSION.txt"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$work/site" "$OUT"
echo "Assembled $OUT: code $CODE_REF ($code_sha), data $DATA_REF ($data_sha)."
