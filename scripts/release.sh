#!/usr/bin/env bash
# Check that the repository is ready to release VERSION, then print (never run) the tag commands.
#
#   scripts/release.sh [--ci] VERSION    VERSION like 0.1.0 or 0.2.0-rc1, without the leading v
#
# Checks: version format, CHANGELOG.md has a section for it, clean working tree, version-name of every
# extension and "version" of package.json equal VERSION, the tag does not exist yet.
# --ci (release workflow): skip the working-tree and tag checks, print nothing to run.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
ci=0
if [[ "${1:-}" == --ci ]]; then ci=1; shift; fi
version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: release.sh VERSION (like 0.1.0 or 0.2.0-rc1)"

"$REPO_ROOT/scripts/release-notes.sh" "$version" >/dev/null || die "CHANGELOG.md has no section [$version]"
if [[ $ci -eq 0 ]]; then
    [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || die "the working tree is not clean"
    if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then die "tag v$version already exists"; fi
fi

json_field() { # file key -> value of a top-level string field
    sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}
found="$(json_field "$REPO_ROOT/package.json" version)"
[[ "$found" == "$version" ]] || die "package.json version is '$found', expected $version"
while IFS= read -r uuid; do
    found="$(json_field "$EXT_DIR/$uuid/metadata.json" version-name)"
    [[ "$found" == "$version" ]] || die "$uuid: version-name is '$found', expected $version"
done < <(list_extensions)

[[ $ci -eq 0 ]] || { echo "versions consistent: $version"; exit 0; }
case "$version" in
    0.*|*-*) kind="a pre-release" ;;
    *) kind="a stable release" ;;
esac
echo "Ready: v$version will be published as $kind. Not done by this script (run them yourself, on main):"
echo "  git tag -s v$version -m 'v$version'     # or: git tag -a v$version -m 'v$version'"
echo "  git push origin v$version               # the Release workflow does the rest"
