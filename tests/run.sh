#!/usr/bin/env bash
# Run every headless check of the repository. Safe for any session: no window is opened, nothing is written
# outside the repository and temporary directories. The nested-shell bench (tests/bench) is NOT run here.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2
status=0

step() { # name command...
    local name="$1"; shift
    if out="$("$@" 2>&1)"; then
        echo "PASS  $name"
    else
        echo "FAIL  $name"; echo "$out"; status=1
    fi
}

step "embedded toolkit copies" bash -c 'scripts/build.sh && scripts/build.sh --check'
step "generated files up to date" python3 tools/generate.py --check
step "shared toolkit unit tests" tests/unit/run.sh
for f in tests/unit/*/test_*.js; do
    [[ -e "$f" ]] || continue
    step "$f" gjs -m "$f"
done
step "bench report tests" python3 tests/bench/test_report.py
step "install / uninstall" tests/test_install.sh
step "deb package" tests/test_deb.sh
if [[ -x node_modules/.bin/eslint ]]; then
    step "eslint" node_modules/.bin/eslint .
else
    echo "SKIP  eslint (run 'npm ci' first)"
fi
if command -v shellcheck >/dev/null; then
    step "shellcheck" bash -c "find . -name '*.sh' -not -path './node_modules/*' -not -path './m3e-motion-src/*' -print0 | xargs -0 shellcheck -x"
else
    echo "SKIP  shellcheck (not installed)"
fi
[[ $status -eq 0 ]] && echo "All checks passed." || echo "Some checks failed."
exit $status
