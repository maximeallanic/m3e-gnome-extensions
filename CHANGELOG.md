# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-06

First public release (pre-release: run for real on the author's Debian machine with GNOME Shell 50.5, and in
nested headless shells).

### Added

- First public release of the three extensions, extracted from a private desktop setup:
  `m3e-motion`, `m3e-extensions` and `status-bar`.
- Shared motion toolkit (`shared/m3e`), embedded into the extensions that use it by `scripts/build.sh`.
- `scripts/install.sh` (user-level install, `--enable`, `--uninstall`) and `scripts/pack.sh`
  (zip files for extensions.gnome.org).
- Unit tests, static checks, a nested-shell test bench and CI.
- Release packaging: `scripts/build-deb.sh` (the `gnome-shell-extension-m3e` Debian package, system-wide install
  under `/usr/share/gnome-shell/extensions`, nothing enabled for you), a tag-triggered release workflow
  (tests, `.deb`, extensions.gnome.org zips, source tarball, `SHA256SUMS`, build provenance attestation),
  `scripts/release.sh` and `scripts/release-notes.sh`.

### Known limitations

- Validated on GNOME Shell 50.5 only (`shell-version` is `["50"]`).
- The `.deb` was verified by unpacking it and comparing it with the user-level install, not by installing it with
  `dpkg` on a live system.

[Unreleased]: https://github.com/maximeallanic/m3e-gnome-extensions/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/maximeallanic/m3e-gnome-extensions/releases/tag/v0.1.0
