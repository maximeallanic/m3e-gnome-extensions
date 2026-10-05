#!/usr/bin/env bash
# Install the extensions for the current user (no root, no network).
#
#   scripts/install.sh [--enable] [--dest DIR] [NAME...]
#   scripts/install.sh --uninstall [--dest DIR] [NAME...]
#
# NAME is a directory name under extensions/ (the UUID) or its part before the '@'. Default: all extensions.
# --dest   target directory (default: ${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions)
# --enable run `gnome-extensions enable` after installing. GNOME Shell on Wayland only discovers a newly
#          copied extension after the next login, so enabling may report "does not exist" until then.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
enable=0
uninstall=0
names=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --enable) enable=1 ;;
        --uninstall) uninstall=1 ;;
        --dest) [[ $# -ge 2 ]] || die "--dest needs a directory"; dest="$2"; shift ;;
        -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option: $1" ;;
        *) names+=("$1") ;;
    esac
    shift
done

resolve() { # NAME -> UUID (directory under extensions/)
    local n="$1" u
    while IFS= read -r u; do
        if [[ "$u" == "$n" || "${u%%@*}" == "$n" ]]; then echo "$u"; return 0; fi
    done < <(list_extensions)
    die "no such extension: $n"
}

uuids=()
if [[ ${#names[@]} -eq 0 ]]; then
    while IFS= read -r u; do uuids+=("$u"); done < <(list_extensions)
else
    for n in "${names[@]}"; do uuids+=("$(resolve "$n")"); done
fi

if [[ $uninstall -eq 1 ]]; then
    for u in "${uuids[@]}"; do
        if [[ $enable -eq 1 ]]; then gnome-extensions disable "$u" 2>/dev/null || true; fi
        if [[ -d "$dest/$u" ]]; then rm -rf -- "${dest:?}/$u"; echo "removed $dest/$u"; fi
    done
    exit 0
fi

"$REPO_ROOT/scripts/build.sh"

# Compile translations of one extension into <target>/locale (no-op when it has no po/ directory).
compile_translations() { # src target gettext-domain
    local src="$1" target="$2" domain="$3" po lang
    [[ -d "$src/po" ]] || return 0
    command -v msgfmt >/dev/null || die "msgfmt (gettext) is required to install translations"
    for po in "$src"/po/*.po; do
        [[ -e "$po" ]] || continue
        lang="$(basename "$po" .po)"
        mkdir -p "$target/locale/$lang/LC_MESSAGES"
        msgfmt -o "$target/locale/$lang/LC_MESSAGES/$domain.mo" "$po"
    done
}

for u in "${uuids[@]}"; do
    src="$EXT_DIR/$u"
    target="$dest/$u"
    mkdir -p "$dest"
    rm -rf -- "${target:?}"
    mkdir -p "$target"
    cp -r "$src"/. "$target"/
    domain="$(sed -n 's/.*"gettext-domain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/metadata.json")"
    compile_translations "$src" "$target" "${domain:-$u}"
    echo "installed $target"
    if [[ $enable -eq 1 ]]; then
        gnome-extensions enable "$u" || echo "could not enable $u yet (log out and back in, then run: gnome-extensions enable $u)" >&2
    fi
done
