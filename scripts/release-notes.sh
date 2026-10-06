#!/usr/bin/env bash
# Print the CHANGELOG.md section of one version (without its heading). Fails when the section is missing or empty.
#
#   scripts/release-notes.sh VERSION [CHANGELOG]
set -euo pipefail

version="${1:-}"
file="${2:-$(dirname "${BASH_SOURCE[0]}")/../CHANGELOG.md}"
[[ -n "$version" ]] || { echo "usage: release-notes.sh VERSION [CHANGELOG]" >&2; exit 2; }
[[ -f "$file" ]] || { echo "error: $file not found" >&2; exit 1; }

notes="$(awk -v v="$version" '
    /^## \[/ { if (on) exit; on = (index($0, "## [" v "]") == 1); next }
    /^\[[^]]+\]: / { if (on) exit }
    on { print }
' "$file")"
# Trim leading and trailing blank lines.
notes="$(printf '%s\n' "$notes" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"
[[ -n "$notes" ]] || { echo "error: no CHANGELOG section (or an empty one) for version $version in $file" >&2; exit 1; }
printf '%s\n' "$notes"
