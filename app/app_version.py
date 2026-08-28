# ── app_version.py ── Single source of truth for the dashboard's own version number.
#
# Shown in the Settings tab ("About" card, served by /api/version in start.py) and
# meant to be the one place a release bumps. The per-OS installer builds still take
# the version as an argument (`packaging/macos/build_dmg.sh <ver>` etc.), so keep the
# two in step: bump this constant in the same commit that cuts a release, BEFORE
# building the installers — otherwise an installed 1.1.4 keeps reporting 1.1.3.
#
# Deliberately dependency-free (no project imports) so the server can read it before
# anything else is set up, and so the frozen bundle always carries it.

from __future__ import annotations

APP_VERSION = "1.1.3"
