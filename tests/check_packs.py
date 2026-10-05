#!/usr/bin/env python3
"""Sanity-check the zip files produced by scripts/pack.sh before uploading them to extensions.gnome.org.

Checks, per zip: metadata.json is valid and its uuid matches the file name; extension.js is present; the
declared shell-version is non-empty; every relative ES import resolves to a file inside the zip; no
build leftovers or binaries; no file above the 500-line source limit (vendored data and generated tokens excluded).

Usage: check_packs.py DIRECTORY
"""
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath

IMPORT_RE = re.compile(r"""(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"](\.{1,2}/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")
FORBIDDEN_SUFFIXES = (".pyc", ".orig", ".rej", ".swp", "~", ".so", ".o")
FORBIDDEN_PARTS = {"__pycache__", ".git", "node_modules"}
GENERATED = {"tokens.js"}
LINE_LIMIT = 500


def check(path):
    errors = []
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if z.testzip() is not None:
            errors.append("corrupt zip")
        if "metadata.json" not in names:
            return ["metadata.json missing"]
        meta = json.loads(z.read("metadata.json"))
        expected = path.name.removesuffix(".shell-extension.zip")
        if meta.get("uuid") != expected:
            errors.append(f"uuid {meta.get('uuid')!r} does not match file name {expected!r}")
        for key in ("name", "description", "shell-version"):
            if not meta.get(key):
                errors.append(f"metadata.json: {key} missing or empty")
        if "extension.js" not in names:
            errors.append("extension.js missing")
        for name in sorted(names):
            parts = set(PurePosixPath(name).parts)
            if parts & FORBIDDEN_PARTS or name.endswith(FORBIDDEN_SUFFIXES):
                errors.append(f"unwanted file in zip: {name}")
            if name.endswith(".js"):
                source = z.read(name).decode("utf-8")
                if source.count("\n") + 1 > LINE_LIMIT and PurePosixPath(name).name not in GENERATED:
                    errors.append(f"{name}: more than {LINE_LIMIT} lines")
                base = PurePosixPath(name).parent
                for match in IMPORT_RE.finditer(source):
                    target = match.group(1) or match.group(2)
                    resolved = PurePosixPath(*base.parts, *PurePosixPath(target).parts)
                    parts_out = []
                    for part in resolved.parts:
                        if part == "..":
                            if parts_out:
                                parts_out.pop()
                        elif part != ".":
                            parts_out.append(part)
                    if "/".join(parts_out) not in names:
                        errors.append(f"{name}: import {target!r} does not resolve inside the zip")
    return errors


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    from pathlib import Path
    zips = sorted(Path(sys.argv[1]).glob("*.shell-extension.zip"))
    if not zips:
        sys.exit(f"no *.shell-extension.zip in {sys.argv[1]}")
    failed = False
    for z in zips:
        errors = check(z)
        print(f"{'FAIL' if errors else 'ok  '} {z.name}")
        for e in errors:
            print(f"     {e}")
        failed = failed or bool(errors)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
