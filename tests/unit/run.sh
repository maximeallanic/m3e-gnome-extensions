#!/usr/bin/env bash
# Runs the headless unit tests: every test_*.js with `gjs -m`, then the python unittest suite.
# Safe for the real session: no window, no Shell, no D-Bus, no nested compositor. Exit 0 only if all pass.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0

for f in "$here"/test_*.js; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if output="$(gjs -m "$f" 2>&1)"; then
        echo "PASS  $name ($(grep -c '^ok ' <<<"$output") tests)"
    else
        echo "FAIL  $name"
        echo "$output"
        status=1
    fi
done

if output="$(python3 -m unittest discover -s "$here" -p 'test_*.py' 2>&1)"; then
    echo "PASS  python unittest: $(grep -E '^Ran ' <<<"$output")"
else
    echo "FAIL  python unittest"
    echo "$output"
    status=1
fi

if [ "$status" -eq 0 ]; then echo "All unit tests passed."; else echo "Some unit tests failed."; fi
exit "$status"
