#!/usr/bin/env bash
# Build one zip per extension in dist/, ready for upload to extensions.gnome.org (uses `gnome-extensions pack`).
#
#   scripts/pack.sh [--out DIR]
#
# The embedded toolkit and every extra directory/file of an extension are added with --extra-source; the
# po/ directory, when present, is compiled by gnome-extensions into the zip's locale/ tree.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out="$REPO_ROOT/dist"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) [[ $# -ge 2 ]] || die "--out needs a directory"; out="$2"; shift ;;
        -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

command -v gnome-extensions >/dev/null || die "gnome-extensions is required (package gnome-shell / gnome-shell-extension-prefs)"
"$REPO_ROOT/scripts/build.sh"
mkdir -p "$out"

# Files and directories that `gnome-extensions pack` already includes, or handles through dedicated options.
is_default() {
    case "$1" in
        extension.js|metadata.json|prefs.js|stylesheet.css|po|schemas|locale) return 0 ;;
        *) return 1 ;;
    esac
}

while IFS= read -r uuid; do
    src="$EXT_DIR/$uuid"
    args=(--force --quiet --out-dir "$out")
    while IFS= read -r entry; do
        is_default "$entry" || args+=("--extra-source=$src/$entry")
    done < <(find "$src" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
    if [[ -d "$src/po" ]]; then
        domain="$(sed -n 's/.*"gettext-domain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/metadata.json")"
        args+=(--podir="$src/po" --gettext-domain="${domain:-$uuid}")
    fi
    if [[ -d "$src/schemas" ]]; then
        args+=(--schema="$(find "$src/schemas" -name '*.gschema.xml' -printf '%f\n' | head -n 1)")
    fi
    gnome-extensions pack "${args[@]}" "$src"
    zip="$out/$uuid.shell-extension.zip"
    [[ -f "$zip" ]] || die "expected $zip was not produced"
    echo "packed $zip"
done < <(list_extensions)
