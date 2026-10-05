# Nested-shell bench: design notes and pitfalls

The bench plays animation scenarios inside a **nested, headless GNOME Shell** and checks what is actually
painted, frame by frame, against an independent model of the expected motion. It is not part of
`tests/run.sh` (it starts a Shell): run it with `tests/bench/run.sh`.

## Layout

| Path | Role |
|---|---|
| `run.sh` | Entry point: builds the embedded toolkit copies, runs suites x passes through `nested.sh`, then `report.py` |
| `nested.sh` | Starts the nested Shell with every isolation guard (see below), plays scenarios over D-Bus |
| `suites.json` | Suites: scenarios, repository extensions to enable, system extensions, dconf key files |
| `report.py`, `test_report.py` | Verdicts (curves, state, checks, frame loss against a witness, Shell log); pure tests of the report |
| `bench-extension/m3e-bench@.../` | The extension installed in the nested Shell only: D-Bus API (`Run`, `Result`, `Ping`), `Scene` helpers, scenarios |
| `dconf/` | Key files merged into the nested Shell's private dconf database |
| `out/` | Default output (git-ignored): `<timestamp>/<suite>/pass-N/<scenario>.json`, `shell.log`, PNG captures, `report.html` |

Suites: `core` (spring engine, curves, corners effect, transition patterns: needs no extension under test),
`motion` (the `m3e-motion` extension on real client windows, overview, panels, tiles, switch...),
`extensions` (`m3e-extensions` with Dash to Dock, and `status-bar`).

## Safety design (kept from the original bench, do not weaken)

* `gnome-shell --headless --virtual-monitor 1920x1080@60 --wayland --wayland-display m3e-bench-<pid>`: no window in the
  real session, a socket name that can never be `wayland-N`.
* **Every XDG_* variable, including `XDG_RUNTIME_DIR`, is exported before `dbus-run-session`.** Services activated on
  the private bus (dconf-service above all) inherit the environment of the bus daemon, not of the Shell: without this,
  a `set_boolean()` in the nested Shell would be written to the real `~/.config/dconf/user`.
* The inner part refuses to run unless `TMP`, all `XDG_*` and the bus are the private ones, and no `WAYLAND_DISPLAY` or
  `DISPLAY` of the host is inherited.
* Guards after the run: modification time of the real dconf database (exit code 3), entries of the host runtime
  directory (exit code 4). A change may also come from the real session writing at the same time: the message says so.
* `GDM_GREETER_TEST=1` in `--mode gdm`; the nested Shell is cut from the real logind session (`logind-guard.js`) so a
  lock/unlock of the real session cannot lock the nested one and the nested one never writes `LockedHint`.
* Only the PID of the Shell started by the script is ever signalled; client windows are killed through their own
  `Gio.Subprocess` handle.
* The only environment variables that can be injected into the Shell are `M3E_BENCH_*`.
* The locale is explicit (`C.UTF-8` unless `--locale`); the host locale is never inherited.
* Scenarios that write settings (`no-animations`, `motion-no-animations`) write the PRIVATE dconf database; the
  stylesheet scenario refuses to write outside the private `XDG_CONFIG_HOME`.

## How judgements are made

* Curves: the expected value is recomputed with `spring.js` / `curve.js` / `tokens.js` only (never with the engine under
  test) and compared on every painted frame: <= 0.5 px (radius), <= 0.01 for opacity / 255 and unit values. A single
  pass over the limit fails.
* Lost frames: an interval above 1.5 x the median period. Single-actor scenarios are compared with the witness
  `ease-witness` (the Shell's own `ease()` over a similar travel) as a **rate**; the median of the passes must stay under
  1.5 x the witness rate (1 per second when the witness loses nothing). One pass is noisy on very short animations: use
  `--passes 3` (the default).
* The Shell log of every pass must contain no destroyed-object access, assertion, JS error or GJS critical.

## Pitfalls found while building the bench

* `Clutter.Timeline.set_progress_func` is unusable from GJS: the double returned by the callback is lost. The toolkit
  therefore drives every property with one `Clutter.Timeline` per property and writes the value on `new-frame`.
* `Clutter.Interval` does not clamp progress to [0, 1] (overshooting modes extrapolate); the `Interval` needs
  `value_type: GObject.TYPE_FLOAT` for a `gfloat` property; use the canonical dashed property name in a
  `PropertyTransition`.
* A still scene paints no frames: `waitFrames(n)` must be bounded (`Promise.race` with a delay), otherwise a scenario
  hangs ("no result"). An actor with opacity 0 is not painted either: its effect diagnostic dates from an earlier frame
  (hence the `frame` counter of `RoundedCorners._diagnostic()`).
* An effect animated through `@effects.<name>.<prop>` must call `queue_repaint()` when the property changes, otherwise
  the timeline advances without painting.
* The off-screen texture of `ClutterOffscreenEffect` (mutter 18) is not at (0, 0): its box is the paint volume enlarged by
  `_clutter_actor_box_enlarge_for_effects` (+3 px, content shifted by 2 px for a whole actor) and it is rendered at
  `ceil(resource scale)`. A shader that assumes the content at the texture origin shifts corners by about 2 px.
  `corners-texture` checks the size mutter really allocates against the one `corners.js` expects.
* `Shell.GLSLEffect.add_glsl_snippet` takes `Cogl.SnippetHook` (`gi://Cogl`), and an exception inside a vfunc is only
  logged: the `glsl` scenario collects it so it cannot conclude "ok" by mistake.
* The nested Shell's 60 s timer (`extensionSystem.js`) removes `gnome-shell-disable-extensions` from its runtime
  directory: this is why the runtime directory must be private (an earlier bench removed the real one).
* `Meta.Window.maximize()` / `unmaximize()` take no argument in Shell 50.
* GIO's inotify backend rescans missing paths every few seconds: a file created in a directory that did not exist when
  it was watched can be noticed several seconds late (the `stylesheet-reload` scenario waits up to 8 s).
* Dash to Dock's `show-mounts` / `show-trash` start the `org.freedesktop.FileManager1` client, which activates the
  file manager on the private bus (and the extensions of the file manager): they are switched off in the private dconf
  database (`dconf/dash-to-dock.keyfile`).
* Screencasts go through PipeWire, whose socket is in the host runtime directory: screenshots use
  `Shell.Screenshot` from the bench extension instead.

## Theme

Scenarios do not need the m3e-gnome theme, but some measurements are theme-dependent (tile radii, panel geometry):
pass `--theme-css <gnome-shell.css of the theme>` to load it in the nested Shell, on top of the default theme.

## Not covered

Real input devices (presses go through test seams), real displays and fractional scales (the virtual monitor is
1920x1080 at scale 1, 60 Hz), the lock screen, other Shell versions than 50.
