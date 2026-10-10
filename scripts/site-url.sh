#!/usr/bin/env bash
# Point a site folder at its public address:  scripts/site-url.sh <site-dir> [url]
#
# Rewrites PUBLIC_URL in <site-dir>/js/config.js (where shared links from the desktop app point) and the same
# address in <site-dir>/index.html (the og:/twitter: link-preview tags). url defaults to $SITE_URL; with neither,
# nothing changes. Used by scripts/assemble-site.sh for every Pages deploy and by release.yml for the installers,
# so moving to the custom domain is a change of SITE_URL in the workflows. url must be https and end with "/".
set -euo pipefail

dir=${1:?usage: scripts/site-url.sh <site-dir> [url]}
url=${2:-${SITE_URL:-}}
[ -n "$url" ] || exit 0
if [[ ! "$url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)*/$ ]]; then
  echo "::error::SITE_URL must look like https://host/ or https://host/path/ (got '$url')." >&2
  exit 1
fi
python - "$dir" "$url" <<'PY'
import pathlib, re, sys
site, url = pathlib.Path(sys.argv[1]), sys.argv[2]
config = site / "js" / "config.js"
if not config.exists():  # code from before js/config.js existed
    print(f"site URL: {config} not found, left as is")
    sys.exit(0)
text = config.read_text(encoding="utf-8")
m = re.search(r"^export const PUBLIC_URL = '([^']+)';", text, re.M)
if not m:
    sys.exit(f"::error::PUBLIC_URL not found in {config}")
current = m.group(1)
for path in (config, site / "index.html"):
    before = path.read_text(encoding="utf-8")
    path.write_text(before.replace(current, url), encoding="utf-8", newline="\n")
print(f"site URL: {url}" + ("" if url != current else " (unchanged)"))
PY
