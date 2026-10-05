#!/usr/bin/env bash
# Nested bench: plays scenarios in an isolated `gnome-shell --headless --wayland` (virtual monitor, private
# XDG_* directories, private D-Bus session bus, named Wayland socket). It never touches the real session.
#
# Usage: nested.sh [--scenarios s1,s2,...] [--out DIR] [--extension DIR] [--enable-ext DIR]...
#                  [--enable-uuid UUID]... [--dconf-keyfile FILE]... [--env K=V]... [--theme-css FILE] [--locale LOCALE] [--mode gdm]
#   --extension DIR  bench extension to install and enable (default: bench-extension/m3e-bench@... next to this
#                    script). Its uuid is read from DIR/metadata.json, its D-Bus name and object path from the keys
#                    "m3e-bench-name" / "m3e-bench-path".
#   --enable-ext DIR (repeatable) extension copied into the nested Shell's extension directory AND enabled
#                    (the extensions under test: extensions/<uuid> of this repository, embedded toolkit included).
#   --enable-uuid U  (repeatable) enable an extension already installed system-wide (e.g. Dash to Dock) in the
#                    nested Shell only.
#   --env K=V        (repeatable) K=V in the environment of the gnome-shell process only; K must start with
#                    M3E_BENCH_ (allow list: nothing that isolates the bench from the loader, dconf, GIO... can be set).
#   --theme-css FILE a pre-rendered Shell stylesheet (e.g. the m3e-gnome theme's gnome-shell.css) copied into the
#                    private data directory and exported as M3E_BENCH_THEME_CSS; without it the default GNOME theme is used.
#   --dconf-keyfile FILE (repeatable) dconf key file merged into the nested Shell's PRIVATE dconf database before it
#                    starts (e.g. settings of a third-party extension under test).
#   --locale LOC     locale of the nested Shell (default C.UTF-8); the host locale is never inherited.
#   --mode gdm       Shell in login-screen mode (gnome-shell --mode=gdm), same guards; GDM_GREETER_TEST=1 is set by this
#                    script so that LoginDialog does not connect to the GDM daemon as a greeter.
# Exit codes: 0 ok; 1 a scenario failed; 2 refusal/usage; 3 the real dconf database changed; 4 the host runtime
# directory (XDG_RUNTIME_DIR) was modified by the bench.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# Prints uuid, D-Bus name and object path of the extension in DIR (three lines).
read_metadata() {
    python3 - "$1/metadata.json" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
uuid = m["uuid"]
name = m.get("m3e-bench-name", "io.github.maximeallanic.M3eBench")
path = m.get("m3e-bench-path", "/io/github/maximeallanic/M3eBench")
if not re.fullmatch(r"[A-Za-z0-9_.@-]+", uuid) or "/" in uuid or uuid.startswith("."):
    sys.exit(f"invalid uuid: {uuid!r}")
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+", name):
    sys.exit(f"invalid D-Bus name: {name!r}")
if not re.fullmatch(r"(/[A-Za-z0-9_]+)+", path):
    sys.exit(f"invalid object path: {path!r}")
print(uuid); print(name); print(path)
PY
}

valid_env() { [[ "$1" =~ ^M3E_BENCH_[A-Z0-9_]*= ]]; }
valid_locale() { [[ "$1" =~ ^[A-Za-z0-9_.@-]+$ ]]; }

