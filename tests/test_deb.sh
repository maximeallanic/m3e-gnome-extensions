#!/usr/bin/env bash
# Build the .deb, unpack it into a throw-away root (never dpkg -i) and check that it holds exactly what
# scripts/install.sh installs, with the right metadata and nothing outside /usr/share.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
fail() { echo "not ok - $*" >&2; exit 1; }

if ! command -v dpkg-deb >/dev/null; then echo "skip - dpkg-deb not installed"; exit 0; fi

"$root/scripts/build-deb.sh" 0.1.0 --out "$tmp/out" >/dev/null
deb="$tmp/out/gnome-shell-extension-m3e_0.1.0_all.deb"
[[ -f "$deb" ]] || fail "no deb produced"
"$root/scripts/build-deb.sh" 0.2.0-rc1 --out "$tmp/out" >/dev/null
[[ -f "$tmp/out/gnome-shell-extension-m3e_0.2.0~rc1_all.deb" ]] || fail "pre-release version not mapped to ~"
echo "ok - build"

[[ "$(dpkg-deb -f "$deb" Architecture)" == all ]] || fail "architecture"
[[ "$(dpkg-deb -f "$deb" Depends)" == "gnome-shell (>= 50)" ]] || fail "depends"
dpkg-deb -c "$deb" | awk '{print $6}' | grep -q -v -E '^\./(usr(/share(/(doc(/gnome-shell-extension-m3e(/.*)?)?|gnome-shell(/extensions(/.*)?)?))?)?)?/?$|^\./$' \
    && fail "files outside /usr/share/{doc,gnome-shell/extensions}"
dpkg-deb -c "$deb" | awk '{print $1}' | grep -q -v -E '^(-rw-r--r--|drwxr-xr-x)$' && fail "unexpected file modes"
dpkg-deb -c "$deb" | awk '{print $2}' | grep -qvx 'root/root' && fail "files not owned by root"
dpkg-deb -e "$deb" "$tmp/ctl"
for s in preinst prerm postrm; do [[ ! -e "$tmp/ctl/$s" ]] || fail "unexpected maintainer script $s"; done
grep -q 'gnome-extensions enable' "$tmp/ctl/postinst" || fail "postinst does not print the enable note"
grep -q -v -E '^(#!|set -e|if |fi|exit 0|[[:space:]]*echo )' "$tmp/ctl/postinst" && fail "postinst does more than print a note"
echo "ok - metadata"

dpkg -x "$deb" "$tmp/root"
XDG_DATA_HOME="$tmp/data" "$root/scripts/install.sh" --dest "$tmp/user" >/dev/null
diff -r "$tmp/user" "$tmp/root/usr/share/gnome-shell/extensions" || fail "deb differs from scripts/install.sh output"
[[ -s "$tmp/root/usr/share/doc/gnome-shell-extension-m3e/copyright" ]] || fail "no copyright file"
grep -q '^License: MIT' "$tmp/root/usr/share/doc/gnome-shell-extension-m3e/copyright" || fail "copyright lacks MIT"
echo "ok - unpacked tree equals the user-level install"
echo "1..3"
