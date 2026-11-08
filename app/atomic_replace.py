# ── atomic_replace.py ── os.replace that survives a Windows reader holding the target.
# Stdlib only, on purpose: start.py imports it before the launcher has installed dateutil,
# and the generator subprocess imports it too, so both processes replace files the same way.

from __future__ import annotations

import os
import sys
import time

REPLACE_RETRIES = 10           # ~2.5 s total; a served file is let go long before that
REPLACE_RETRY_SLEEP = 0.25
WIN_SHARING_ERRORS = (5, 32)   # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION

__all__ = ["replace_with_retry"]


def replace_with_retry(tmp, path):
    """os.replace(tmp, path), retried while Windows says the target is in use.

    POSIX renames over an open file without a word. Windows does not: MoveFileEx has to
    open the destination for DELETE, and CPython's open() shares read and write but never
    delete — so replacing a file another process is reading fails outright with
    ERROR_SHARING_VIOLATION. The other process here is our own web server: http.server
    holds a file open for the whole response, and boot.js pulls all ~57 MB of category
    JSON through it *while a refresh runs* (start.py kicks one on every warm start). The
    progress file is the same story at a smaller scale: the server reads it for every
    /api/refresh-status poll, once a second from the page and from loading.html, while
    both the server and the generator write it.

    Uncaught, that surfaced as a refresh dying partway with a PermissionError traceback,
    having written some category files and not others and no new config.js at all — the
    half-updated state the atomic write exists to prevent, reached by a different road.
    The window is one response long, so a short retry closes it.

    Only the two sharing errors are retried; anything else (a full disk, a read-only
    folder) is raised on the first attempt, as before.
    """
    for attempt in range(REPLACE_RETRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:
            last = attempt == REPLACE_RETRIES - 1
            if last or not sys.platform.startswith("win"):
                raise
            if getattr(exc, "winerror", None) not in WIN_SHARING_ERRORS:
                raise
            time.sleep(REPLACE_RETRY_SLEEP)
