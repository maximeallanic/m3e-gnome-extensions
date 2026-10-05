# Shared helpers for the scripts in this directory. Source it, do not execute it.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extensions"
export SHARED_SRC="$REPO_ROOT/shared/m3e"
EMBED_LIST="$REPO_ROOT/shared/embedded-by.txt"

# Print the directory name (== UUID) of every extension in the repository, sorted.
list_extensions() {
    find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
}

# Print the UUIDs of the extensions that embed the shared toolkit (shared/embedded-by.txt).
list_embedders() {
    [[ -f "$EMBED_LIST" ]] || return 0
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$EMBED_LIST" | grep -v '^$' || true
}

die() {
    echo "error: $*" >&2
    exit 1
}
