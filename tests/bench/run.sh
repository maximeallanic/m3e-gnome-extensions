#!/usr/bin/env bash
# Runs bench suites in a nested, headless Shell (nested.sh) and prints the verdict (report.py).
#
#   tests/bench/run.sh [--suite NAME[,NAME...]] [--scenarios s1,s2,...] [--passes N] [--out DIR]
#                      [--theme-css FILE] [--list]
#
#   --suite      suites of suites.json (default: core). Each suite lists the scenarios, the repository extensions
#                enabled in the nested Shell and the system extensions (e.g. Dash to Dock) it needs.
#   --scenarios  run exactly these scenarios instead of a suite's list (extensions of the suite are still enabled).
#   --passes     number of passes (default 3, like the original bench: the verdict uses medians); the report judges every pass.
#   --out        output directory (default: tests/bench/out/<timestamp>, git-ignored).
#   --theme-css  pre-rendered Shell stylesheet of the m3e-gnome theme, loaded in the nested Shell on top of the
#                default theme. Scenarios that read themed geometry need it; without it they may fail.
#   --list       list the suites and their scenarios, then exit.
#
# NOT part of tests/run.sh: it starts a nested gnome-shell (headless, virtual monitor, private runtime directory,
# private D-Bus session and dconf database; see nested.sh for the guards). Exit code 0 only if every verdict is OK.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

SUITES=core
SCENARIOS=''
PASSES=3
OUT=''
THEME_CSS=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --suite) SUITES="${2:?}"; shift 2 ;;
        --scenarios) SCENARIOS="${2:?}"; shift 2 ;;
        --passes) PASSES="${2:?}"; shift 2 ;;
        --out) OUT="${2:?}"; shift 2 ;;
        --theme-css) THEME_CSS="${2:?}"; shift 2 ;;
        --list)
            python3 - "$HERE/suites.json" <<'PY'
import json, sys
for name, s in json.load(open(sys.argv[1])).items():
    print(f"{name}: extensions={s['extensions']} system={s.get('systemExtensions', [])}")
    print("  " + ", ".join(s["scenarios"]))
PY
            exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ -n "$OUT" ]] || OUT="$HERE/out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)" || exit 2

"$REPO/scripts/build.sh" || exit 2

# suite_field NAME FIELD -> one value per line
suite_field() {
    python3 - "$HERE/suites.json" "$1" "$2" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))[sys.argv[2]]
v = s.get(sys.argv[3], [])
print("\n".join(v))
PY
}

status=0
IFS=',' read -ra SUITE_LIST <<<"$SUITES"
for suite in "${SUITE_LIST[@]}"; do
    suite_field "$suite" scenarios >/dev/null 2>&1 || { echo "unknown suite: $suite" >&2; exit 2; }
    mapfile -t EXTS < <(suite_field "$suite" extensions)
    mapfile -t SYS < <(suite_field "$suite" systemExtensions)
    mapfile -t DCONF < <(suite_field "$suite" dconfKeyfiles)
    if [[ -n "$SCENARIOS" ]]; then LIST="$SCENARIOS"; else LIST="$(suite_field "$suite" scenarios | paste -sd,)"; fi
    ARGS=()
    for e in "${EXTS[@]}"; do [[ -n "$e" ]] && ARGS+=(--enable-ext "$REPO/extensions/$e"); done
    for u in "${SYS[@]}"; do [[ -n "$u" ]] && ARGS+=(--enable-uuid "$u"); done
    for f in "${DCONF[@]}"; do [[ -n "$f" ]] && ARGS+=(--dconf-keyfile "$HERE/$f"); done
    [[ -n "$THEME_CSS" ]] && ARGS+=(--theme-css "$THEME_CSS")
    echo "== suite $suite -> $OUT/$suite"
    tr ',' '\n' <<<"$LIST" >"$OUT/$suite-expected.txt"
    DIRS=()
    for i in $(seq 1 "$PASSES"); do
        echo "-- pass $i / $PASSES"
        P="$OUT/$suite/pass-$i"
        mkdir -p "$P"
        bash "$HERE/nested.sh" --scenarios "$LIST" --out "$P" ${ARGS[@]+"${ARGS[@]}"}
        code=$?
        if [[ $code -eq 3 || $code -eq 4 ]]; then
            echo "pass $i: dconf or XDG_RUNTIME_DIR guard triggered (see above)" >&2
            status=1
        fi
        grep -E 'JS ERROR|m3e|Gjs-CRITICAL|Error parsing stylesheet' "$P/shell.log" | head -40
        DIRS+=("$P")
    done
    python3 "$HERE/report.py" --html "$OUT/$suite/report.html" --expected "$OUT/$suite-expected.txt" "${DIRS[@]}" ||
        status=1
done
exit $status
