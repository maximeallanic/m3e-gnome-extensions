# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub: *Security* tab, *Report a vulnerability*. Do not open a
public issue. Include the extension and its version, your GNOME Shell version and what an attacker can do. You will get
an answer within a week.

## Scope

GNOME Shell extensions run inside the Shell process with its full privileges. These extensions do not spawn
subprocesses, do not open network connections and only read files under the user's own configuration and data
directories. Reports about code in this repository that breaks one of those properties, leaks into other users'
data, or lets untrusted input crash or hijack the Shell are in scope.

Vulnerabilities in GNOME Shell, mutter or Dash to Dock themselves belong to those projects.

## Supported versions

Only the latest release.