if [[ "${1:-}" != "--inner" ]]; then
    SCENARIOS='animations'
    OUT=''
    EXTENSION="$HERE/bench-extension/m3e-bench@maximeallanic.github.io"
    UNDER_TEST=()
    SYSTEM_UUIDS=()
    ENVS=()
    DCONF_FILES=()
    THEME_CSS=''
    LOCALE='C.UTF-8'
    MODE=user
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --scenarios) SCENARIOS="${2:?}"; shift 2 ;;
            --out) OUT="${2:?}"; shift 2 ;;
            --extension) EXTENSION="${2:?}"; shift 2 ;;
            --enable-ext)
                [[ -f "${2:-}/metadata.json" ]] || { echo "--enable-ext without metadata.json: ${2:-}" >&2; exit 2; }
                read_metadata "$2" >/dev/null || exit 2
                UNDER_TEST+=("$(cd "$2" && pwd)"); shift 2 ;;
            --enable-uuid)
                [[ "${2:-}" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "--enable-uuid: invalid uuid: ${2:-}" >&2; exit 2; }
                SYSTEM_UUIDS+=("$2"); shift 2 ;;
            --dconf-keyfile)
                [[ -f "${2:-}" ]] || { echo "--dconf-keyfile: no such file: ${2:-}" >&2; exit 2; }
                DCONF_FILES+=("$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"); shift 2 ;;
            --env)
                valid_env "${2:-}" || { echo "--env: only M3E_BENCH_*=... keys are accepted: ${2:-}" >&2; exit 2; }
                ENVS+=("$2"); shift 2 ;;
            --theme-css)
                [[ -f "${2:-}" ]] || { echo "--theme-css: no such file: ${2:-}" >&2; exit 2; }
                THEME_CSS="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
            --locale)
                valid_locale "${2:-}" || { echo "--locale: invalid: ${2:-}" >&2; exit 2; }
                LOCALE="$2"; shift 2 ;;
            --mode)
                case "${2:-}" in
                    user|gdm) MODE="$2" ;;
                    *) echo "--mode: user or gdm expected: ${2:-}" >&2; exit 2 ;;
                esac
                shift 2 ;;
            *) echo "unknown option: $1" >&2; exit 2 ;;
        esac
    done
    [[ -f "$EXTENSION/metadata.json" ]] || { echo "extension without metadata.json: $EXTENSION" >&2; exit 2; }
    EXTENSION="$(cd "$EXTENSION" && pwd)"
    read_metadata "$EXTENSION" >/dev/null || exit 2
    [[ -n "$OUT" ]] || OUT="$(mktemp -d)"
    mkdir -p "$OUT" || exit 2
    OUT="$(cd "$OUT" && pwd)"
    # The temporary XDG_* directories are exported BEFORE dbus-run-session: services activated on the private bus
    # (dconf-service above all, which writes the settings) inherit the environment of the bus daemon, not the
    # Shell's. Without this, a set_boolean() in the nested Shell would land in the real ~/.config/dconf/user.
    # dconf guard: modification time of the REAL dconf database (same path dconf uses: real XDG_CONFIG_HOME, else
    # ~/.config), read before changing the XDG_* and compared afterwards. The real session may also write in the
    # meantime: a change fails the bench so that someone checks.
    DCONF_REAL="${XDG_CONFIG_HOME:-$HOME/.config}/dconf/user"
    dconf_date() { stat -c '%y' "$DCONF_REAL" 2>/dev/null || echo absent; }
    DCONF_BEFORE="$(dconf_date)"
    # Host runtime directory guard (XDG_RUNTIME_DIR, shared with the real session): the nested Shell has its own
    # ($TMP/run). Entries before/after; a bench entry created or a sensitive entry gone -> exit code 4.
    HOST_RUN="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is not set}"
    list_run() { find "$HOST_RUN" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort; }
    RUN_BEFORE="$(list_run)"
    TMP="$(mktemp -d)" || exit 2
    # Private XDG_RUNTIME_DIR, BEFORE dbus-run-session (like the XDG_*): Wayland socket, gnome-shell-disable-extensions,
    # Xwayland auth, dconf shm, portals... go to $TMP/run. PipeWire and Pulse stay the host's. Neither WAYLAND_DISPLAY
    # nor DISPLAY of the host: the nested Shell is headless.
    mkdir -m 0700 "$TMP/run" || exit 2
    export XDG_RUNTIME_DIR="$TMP/run" PIPEWIRE_RUNTIME_DIR="$HOST_RUN" PULSE_RUNTIME_PATH="$HOST_RUN/pulse" \
        M3E_BENCH_HOST_RUN="$HOST_RUN"
    unset WAYLAND_DISPLAY DISPLAY
    mkdir -p "$TMP/data" || exit 2
    export XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" XDG_CACHE_HOME="$TMP/cache" \
        XDG_STATE_HOME="$TMP/state"
    # Markers checked by the inner part (TMP to delete, real bus to avoid).
    export M3E_BENCH_TMP="$TMP" M3E_BENCH_REAL_BUS="${DBUS_SESSION_BUS_ADDRESS:-}"
    M3E_BENCH_EXT_UNDER_TEST="$(IFS=:; echo "${UNDER_TEST[*]-}")"
    M3E_BENCH_ENABLE_UUIDS="$(IFS=:; echo "${SYSTEM_UUIDS[*]-}")"
    M3E_BENCH_DCONF_FILES="$(IFS=:; echo "${DCONF_FILES[*]-}")"
    export M3E_BENCH_EXT_UNDER_TEST M3E_BENCH_ENABLE_UUIDS M3E_BENCH_DCONF_FILES M3E_BENCH_LOCALE="$LOCALE" M3E_BENCH_THEME_SRC="$THEME_CSS"
    # No exec: the outer part must resume control for the dconf guard.
    dbus-run-session -- bash "$HERE/nested.sh" --inner "$SCENARIOS" "$OUT" "$TMP" "$EXTENSION" "$MODE" \
        ${ENVS[@]+"${ENVS[@]}"}
    code=$?
    RUN_AFTER="$(list_run)"
    BENCH_PATTERN='^(m3e-bench-|gnome-shell-disable-extensions$|\.mutter-Xwaylandauth\.|\.X[0-9]+-lock$)'
    created="$(comm -13 <(printf '%s\n' "$RUN_BEFORE") <(printf '%s\n' "$RUN_AFTER") | grep -E "$BENCH_PATTERN")"
    gone="$(comm -23 <(printf '%s\n' "$RUN_BEFORE") <(printf '%s\n' "$RUN_AFTER") |
        grep -E "$BENCH_PATTERN|^(wayland-|bus$|pipewire|pulse$|dconf$|doc$)")"
    DCONF_AFTER="$(dconf_date)"
    if [[ "$DCONF_AFTER" != "$DCONF_BEFORE" ]]; then
        echo "nested.sh: $DCONF_REAL changed during the bench: please check (the real session may write too)" >&2
        echo "nested.sh:   before: $DCONF_BEFORE; after: $DCONF_AFTER" >&2
        code=3
    fi
    if [[ -n "$created" || -n "$gone" ]]; then
        echo "nested.sh: $HOST_RUN changed during the bench (the real session may write there too: please check)" >&2
        [[ -n "$created" ]] && echo "nested.sh:   created: $(tr '\n' ' ' <<<"$created")" >&2
        [[ -n "$gone" ]] && echo "nested.sh:   gone: $(tr '\n' ' ' <<<"$gone")" >&2
        code=4
    fi
    exit $code
