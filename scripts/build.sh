#!/usr/bin/env bash
# Embed the shared toolkit (shared/m3e/*.js) into every extension that uses it, as <extension>/m3e/.
# The embedded copies are build products (git-ignored); shared/m3e is the single source of truth.
#
#   scripts/build.sh            copy shared/m3e/*.js into each extension listed in shared/embedded-by.txt
#   scripts/build.sh --check    do not copy; exit 1 if an embedded copy differs from the source
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

check=0
case "${1:-}" in
    --check) check=1 ;;
    '') ;;
    *) die "usage: build.sh [--check]" ;;
esac

[[ -d "$SHARED_SRC" ]] || die "missing $SHARED_SRC"

list_js() { # directory -> sorted *.js file names
    [[ -d "$1" ]] && find "$1" -maxdepth 1 -type f -name '*.js' -printf '%f\n' | sort
    return 0
}

status=0
while IFS= read -r uuid; do
    [[ -d "$EXT_DIR/$uuid" ]] || die "shared/embedded-by.txt lists $uuid but extensions/$uuid does not exist"
    target="$EXT_DIR/$uuid/m3e"
    if [[ $check -eq 0 ]]; then
        rm -rf "$target"
        mkdir -p "$target"
        while IFS= read -r f; do
            cp "$SHARED_SRC/$f" "$target/$f"
        done < <(list_js "$SHARED_SRC")
        continue
    fi
    while IFS= read -r f; do
        if [[ ! -f "$SHARED_SRC/$f" ]]; then echo "$uuid: not in source: $f"; status=1
        elif [[ ! -f "$target/$f" ]]; then echo "$uuid: missing copy: $f"; status=1
        elif ! cmp -s "$SHARED_SRC/$f" "$target/$f"; then echo "$uuid: differs: $f"; status=1
        fi
    done < <({ list_js "$SHARED_SRC"; list_js "$target"; } | sort -u)
done < <(list_embedders)
exit $status
