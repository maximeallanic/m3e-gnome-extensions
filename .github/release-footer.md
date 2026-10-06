## Tested on

- Debian (testing) with GNOME Shell 50.5, on the author's machine, plus headless unit tests and nested-shell
  runs. Nothing else has been tried: other distributions, GNOME versions and X11 are untested.
- The `.deb` was checked by unpacking it and comparing it with the user-level install, not by installing it with
  `dpkg` on a live system.

## Install

- Debian/Ubuntu: `sudo apt install ./gnome-shell-extension-m3e_VERSION_all.deb`, then log out and in and run
  `gnome-extensions enable <uuid>` (nothing is enabled for you).
- Other distributions: unzip a `<uuid>.shell-extension.zip` with `gnome-extensions install --force <zip>`.

## Verify the download

```sh
sha256sum -c SHA256SUMS
gh attestation verify <file> --repo maximeallanic/m3e-gnome-extensions
```
