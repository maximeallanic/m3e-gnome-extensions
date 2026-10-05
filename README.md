# m3e-gnome-extensions

[![CI](https://github.com/maximeallanic/m3e-gnome-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maximeallanic/m3e-gnome-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GNOME 50](https://img.shields.io/badge/GNOME-50-4a86cf.svg)](#requirements)

Three GNOME Shell extensions that bring **Material 3 Expressive** (M3E) motion and a few Android-style
details to GNOME Shell 50. They are the companions of the
[m3e-gnome](https://github.com/maximeallanic/m3e-gnome) theme: the theme styles the Shell, these extensions
make it move and draw what CSS cannot.

<!-- screenshots -->
<p align="center">
  <img src="https://raw.githubusercontent.com/maximeallanic/m3e-gnome/main/screenshots/status-bar-dark.png" width="400" alt="Status Bar extension: Android-style status icons and battery pill, with the quick settings panel">
  <img src="https://raw.githubusercontent.com/maximeallanic/m3e-gnome/main/screenshots/alt-tab-dark.png" width="400" alt="Alt+Tab switcher styled by the theme, over windows animated by M3E Motion">
</p>

Screenshots come from the [m3e-gnome](https://github.com/maximeallanic/m3e-gnome) repository (nested Shell, demo data; see its
`screenshots/README.md`).


| Extension | UUID | What it does |
|---|---|---|
| **M3E Motion** | `m3e-motion@maximeallanic.github.io` | Replaces the Shell's animations with M3E choreographies driven by physical springs: container transform for app launch, minimise and restore, shared-axis transitions for workspaces and the app grid, fade for dialogs, spring-driven overview, OSD, banners, quick-settings shade. Also provides M3E components: switch, slider, popup menus, quick-settings tile morph. |
| **M3E for Extensions** | `m3e-extensions@maximeallanic.github.io` | Loads the theme's extension stylesheet (so third-party extensions get M3E colours and shapes, reloaded when the palette changes) and moves the [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/) slide and tooltips on M3E springs. Dash to Dock is optional. |
| **Status Bar** | `status-bar@maximeallanic.github.io` | Android-style top-bar status area: every status icon takes the width of its ink instead of a square frame, the volume indicator only shows when muted, and the battery is a pill with the percentage inside (lightning bolt while charging). |

## Requirements

- **GNOME Shell 50** (developed and checked on 50.5). Nothing is claimed for other versions: the extensions patch
  private Shell classes and fields (window manager, overview, quick settings, message tray), which change between
  releases. `metadata.json` therefore declares `"shell-version": ["50"]` only.
- **The [m3e-gnome](https://github.com/maximeallanic/m3e-gnome) theme** for the intended look. The extensions work
  without it (motion still runs) but styling hooks stay empty: see
  [What the theme must provide](#what-the-theme-must-provide).
- Optional: Dash to Dock (`dash-to-dock@micxgx.gmail.com`) for the dock animations of M3E for Extensions.
- To install from source: `bash`, `gnome-extensions` (shipped with GNOME Shell). To build zips: the same.
  For translations (none yet): `msgfmt`.

## Install

From extensions.gnome.org once published, or from source (no root, no network):

```sh
git clone https://github.com/maximeallanic/m3e-gnome-extensions
cd m3e-gnome-extensions
scripts/install.sh --enable          # all three; or: scripts/install.sh m3e-motion status-bar
```

`scripts/install.sh` embeds the shared toolkit, copies each extension to
`${XDG_DATA_HOME:-~/.local/share}/gnome-shell/extensions/<uuid>` and optionally enables it. A newly
copied extension is only discovered after you log out and in again; then run
`gnome-extensions enable <uuid>` (or use the Extensions app). Use `--dest DIR` to install somewhere else.

To produce zip files for upload to extensions.gnome.org:

```sh
scripts/pack.sh                       # writes dist/<uuid>.shell-extension.zip
python3 tests/check_packs.py dist     # sanity-check them
```

## Uninstall

```sh
scripts/install.sh --uninstall [--dest DIR] [NAME...]
```

This disables (when `--enable` is also given) and removes the extension directories. Disabling an extension in the
Extensions app restores the Shell: every extension undoes everything it patched in `disable()`.

## What the theme must provide

The extensions read these hooks from the Shell stylesheet and files from the user's configuration; the m3e-gnome
theme templates produce them.

**M3E Motion**
- Pseudo-classes `:m3e-first` and `:m3e-last` are set on message actors of the notification list (a lone message has
  both), so the sheet can round the outer corners of the list.
- Slider hooks read from the Shell's `BarLevel`: `-barlevel-height`, `-barlevel-background-color`,
  `-barlevel-active-background-color`, `-barlevel-overdrive-color`, `-barlevel-overdrive-separator-width`, and
  `-slider-handle-radius` on the slider.
- The switch handle (`.handle`, `:checked`) keeps its Shell structure; sizes are written inline by the extension.
- Container transforms read the top-left `border-radius` of the theme node of app icons, folder icons and the folder
  dialog to start and end the corner morph.
- Quick-settings tiles: radius, background and foreground colours come from the stylesheet; the extension animates
  them with inline styles.

**M3E for Extensions**
- The file `$XDG_CONFIG_HOME/m3e-gnome/m3e-extensions.css` (default `~/.config/m3e-gnome/m3e-extensions.css`),
  rendered by the theme's sync step. It is loaded as an extension stylesheet and reloaded when the file changes. If
  it is missing, a warning is logged once and nothing else happens.

**Status Bar**
- On `#panel .status-bar-battery`: `-status-bar-height` (pill height) and `-status-bar-low` (colour at 20 % or less).
  The charging colours (`-status-bar-charging`, `-status-bar-charging-text`) are in the extension's own stylesheet.
- The icon theme must write `data-ink-width="<fraction>"` on the root `<svg>` of status icons (the share of the frame
  covered by ink); the m3e-gnome Material-Symbols icon theme does. Icons without it keep their square frame.

## Compatibility

| | Verified | Not verified |
|---|---|---|
| GNOME Shell | 50.5 (Debian) | everything else |
| Session | Wayland, in the nested headless Shell of the bench (1920x1080, 60 Hz, scale 1) | Real displays, fractional scales, real input devices, lock screen, long-lived sessions |
| Languages | Percentages use `Intl.NumberFormat` and the drawing code handles RTL | Visual checks in non-Latin locales |

The nested-shell bench in `tests/bench` is the only runtime test of the extensions; see
[tests](#development-and-tests): at the time of writing 85 scenarios pass (core engine, motion, extensions; 3 passes each).

## Troubleshooting

- **Extension not listed after install**: log out and in again (GNOME 50 sessions are Wayland; the Shell cannot be restarted in place).
- **Extension shows "Error"**: `journalctl --user -b -o cat /usr/bin/gnome-shell | grep -E "m3e|status-bar"`;
  messages are prefixed with the extension name. A module that fails to enable is logged and undone; the others run.
- **Nothing is styled / colours look like stock GNOME**: install and apply the m3e-gnome theme; check that
  `~/.config/m3e-gnome/m3e-extensions.css` exists.
- **Icons in the top bar keep square spacing**: the active icon theme does not provide `data-ink-width`.
- **Animations do nothing**: the extensions honour GNOME's `org.gnome.desktop.interface enable-animations` setting; when it is off, the
  Shell sets states instantly and nothing moves.
- **Another animation extension is active**: extensions that replace the same Shell methods (window animations,
  overview) conflict; enable one at a time.

## Development and tests

```sh
npm ci                  # ESLint (dev only; the extensions need no Node)
tests/run.sh            # headless: unit tests, static checks, install test, eslint, shellcheck
scripts/build.sh        # embed shared/m3e into the extensions (done by install.sh and pack.sh)
python3 tools/generate.py --check   # generated tokens are current
```

`tests/bench/` is a nested-shell test bench (headless Shell with a virtual monitor, private runtime dir and bus). It
opens no window in your session, but it starts a second Shell and takes minutes: it is not part of `tests/run.sh`.
See `tests/bench/NOTES.md`.

Layout: `extensions/<uuid>/` (one directory per extension), `shared/m3e/` (the motion toolkit, the single source of
truth, embedded into `m3e-motion` and `m3e-extensions` as `m3e/` at build time), `shared/data/` (vendored token data
with provenance), `tools/` (token generator), `scripts/`, `tests/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Related projects

- [m3e-gnome](https://github.com/maximeallanic/m3e-gnome): the theme these extensions accompany. Its installer can
  install and enable all three extensions for you (`./install.sh --extensions-only`, or `--extensions-dir` with a local
  checkout of this repository), produces the stylesheet and icon theme they rely on, and keeps the palette in sync
  with the wallpaper. Documentation: [m3e-gnome docs](https://github.com/maximeallanic/m3e-gnome/blob/main/docs/index.md).

## Licenses

MIT for this repository's code (see [LICENSE](LICENSE)). Material 3 token values, spring maths and animation
parameters are derived from Apache-2.0 projects (AndroidX, Material Components for Android, AOSP): see
[NOTICE.md](NOTICE.md) and `shared/data/PROVENANCE.md`. GNOME Shell extensions are GPL-compatible by
extensions.gnome.org policy; MIT is.
