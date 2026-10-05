#!/usr/bin/env bash
# Install / uninstall into a throw-away directory. Never touches the real ~/.local or the running session.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
export XDG_DATA_HOME="$tmp/data"

fail() { echo "not ok - $*" >&2; exit 1; }

"$root/scripts/install.sh" --dest "$tmp/ext" >/dev/null
for dir in "$root"/extensions/*/; do
    uuid="$(basename "$dir")"
    [[ -f "$tmp/ext/$uuid/metadata.json" ]] || fail "$uuid not installed"
    [[ -f "$tmp/ext/$uuid/extension.js" ]] || fail "$uuid has no extension.js"
done
while IFS= read -r uuid; do
    [[ -n "$uuid" ]] || continue
    [[ -f "$tmp/ext/$uuid/m3e/animate.js" ]] || fail "$uuid: embedded toolkit missing"
done < <(sed -e 's/#.*//' "$root/shared/embedded-by.txt")
echo "ok - install"

# Installing one extension by short name, then uninstalling it.
first="$(basename "$(find "$root/extensions" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)")"
"$root/scripts/install.sh" --dest "$tmp/ext2" "${first%%@*}" >/dev/null
[[ "$(find "$tmp/ext2" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]] || fail "short-name install"
"$root/scripts/install.sh" --uninstall --dest "$tmp/ext2" "${first%%@*}" >/dev/null
[[ ! -e "$tmp/ext2/$first" ]] || fail "uninstall left $first"
echo "ok - install by name and uninstall"

echo "1..2"
