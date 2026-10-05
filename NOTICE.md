# Third-party notices

The code of this repository is released under the MIT License (see `LICENSE`). The items below are
derived from, or are data taken from, third-party projects. They keep their own licenses.

## Material 3 / Compose Material 3 tokens and motion (Apache License 2.0)

- Project: AndroidX, <https://github.com/androidx/androidx>, pinned commit
  `41edc910b2c7cf284c302543b435bfc7d2df1e49`.
- Used for: the Material 3 Expressive motion tokens (spring stiffness and damping values, token names)
  vendored in `shared/data/m3e-tokens.json`, and the spring solver and settling-time estimation in
  `shared/m3e/spring.js` and `tools/compose_ref.py`, which are ports of `SpringSimulation.kt` and
  `SpringEstimation.kt` (`compose/animation/animation-core`).
- Copyright 2024 The Android Open Source Project. Licensed under the Apache License, Version 2.0
  (<https://www.apache.org/licenses/LICENSE-2.0>).

## Material Components for Android (Apache License 2.0)

- Project: <https://github.com/material-components/material-components-android>, pinned commit
  `60ff09436d5d477a4b9d02940f31eb01e1250620`.
- Used for: the parameters of the transition patterns (shared axis slide distance, fade thresholds, container
  transform fade windows and fit mode) recorded in `shared/data/patterns-source.json`.
- Copyright 2017-2026 The Android Open Source Project. Apache License 2.0.

## Android framework and AOSP apps (Apache License 2.0)

- Project: <https://source.android.com/>.
- Used for: animation parameters (durations, curves, spring constants) of Android 17 transitions that the
  extensions reproduce (`shared/data/android-source.json` lists the upstream file and line of each value).
  Only numeric parameters are used; no AOSP source code is copied.

## Material Symbols (Apache License 2.0)

- Project: <https://github.com/google/material-design-icons> (Material Symbols, Google).
- Used for: the "bolt" glyph path embedded in the status-bar battery indicator.
- Licensed under the Apache License, Version 2.0.

## GNOME Shell (GPL-2.0-or-later)

The extensions run inside GNOME Shell and patch or wrap some of its JavaScript classes at run time. No GNOME Shell
source is copied into this repository. The MIT License of this repository is compatible with the GPL requirement of
extensions.gnome.org.

## Dash to Dock (GPL-2.0-or-later)

`m3e-extensions` detects Dash to Dock (`dash-to-dock@micxgx.gmail.com`) and patches the prototypes of its
objects at run time; nothing of Dash to Dock is redistributed.
