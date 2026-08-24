#!/bin/bash
# Build a @since introduction index for one published artifact.
#
# Usage: build-index.sh <groupId> <artifactId> <indexOutDir> [minBaselineMajor]
#   <groupId>          e.g. com.vaadin
#   <artifactId>       e.g. flow-server  (must publish -sources.jar to Maven Central)
#   <indexOutDir>      directory where <artifactId>.tsv is written
#   [minBaselineMajor] optional; skip releases with major < this (e.g. 24)
#
# Indexes EVERY stable patch of every minor (plus, for the in-progress minor that
# has no GA yet, its latest pre-release). @since is then computed (apply step) as
# the start of the contiguous run of presence at full PATCH granularity reaching
# the latest release. That single rule handles everything without dates:
#  - a maintenance-release introduction -> X.Y.Z (it is continuously present from
#    there to now);
#  - a backport into an old maintenance patch is excluded, because the early
#    patches of the next minor (later in version order) lack it -> the streak
#    breaks before reaching the backport;
#  - a pre-release introduction -> bare minor X.Y.
#
# EVERY listed release must actually make it into the index. Presence is recorded
# per artifact, but the apply step derives @since over a release axis shared by
# all indexed artifacts, so a release that silently fails to download reads as
# "this artifact's whole API did not exist yet": the streak restarts after the
# hole and every type in the module is re-dated to the next release. Downloads
# are therefore retried, and a release that still cannot be fetched or extracted
# aborts the build instead of leaving a gap.
#
# Extracted sources are cached under $SINCE_CACHE (default ~/.cache/since-tags),
# keyed by exact version (immutable), and reused across runs and repositories.
set -euo pipefail

# The host repo may export JAVA_TOOL_OPTIONS with a hotswap agent that crashes
# short-lived JVMs (jbang). Strip it for everything this script launches.
unset JAVA_TOOL_OPTIONS || true

GROUP="${1:?groupId}"; ART="${2:?artifactId}"; OUTDIR="${3:?indexOutDir}"; BASELINE="${4:-0}"
CACHE="${SINCE_CACHE:-$HOME/.cache/since-tags}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="https://repo1.maven.org/maven2/$(echo "$GROUP" | tr . /)/$ART"

ROOT="$CACHE/$GROUP/$ART"
SRC="$ROOT/src"
ATTEMPTS="${SINCE_FETCH_ATTEMPTS:-4}"   # tries per download, including the first
DELAY="${SINCE_FETCH_DELAY:-3}"         # seconds before the first retry, doubled after each
mkdir -p "$SRC" "$OUTDIR"

# fetch <url> <outFile> [maxSecondsPerAttempt]
# Retries transient failures (connection errors, timeouts, 429, 5xx) with
# exponential backoff, logging every attempt so a flaky release is visible in the
# job log. A 404 is permanent and is not retried. Returns 1 if the file could not
# be fetched, leaving no output file behind.
fetch() {
  local url="$1" out="$2" maxtime="${3:-180}" attempt=1 delay="$DELAY" code
  while :; do
    code=$(curl -sS --max-time "$maxtime" -o "$out" -w '%{http_code}' "$url" 2>/dev/null) || code=000
    if [ "$code" = 200 ]; then return 0; fi
    rm -f "$out"
    if [ "$code" = 404 ] || [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "[build-index] GET $url -> $code (gave up after $attempt attempt(s))" >&2
      return 1
    fi
    echo "[build-index] GET $url -> $code, retrying in ${delay}s (attempt $attempt/$ATTEMPTS)" >&2
    sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1))
  done
}

# Abort rather than index an incomplete release history -- see the header note.
die() {
  echo "[build-index] FATAL: $GROUP:$ART $*" >&2
  echo "[build-index] Refusing to build a partial index: a missing release silently re-dates" >&2
  echo "[build-index] @since for every type in the module. Re-run to retry -- releases already" >&2
  echo "[build-index] downloaded stay cached." >&2
  exit 1
}

echo "[build-index] $GROUP:$ART  cache=$ROOT"

# 1. metadata -> the versions to index: every stable patch (baseline-filtered),
#    plus the latest pre-release of the highest minor if that minor has no GA yet.
fetch "$BASE/maven-metadata.xml" "$ROOT/maven-metadata.xml" 60 \
  || die "could not download maven-metadata.xml"
allvers=$(grep -oE '<version>[0-9]+\.[0-9]+\.[0-9]+[^<]*</version>' "$ROOT/maven-metadata.xml" \
  | sed -E 's/<\/?version>//g' | awk -F. -v b="$BASELINE" '($1+0)>=(b+0)' | sort -V)
stable=$(echo "$allvers" | grep -vE '\-|\.(alpha|beta|rc)' || true)   # exclude pre-releases (both 25.2.0-rc2 and ancient 2.2.0.alpha11 styles)
tolist="$stable"
# in-progress minor: highest minor overall; if it has no stable release, add its latest pre-release
highminor=$(echo "$allvers" | awk -F. '{print $1"."$2}' | sort -V | tail -1)
if ! echo "$stable" | awk -F. -v t="$highminor" '($1"."$2)==t{f=1} END{exit !f}'; then
  prerel=$(echo "$allvers" | awk -F. -v t="$highminor" '($1"."$2)==t' | sort -V | tail -1)
  [ -n "$prerel" ] && tolist="$stable"$'\n'"$prerel"
fi
echo "[build-index] indexing $(echo "$tolist" | grep -c .) releases ($(echo "$tolist" | tail -1) latest)"

# 2. download + extract each (cache keyed by exact version). Fed by a here-string
#    rather than a pipe so the loop runs in this shell and die() aborts the script.
while read -r v; do
  [ -z "$v" ] && continue
  d="$SRC/$v"
  [ -f "$d/.ok" ] && continue
  rm -rf "$d"; mkdir -p "$d"
  if ! fetch "$BASE/$v/$ART-$v-sources.jar" "$ROOT/s.jar"; then
    rm -rf "$d"
    die "no sources jar for $v"
  fi
  if ! ( cd "$d" && unzip -oq "$ROOT/s.jar" ); then
    rm -rf "$d" "$ROOT/s.jar"
    die "sources jar for $v could not be extracted"
  fi
  rm -f "$ROOT/s.jar"
  touch "$d/.ok"
done <<< "$tolist"

# 3. build the index over every cached version dir
jbang "$HERE/SinceTool.java" index "$SRC" "$OUTDIR/$ART.tsv"
