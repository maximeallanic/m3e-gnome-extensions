# Governance

`m3e-gnome-extensions` is a small, maintainer-led project. This page says how decisions are made so that contributors know what to
expect. The companion repository is [m3e-gnome](https://github.com/maximeallanic/m3e-gnome); both follow these rules.

## Roles

- **Maintainer** (currently [@maximeallanic](https://github.com/maximeallanic)): reviews and merges pull requests,
  cuts releases, moderates, and has the final say when consensus is not reached.
- **Contributor**: anyone who opens an issue, a pull request, a review or a discussion. No contract, no CLA: your
  contribution is licensed under the repository licence (MIT), the same as the rest of the code.
- **Reviewer / co-maintainer**: invited by the maintainer after a sustained record of good contributions (several
  merged pull requests, helpful reviews, a good grasp of the design rules below). Co-maintainers get triage rights
  first, then write access.

## How a change gets merged

1. Open an issue first for anything bigger than a small fix, so that the direction is agreed before you spend time.
   Label proposals `proposal`; they stay open for discussion for at least a week unless they are obviously small.
2. Fork, branch, open a pull request against `main` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
3. CI must be green, and a maintainer must approve. Review comments are conversations, not verdicts: all must be
   resolved before merging.
4. The maintainer squash-merges with a [Conventional Commits](https://www.conventionalcommits.org/) title. The pull
   request title becomes the commit message, so write it as one.

Decisions are made by **lazy consensus**: if nobody with a good reason objects, the proposal goes ahead. When
contributors disagree, the maintainer decides and writes down why in the issue.

## Design rules that decide most debates

These are project choices, not accidents; a change that breaks one needs a strong argument in an issue first.

- Look and motion follow Material 3 Expressive and the Android reference, at desktop density.
- No bold text anywhere in the theme.
- Colours come from the wallpaper palette roles; no hard-coded brand colours.
- The installer never leaves the user's home and never needs root, except for the explicitly opt-in steps.
- Nothing is hard-coded to one human language or script.
- Every external source is pinned and verified.

## Releases

Semantic Versioning, recorded in `CHANGELOG.md`. The maintainer tags a release after CI passes and the pins have been
re-checked. Only the latest release is supported (see [SECURITY.md](SECURITY.md)).

## Conduct and disputes

Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report problems privately as described there.

## Changing this document

Open a pull request. Governance changes need the maintainer's approval and a week of discussion.

## Forks

Forks are welcome. If the design rules above are not what you want, a fork is the right place to change them.
