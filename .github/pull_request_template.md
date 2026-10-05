## What and why

## Checklist

- [ ] `tests/run.sh` passes locally
- [ ] `disable()` restores everything `enable()` touched (no leaked signal, source, actor or patched method)
- [ ] No user-facing string is hardcoded in one language (strings go through gettext)
- [ ] `CHANGELOG.md` updated
