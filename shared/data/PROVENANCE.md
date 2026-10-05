# Provenance of the motion data

Everything under `shared/m3e/tokens.js` and `shared/generated/` is derived, by `tools/generate.py`, from
the three files in this directory. Nothing is measured at build time.

## `m3e-tokens.json`

Verbatim copy of `dev/reference/m3e-tokens.json` of the companion theme repository
(`m3e-gnome`), where it is generated from the Material 3 token sources of Jetpack Compose. Only its
`ExpressiveMotion` section is read here (the six `Spring<Name>Stiffness` / `Spring<Name>Damping` values of
the Default/Fast/Slow x Spatial/Effects springs). The file keeps the schema of its producer
(`{"type": ..., "valeur": ...}`); do not edit it, re-copy it.

* Upstream: https://github.com/androidx/androidx, folder
  `compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/`,
  commit `41edc910b2c7cf284c302543b435bfc7d2df1e49` (androidx-main, 2026-10-02), file
  `ExpressiveMotionTokens.kt`.
* License of the upstream sources: Apache License 2.0, Copyright The Android Open Source Project
  (see `NOTICE.md`).

## `patterns-source.json`

Parameters of the transition patterns (container transform, shared axis, fade through, fade, morph).
Distances, scales and fade thresholds come from Material Components Android
(https://github.com/material-components/material-components-android, commit
`60ff09436d5d477a4b9d02940f31eb01e1250620`, `lib/java/com/google/android/material/transition/`, Apache-2.0).
MDC drives these patterns with durations and curves, not springs: the spring of each pattern is an M3E
design choice and is marked `M3E-visual:` in its `_origin` field. Every scalar has an `<field>_origin`
sibling: `mdc-android/transition/<File>:<line>` refers to that pinned commit.

## `android-source.json`

Android 17 motions transposed to the desktop (springs, fixed-duration curves, durations, lengths in dp).
`_origin` prefixes and the pinned sources they refer to:

| Prefix | Repository | Ref / commit |
|---|---|---|
| `aosp-frameworks-base/` | platform/frameworks/base | android17-release, `94b4c163b7dfe5ce3607f7bb8456f9573f7de57d` |
| `aosp-frameworks-libs-systemui/` | platform/frameworks/libs/systemui | android17-release, `11e04f60f563aed48e4ec080bd7bde06bae1b2f3` |
| `aosp-launcher3/` | platform/packages/apps/Launcher3 | android17-release, `c612e6ece389f21c40f8cb9cd9a4b44239f00009` |
| `mdc-android/` | github.com/material-components/material-components-android | `60ff09436d5d477a4b9d02940f31eb01e1250620` |
| `androidx/` | github.com/androidx/androidx | `6b45c1e0aeb147a52524e2550cb0300f2873bff1` |

AOSP sources are Apache-2.0 (Copyright The Android Open Source Project). Line numbers refer to those pinned
files. Fields tagged `measured:` (the quick-settings shade spring and distances) were fitted by the
author on a screen recording of a Pixel 10 Pro; the recording and the fitting tool are not part of this
repository, so those values cannot be re-derived from here.

## Derived artefacts

* `tools/compose_ref.py` is a Python port of Compose `SpringSimulation` / `SpringEstimation`
  (androidx `compose/animation/animation-core`, Apache-2.0).
* `tests/unit/data/reference-values.json` is produced by `python3 tools/compose_ref.py --write <file>` from
  that port (a grid of states and durations per spring). The JavaScript engine (`shared/m3e/spring.js`)
  is checked against it: the reference is therefore a second port, not Kotlin output.
* GTK table: `tools/generate.py` fits one CSS `cubic-bezier` per spring on a 40 px displacement
  (`tools/bezier.py`, Nelder-Mead) and reports the maximum error.
