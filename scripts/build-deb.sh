#!/usr/bin/env bash
# Build the Debian package gnome-shell-extension-m3e (all three extensions, system-wide).
#
#   scripts/build-deb.sh VERSION [--out DIR]
#
# VERSION is the release version (0.1.0, 0.2.0-rc1: a '-' becomes '~' so that the pre-release sorts first).
# Plain dpkg-deb, no debhelper: the package is a file tree plus three metadata files, nothing to compile.
# The result is DIR/gnome-shell-extension-m3e_<version>_all.deb (default DIR: dist/).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out="$REPO_ROOT/dist"
version=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) [[ $# -ge 2 ]] || die "--out needs a directory"; out="$2"; shift ;;
        -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option: $1" ;;
        *) [[ -z "$version" ]] || die "one VERSION only"; version="$1" ;;
    esac
    shift
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: build-deb.sh VERSION (like 0.1.0 or 0.2.0-rc1)"
command -v dpkg-deb >/dev/null || die "dpkg-deb is required (package dpkg)"

pkg="gnome-shell-extension-m3e"
debver="${version/-/\~}"
maintainer="Maxime Allanic <maximeallanic@users.noreply.github.com>"
# Reproducible output: every timestamp is the date of the last commit (or now outside a git checkout).
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}"

"$REPO_ROOT/scripts/build.sh"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
root="$stage/root"
share="$root/usr/share/gnome-shell/extensions"
doc="$root/usr/share/doc/$pkg"
mkdir -p "$share" "$doc" "$root/DEBIAN"

while IFS= read -r uuid; do
    src="$EXT_DIR/$uuid"
    cp -r "$src" "$share/$uuid"
    # Translations are compiled, never shipped as sources; schemas are compiled because the Shell does not
    # compile the schemas of a system-wide extension.
    if [[ -d "$share/$uuid/po" ]]; then
        command -v msgfmt >/dev/null || die "msgfmt (gettext) is required to build translations"
        domain="$(sed -n 's/.*"gettext-domain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/metadata.json")"
        for po in "$share/$uuid"/po/*.po; do
            [[ -e "$po" ]] || continue
            lang="$(basename "$po" .po)"
            mkdir -p "$share/$uuid/locale/$lang/LC_MESSAGES"
            msgfmt -o "$share/$uuid/locale/$lang/LC_MESSAGES/${domain:-$uuid}.mo" "$po"
        done
        rm -rf -- "$share/$uuid/po"
    fi
    if [[ -d "$share/$uuid/schemas" ]]; then
        command -v glib-compile-schemas >/dev/null || die "glib-compile-schemas is required to build schemas"
        glib-compile-schemas "$share/$uuid/schemas"
    fi
    [[ -f "$share/$uuid/metadata.json" && -f "$share/$uuid/extension.js" ]] || die "$uuid: incomplete extension"
done < <(list_extensions)

# Documentation: README, upstream changelog, third-party notices, a Debian-format changelog, the copyright file.
cp "$REPO_ROOT/README.md" "$REPO_ROOT/NOTICE.md" "$doc/"
cp "$REPO_ROOT/CHANGELOG.md" "$doc/CHANGELOG.md"
rfc_date="$(date -u -d "@$epoch" '+%a, %d %b %Y %H:%M:%S +0000')"
{
    printf '%s (%s) unstable; urgency=medium\n\n' "$pkg" "$debver"
    printf '  * Release %s. See CHANGELOG.md in this directory for the full list of changes.\n\n' "$version"
    printf ' -- %s  %s\n' "$maintainer" "$rfc_date"
} | gzip -9n > "$doc/changelog.gz"
gzip -9n "$doc/CHANGELOG.md"

{
    cat <<'HEAD'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: m3e-gnome-extensions
Upstream-Contact: Maxime Allanic <maximeallanic@users.noreply.github.com>
Source: https://github.com/maximeallanic/m3e-gnome-extensions

Files: *
HEAD
    echo "Copyright: 2026 Maxime Allanic"
    echo "License: MIT"
    echo
    cat <<'DATA'
Files: usr/share/gnome-shell/extensions/*/m3e/spring.js
Comment: Port of SpringSimulation.kt and SpringEstimation.kt from AndroidX
 (compose/animation/animation-core). The Material 3 Expressive token values
 and the transition parameters are data taken from AndroidX, Material
 Components for Android and the Android framework. See NOTICE.md in this
 directory for the exact sources and pinned commits.
Copyright: 2017-2026 The Android Open Source Project
License: Apache-2.0

License: Apache-2.0
 Licensed under the Apache License, Version 2.0. On Debian systems the full
 text is in /usr/share/common-licenses/Apache-2.0.

DATA
    echo "License: MIT"
    sed -n '5,$p' "$REPO_ROOT/LICENSE" | sed -e 's/^$/./' -e 's/^/ /'
} > "$doc/copyright"

# Normalise modes and timestamps, then compute the installed size.
find "$root" -type d -exec chmod 755 {} +
find "$root" -type f -exec chmod 644 {} +
size_kb="$(du -sk --apparent-size "$root" | cut -f1)"

cat > "$root/DEBIAN/control" <<CONTROL
Package: $pkg
Version: $debver
Architecture: all
Maintainer: $maintainer
Installed-Size: $size_kb
Depends: gnome-shell (>= 50)
Recommends: gnome-shell-extension-prefs
Section: gnome
Priority: optional
Homepage: https://github.com/maximeallanic/m3e-gnome-extensions
Description: Material 3 Expressive motion and status bar extensions for GNOME Shell
 Three GNOME Shell extensions that go with the m3e-gnome theme: M3E Motion
 (spring-based animations for windows, overview, menus and notifications),
 M3E for Extensions (dock animations) and Status Bar (Android style icons).
 .
 The extensions are installed system-wide but not enabled: enable the ones
 you want with gnome-extensions enable (see the note printed at install).
CONTROL

cat > "$root/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
    echo "M3E extensions are installed but not enabled. As your user, then after your next login, run:"
    echo "  gnome-extensions enable m3e-motion@maximeallanic.github.io"
    echo "  gnome-extensions enable m3e-extensions@maximeallanic.github.io"
    echo "  gnome-extensions enable status-bar@maximeallanic.github.io"
fi
exit 0
POSTINST
chmod 755 "$root/DEBIAN/postinst"

find "$root" -exec touch -h -d "@$epoch" {} +
mkdir -p "$out"
deb="$out/${pkg}_${debver}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb" >/dev/null
echo "built $deb"
