#!/bin/bash
# Reconcile Javadoc @since tags for the repo checked out in $PWD.
#
# Configured entirely via environment (the action.yml passes these):
#   GROUP       Maven groupId, e.g. com.vaadin                         (required)
#   ARTIFACTS   newline-separated "artifact=source-root" entries       (required)
#               e.g. "flow-server=flow-server/src/main/java"
#   DEV         target version, e.g. 24.10                             (required)
#   FORMATTER   auto | spotless | formatter | none                     (default auto)
#   FILTER      all | add | update                                     (default all)
#   WRITE       true to modify files, false for dry-run report only    (default true)
#   SKIP_INDEX  1 to reuse an already-present .since-index (cache hit)  (default 0)
set -euo pipefail
unset JAVA_TOOL_OPTIONS || true

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$HERE/SinceTool.java"
GROUP="${GROUP:?group-id required}"
DEV="${DEV:?target version required}"
FORMATTER="${FORMATTER:-auto}"
FILTER="${FILTER:-all}"
WRITE="${WRITE:-true}"
IDX="$PWD/${INDEX_DIR:-.since-index}"
MVN="mvn"; [ -x ./mvnw ] && MVN=./mvnw
mkdir -p "$IDX"

# Parse ARTIFACTS into parallel arrays of artifact + source-root. Each entry is
# either just "<artifact>" (source root defaults to <artifact>/src/main/java) or
# "<artifact>=<source-root>" when the layout differs from that convention.
arts=(); srcs=()
while IFS= read -r line; do
  line="${line%%#*}"; line="$(echo "$line" | xargs || true)"   # trim, drop comments
  [ -z "$line" ] && continue
  art="${line%%=*}"
  if [ "$line" = "$art" ]; then src="$art/src/main/java"; else src="${line#*=}"; fi
  arts+=("$art"); srcs+=("$src")
done <<< "$ARTIFACTS"
[ "${#arts[@]}" -gt 0 ] || { echo "no artifacts configured"; exit 1; }

# 1. Build the index (downloads cached under ~/.cache/since-tags), unless a valid
#    cached index was restored.
if [ "${SKIP_INDEX:-0}" = "1" ] && ls "$IDX"/*.tsv >/dev/null 2>&1; then
  echo "[since] reusing cached index ($(ls "$IDX"/*.tsv | wc -l | tr -d ' ') tsv)"
else
  for a in "${arts[@]}"; do bash "$HERE/build-index.sh" "$GROUP" "$a" "$IDX"; done
fi

# 2. Apply per source root.
mode="dry"; [ "$WRITE" = "true" ] && mode="write"
mods=""
for i in "${!arts[@]}"; do
  src="${srcs[$i]}"
  [ -d "$src" ] || { echo "[since] skip ${arts[$i]} (no $src)"; continue; }
  jbang "$TOOL" apply "$src" "$IDX" "$DEV" "$mode" "$IDX/report-${arts[$i]}.md" "$FILTER"
  m="${src%%/src/*}"; [ "$m" != "$src" ] && mods="$mods,$m"   # module dir for -pl
done

# 3. Format only the files the tool touched (revert anything else the formatter hits).
if [ "$WRITE" = "true" ]; then
  git diff --name-only -- '*.java' | sort > "$IDX/touched.txt"
  if [ -s "$IDX/touched.txt" ]; then
    fmt="$FORMATTER"
    if [ "$fmt" = auto ]; then
      grep -q spotless-maven-plugin pom.xml && fmt=spotless || fmt=formatter
    fi
    pl=(); [ -n "$mods" ] && pl=(-pl "${mods#,}")
    case "$fmt" in
      spotless)  $MVN -q spotless:apply  "${pl[@]}" || true ;;
      formatter) $MVN -q formatter:format "${pl[@]}" || true ;;
      none)      : ;;
    esac
    git diff --name-only -- '*.java' | sort | comm -23 - "$IDX/touched.txt" | xargs -r git checkout --
  fi
fi

echo "[since] done (group=$GROUP version=$DEV write=$WRITE)"
git --no-pager diff --shortstat -- '*.java' || true
