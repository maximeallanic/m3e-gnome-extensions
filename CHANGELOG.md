# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- First public release of the three extensions, extracted from a private desktop setup:
  `m3e-motion`, `m3e-extensions` and `status-bar`.
- Shared motion toolkit (`shared/m3e`), embedded into the extensions that use it by `scripts/build.sh`.
- `scripts/install.sh` (user-level install, `--enable`, `--uninstall`) and `scripts/pack.sh`
  (zip files for extensions.gnome.org).
- Unit tests, static checks, a nested-shell test bench and CI.