fi

# --- inner part: runs inside the private session bus ---
refuse() { echo "nested.sh --inner refused: $1" >&2; exit 2; }
SCENARIOS="$2"; OUT="$3"; TMP="$4"; EXTENSION="$5"; MODE="$6"
shift 6
[[ "$MODE" == user || "$MODE" == gdm ]] || refuse "unknown mode: $MODE"
ENVS=("$@")
for kv in ${ENVS[@]+"${ENVS[@]}"}; do valid_env "$kv" || refuse "--env not accepted: $kv"; done
{ read -r UUID; read -r NAME; read -r OBJ_PATH; } < <(read_metadata "$EXTENSION")
[[ -n "${UUID:-}" && -n "${NAME:-}" && -n "${OBJ_PATH:-}" ]] || { echo "unreadable metadata: $EXTENSION" >&2; exit 2; }
# Guards: TMP must be the directory created by the outer part (nettoyer deletes it), every XDG_* inside it, and the
# bus must not be the real one.
[[ -n "${M3E_BENCH_TMP:-}" && "$TMP" == "$M3E_BENCH_TMP" ]] || refuse "unexpected TMP: $TMP"
[[ "$TMP" == "${TMPDIR:-/tmp}"/tmp.* && -d "$TMP" ]] || refuse "TMP outside ${TMPDIR:-/tmp}/tmp.*: $TMP"
for v in XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME; do
    [[ "${!v:-}" == "$TMP"/* ]] || refuse "$v is not temporary: ${!v:-}"
done
[[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" && "$DBUS_SESSION_BUS_ADDRESS" != "${M3E_BENCH_REAL_BUS:-}" ]] ||
    refuse "real session bus"
[[ "${XDG_RUNTIME_DIR:-}" == "$TMP/run" && -d "$TMP/run" && "$XDG_RUNTIME_DIR" != "${M3E_BENCH_HOST_RUN:-}" ]] ||
    refuse "XDG_RUNTIME_DIR is not private: ${XDG_RUNTIME_DIR:-}"
[[ -z "${WAYLAND_DISPLAY:-}" && -z "${DISPLAY:-}" ]] || refuse "WAYLAND_DISPLAY/DISPLAY of the host inherited"
valid_locale "${M3E_BENCH_LOCALE:-}" || refuse "invalid locale"
SHELL_PID=''
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
    if [[ -n "$SHELL_PID" ]] && kill -0 "$SHELL_PID" 2>/dev/null; then
        kill "$SHELL_PID" 2>/dev/null
        for _ in $(seq 1 50); do kill -0 "$SHELL_PID" 2>/dev/null || break; sleep 0.1; done
        kill -9 "$SHELL_PID" 2>/dev/null
    fi
    # A mount (documents portal in $TMP/run/doc, gvfs...) under TMP: unmounted, otherwise TMP is left alone
    # (rm -rf would traverse the mount).
    local m
    # shellcheck disable=SC2013  # mount points under TMP contain no spaces (mktemp)
    for m in $(awk -v t="$TMP/" 'index($2, t) == 1 { print $2 }' /proc/mounts); do
        fusermount3 -u -z "$m" 2>/dev/null || fusermount -u -z "$m" 2>/dev/null || umount -l "$m" 2>/dev/null
    done
    if awk -v t="$TMP/" 'index($2, t) == 1 { found = 1 } END { exit !found }' /proc/mounts; then
        echo "nested.sh: mount still active under $TMP: directory left in place" >&2
    else
        rm -rf "$TMP"
    fi
}
trap cleanup EXIT

EXT_ROOT="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$XDG_CONFIG_HOME/dconf" "$EXT_ROOT" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
EXT="$EXT_ROOT/$UUID"
cp -r "$EXTENSION" "$EXT"
# The bench extension embeds its own copy of the toolkit (shared/m3e), like every extension that uses it.
mkdir -p "$EXT/m3e"
cp "$REPO"/shared/m3e/*.js "$EXT/m3e/" || { echo "cannot copy shared/m3e" >&2; exit 1; }

ENABLED="'$UUID'"
if [[ -n "${M3E_BENCH_EXT_UNDER_TEST:-}" ]]; then
    IFS=: read -ra UNDER_LIST <<<"$M3E_BENCH_EXT_UNDER_TEST"
    for d in "${UNDER_LIST[@]}"; do
        u="$(read_metadata "$d" | head -1)" || { echo "unreadable extension: $d" >&2; exit 2; }
        [[ "$u" != "$UUID" && ! -e "$EXT_ROOT/$u" ]] || continue
        cp -r "$d" "$EXT_ROOT/$u"
        # Embedded toolkit: copied if the extension is built to embed it and has no copy yet.
        if grep -q "^$u\$" <(sed -e 's/#.*//' "$REPO/shared/embedded-by.txt" | tr -d ' ') && [[ ! -d "$EXT_ROOT/$u/m3e" ]]; then
            mkdir -p "$EXT_ROOT/$u/m3e"
            cp "$REPO"/shared/m3e/*.js "$EXT_ROOT/$u/m3e/"
        fi
        ENABLED="$ENABLED, '$u'"
    done
fi
if [[ -n "${M3E_BENCH_ENABLE_UUIDS:-}" ]]; then
    IFS=: read -ra SYS_LIST <<<"$M3E_BENCH_ENABLE_UUIDS"
    for u in "${SYS_LIST[@]}"; do ENABLED="$ENABLED, '$u'"; done
fi
if [[ -n "${M3E_BENCH_THEME_SRC:-}" ]]; then
    mkdir -p "$TMP/data/m3e-bench-theme"
    cp "$M3E_BENCH_THEME_SRC" "$TMP/data/m3e-bench-theme/theme.css"
    export M3E_BENCH_THEME_CSS="$TMP/data/m3e-bench-theme/theme.css"
fi

# External D-Bus search providers disabled (disable-external): activated on the private bus they would still
# search the real home directory (HOME is the real one).
mkdir -p "$XDG_CONFIG_HOME/dconf/keyfiles" "$TMP/dconf-src"
cat > "$TMP/dconf-src/bench.keyfile" <<K
[org/gnome/shell]
enabled-extensions=[$ENABLED]
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
enable-animations=true

[org/gnome/desktop/search-providers]
disable-external=true
K
if [[ -n "${M3E_BENCH_DCONF_FILES:-}" ]]; then
    IFS=: read -ra DCONF_LIST <<<"$M3E_BENCH_DCONF_FILES"
    n=0
    for f in "${DCONF_LIST[@]}"; do cp "$f" "$TMP/dconf-src/extra-$((n++)).keyfile"; done
fi
# User dconf database (used through XDG_CONFIG_HOME)
dconf compile "$XDG_CONFIG_HOME/dconf/user" "$TMP/dconf-src" || { echo "dconf compile failed" >&2; exit 1; }

# Wayland socket name of the bench (m3e-bench-PID), inside the private XDG_RUNTIME_DIR ($TMP/run): never a
# wayland-N, and a bench client targets it by name.
# --headless (virtual monitor) rather than --devkit: no window in the real session, hence no dependency on its
# Wayland socket.
# --env: set for gnome-shell only (env), never in this script (TMP, OUT... must stay untouched).
# --mode gdm: login screen; GDM_GREETER_TEST=1 stops LoginDialog from connecting to the GDM daemon (the system
# greeter): the nested Shell never talks to the real GDM as a greeter.
# Locale: inherited locale variables removed, the explicit locale set.
LOCALE_ENV=()
for v in $(compgen -e); do
    [[ "$v" =~ ^(LANG|LANGUAGE|LC_[A-Z]+)$ ]] && LOCALE_ENV+=(-u "$v")
done
LOCALE_ENV+=("LANG=$M3E_BENCH_LOCALE")
MODE_ARGS=()
MODE_ENV=()
if [[ "$MODE" == gdm ]]; then
    MODE_ARGS=(--mode=gdm)
    MODE_ENV=(GDM_GREETER_TEST=1)
fi
env "${LOCALE_ENV[@]}" "M3E_BENCH_OUT=$OUT" ${ENVS[@]+"${ENVS[@]}"} ${MODE_ENV[@]+"${MODE_ENV[@]}"} \
    gnome-shell --headless --virtual-monitor 1920x1080@60 --wayland \
    --wayland-display "m3e-bench-$$" ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} >"$OUT/shell.log" 2>&1 &
SHELL_PID=$!

call_bench() { # method [argument]
    gdbus call --session --dest "$NAME" --object-path "$OBJ_PATH" \
        --method "$NAME.$1" ${2:+"$2"} 2>&1
}

ready=0
for _ in $(seq 1 120); do
    kill -0 "$SHELL_PID" 2>/dev/null || { echo "the Shell stopped (see $OUT/shell.log)" >&2; exit 1; }
    if call_bench Ping >/dev/null; then ready=1; break; fi
    sleep 0.5
done
if [[ $ready -ne 1 ]]; then
    echo "D-Bus name missing: $NAME (see $OUT/shell.log)" >&2
    exit 1
fi

code=0
IFS=',' read -ra LIST <<<"$SCENARIOS"
for s in "${LIST[@]}"; do
    call_bench Run "$s" >/dev/null || { echo "Run $s failed" >&2; code=1; continue; }
    json=''
    for _ in $(seq 1 480); do
        reply="$(call_bench Result "$s")" || { echo "Result $s failed: $reply" >&2; break; }
        # reply = ('...',) ; extract the string with python
        json="$(python3 -c 'import sys,ast; print(ast.literal_eval(sys.stdin.read().strip())[0])' <<<"$reply")"
        [[ -n "$json" ]] && break
        sleep 0.25
    done
    if [[ -z "$json" ]]; then
        echo "scenario $s: no result" >&2; code=1; continue
    fi
    printf '%s\n' "$json" >"$OUT/$s.json"
    if python3 -c 'import sys,json; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("type")!="error" and d.get("ok",True) else 1)' "$OUT/$s.json"; then
        echo "scenario $s: ok"
    else
        echo "scenario $s: error (see $OUT/$s.json)" >&2; code=1
    fi
done
exit $code
