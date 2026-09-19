# ── packaging_fingerprint.py ── One definition of "which build recipe made this binary".
#
# WHY THIS LIVES IN app/ AND NOT IN packaging/
#
# The Windows installer is built by hand in a VM that holds its OWN copy of the tree
# (C:\ch), synced with two robocopy calls — one for app/, one for packaging/. For a long
# time only the first was documented, and a build from a stale packaging/ still succeeds:
# it just quietly follows the previous recipe. That is how the ctypes.wintypes hidden
# import 1.2.3's liveness fix depends on reached the Mac build and never the Windows one,
# and how build_win.ps1's own guards went missing from the machine they guard.
#
# A check cannot close that hole from inside packaging/: EVERY file in the build chain
# (build_win.ps1, build_icons.py, charthorizon.spec, charthorizon.iss) lives there, so a
# tree that was not synced runs the OLD script and any guard written into the new one
# never executes. The check has to be anchored in a tree that is always fresh — app/ is
# the only one, because a stale app/ is what Guard 2 in build_win.ps1 already refuses and
# what /api/version would expose immediately.
#
# So: charthorizon.spec calls this at BUILD time and bakes the digest of the packaging
# tree it is sitting in into the bundle; start.py reports that baked value from
# /api/version; and the Mac prints what the digest OUGHT to be
# (tools/packaging-fingerprint.py) from the live tree. A stale packaging/ bakes the
# previous digest, and the two no longer agree. The comparison is Mac-side, on a value
# the VM cannot fake by being out of date.
#
# Deliberately dependency-free (stdlib only, no project imports): the spec imports it
# before PyInstaller has analysed anything, and it must also run under whatever Python
# the VM has.

from __future__ import annotations

import hashlib
import os

# The files that decide HOW the app is built. Icons are left out — build_icons.py
# regenerates them into packaging/icons/ during the build, so hashing them would make the
# fingerprint depend on its own output. Documentation (packaging/README.md,
# packaging/public/*.md) is left out for the opposite reason: it changes nothing about the
# binary, and a digest that moves on a typo trains the operator to ignore it.
RECIPE_SUFFIXES = (".spec", ".py", ".ps1", ".iss", ".sh")
SKIP_DIRS = frozenset({"icons", "public", "__pycache__"})

# The one exception to "public/ is documentation": RISK-NOTICE.txt is COMPILED INTO the
# Windows installer (charthorizon.iss, LicenseFile) and shipped inside the bundle
# (charthorizon.spec), so its bytes decide what the installer puts in front of the user and
# what the app installs beside itself. A stale copy in the VM would build an installer
# showing the previous notice, quietly -- exactly the failure this digest exists to catch.
# Relative to the packaging dir, posix-style; a path listed here that does not exist is
# simply absent from the digest, so removing the file moves it too.
RECIPE_EXTRA = ("public/RISK-NOTICE.txt",)

FINGERPRINT_FILE = "packaging_fingerprint.txt"     # baked into the bundle root by the spec
_DIGEST_CHARS = 12                                 # a fingerprint is read by eye, not by machine


def recipe_files(packaging_dir):
    """Every recipe file under `packaging_dir`, as (relative posix path, absolute path),
    ordered by the relative path so macOS and Windows agree on the order."""
    found = []
    for root, dirs, names in os.walk(packaging_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if name.endswith(RECIPE_SUFFIXES):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, packaging_dir).replace(os.sep, "/")
                found.append((rel, full))
    for rel in RECIPE_EXTRA:
        full = os.path.join(packaging_dir, *rel.split("/"))
        if os.path.isfile(full):
            found.append((rel, full))
    found.sort()
    return found


def packaging_fingerprint(packaging_dir):
    """Short digest over the build recipe in `packaging_dir`.

    Names and bytes both, so a renamed or deleted recipe file moves the digest as surely
    as an edited one. Read as bytes — robocopy copies verbatim, so the two machines see
    identical content and must not be allowed to disagree over a line ending."""
    h = hashlib.sha256()
    for rel, full in recipe_files(packaging_dir):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(full, "rb") as f:
            h.update(f.read())
        h.update(b"\0")
    return h.hexdigest()[:_DIGEST_CHARS]
