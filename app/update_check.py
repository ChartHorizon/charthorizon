# ── update_check.py ── "A newer ChartHorizon is out": the one question the app asks
# chart-horizon.com.
#
# The website publishes /version.json, rendered by Jekyll from the same `dl_version` (and
# per-platform `dl_macos` / `dl_windows` / `dl_linux` switches) that drive the download
# buttons on /dashboard/. Nothing here needs bumping at a release: the file changes in the
# very step that makes the new installers downloadable, and not before.
#
# The website promises "your data never leaves your machine", and this module is written
# to keep that true:
#   - the request is a bare GET of a static file — no query string, no cookie, no ID, and
#     neither the running version nor the OS (the User-Agent is just "ChartHorizon"). The
#     comparison happens HERE, after the answer has arrived;
#   - nothing is asked until the user says so (operator decision 2026-11-08): the automatic
#     daily check is OFF on a fresh installation and has to be switched on in Settings →
#     About, and "Check now" there asks once, on the click, without switching it on;
#   - switched on, it asks at most once a day (CHECK_INTERVAL_SECONDS), and only when an open
#     page asks for it — never in card mode, so the content bot's server never phones out;
#   - an unreadable settings file counts as switched OFF. A switch that protects privacy
#     fails closed: the Settings card then shows it off, and turning it on rewrites the file.
#
# Stdlib only (plus net_tls), like contract_history_cache.py: start.py imports this before
# the launcher has installed any third-party package.

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.request

import atomic_replace
import net_tls

UPDATE_URL = "https://chart-horizon.com/version.json"
# Deliberately the bare page, not /from-dashboard: that path counts the logo clicks in the
# header and must not be diluted by a second entry point (see index.html).
DOWNLOAD_URL = "https://chart-horizon.com/dashboard/"

CHECK_INTERVAL_SECONDS = 24 * 3600
RETRY_AFTER_FAILURE_SECONDS = 3600
FETCH_TIMEOUT_SECONDS = 5
MAX_BYTES = 16384            # the real file is ~150 bytes; anything this size is not it

_VERSION_RE = re.compile(r"\d{1,4}(?:\.\d{1,4}){0,3}")
_PLATFORMS = ("macos", "windows", "linux")
_lock = threading.Lock()     # the server is threaded; two tabs must not both ask


def parse_version(value):
    """'1.3.2' → (1, 3, 2, 0). Anything that is not plain dotted digits → None, so a
    'v'-prefixed, pre-release or garbled string can never compare as newer."""
    if not isinstance(value, str) or not _VERSION_RE.fullmatch(value):
        return None
    parts = [int(p) for p in value.split(".")]
    return tuple(parts + [0] * (4 - len(parts)))


def is_newer(candidate, current):
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def platform_key(sys_platform):
    if sys_platform == "darwin":
        return "macos"
    if sys_platform.startswith("win"):
        return "windows"
    if sys_platform.startswith("linux"):
        return "linux"
    return None


def _valid_doc(doc):
    """The release document, reduced to what is used, or None if it is not one."""
    if not isinstance(doc, dict) or parse_version(doc.get("version")) is None:
        return None
    out = {"version": doc["version"]}
    platforms = doc.get("platforms")
    if platforms is not None:
        if not isinstance(platforms, dict):
            return None
        out["platforms"] = {k: (v if parse_version(v) is not None else None)
                            for k, v in platforms.items() if k in _PLATFORMS}
    return out


def latest_for(doc, platform, frozen):
    """The newest version THIS installation could download. An installer reads its own
    platform's entry — a release can ship one OS at a time, and the page holds the others
    at "Coming soon" — while a source run reads the release version itself."""
    if not doc:
        return None
    platforms = doc.get("platforms")
    if frozen and isinstance(platforms, dict):
        return platforms.get(platform) if platform else None
    return doc.get("version")


def fetch_release_doc(timeout=FETCH_TIMEOUT_SECONDS):
    """GET /version.json and return the validated document. Raises on any failure."""
    req = urllib.request.Request(
        UPDATE_URL, headers={"User-Agent": "ChartHorizon", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout,
                                context=net_tls.https_context()) as resp:
        status = getattr(resp, "status", 200)
        if status != 200:
            raise ValueError("HTTP %s" % status)
        body = resp.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError("answer too large")
    doc = _valid_doc(json.loads(body.decode("utf-8")))
    if doc is None:
        raise ValueError("not a release document")
    return doc


# ── The settings file (ff_data/update_check.json) ────────────────────────────────────

def _load(path):
    """(state, readable). A missing file is a fresh installation: switched on."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        return {}, True
    except (OSError, ValueError):
        return {}, False
    return (state, True) if isinstance(state, dict) else ({}, False)


def _save(path, state):
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".upd_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(state, ensure_ascii=False))
            f.flush()
            os.fsync(f.fileno())
        atomic_replace.replace_with_retry(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _due(state, now):
    checked = state.get("checked_at")
    failed = state.get("failed_at")
    if isinstance(failed, (int, float)) and now - failed < RETRY_AFTER_FAILURE_SECONDS:
        return False
    return not isinstance(checked, (int, float)) or now - checked >= CHECK_INTERVAL_SECONDS


def status(path, current, platform, frozen, now=None, fetch=None, force=False):
    """What the page needs to know. Asks the website when the automatic check is on and
    due, or at once when `force` is set (the "Check now" button); a failed request keeps
    the last good answer and waits an hour before the automatic check tries again.

    The last answer is reported whether or not the automatic check is on: a stored answer
    can only be OLDER than the real latest release, so it can never announce an update that
    does not exist."""
    now = time.time() if now is None else now
    fetch = fetch or fetch_release_doc
    with _lock:
        state, readable = _load(path)
        auto = readable and state.get("auto") is True
        if force or (auto and _due(state, now)):
            try:
                doc = _valid_doc(fetch())
                if doc is None:
                    raise ValueError("not a release document")
                state.update(release=doc, checked_at=now)
                state.pop("failed_at", None)
            except Exception:
                state["failed_at"] = now
            try:
                _save(path, state)
            except OSError:
                pass          # best effort: the answer is still right for this request
        latest = latest_for(_valid_doc(state.get("release")), platform, frozen)
        newer = is_newer(latest, current)
        checked = state.get("checked_at")
        return {
            "auto": auto,
            "failed": "failed_at" in state,      # the most recent attempt did not get through
            "current": current,
            "latest": latest,
            "newer": newer,
            "dismissed": newer and state.get("dismissed") == latest,
            "checked_at": (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(checked))
                           if isinstance(checked, (int, float)) else None),
            "url": DOWNLOAD_URL,
        }


def set_auto(path, on):
    """The automatic-check switch. Turning it on clears the last check so the next status()
    asks at once — the user just asked for it. Raises on a failed write (the endpoint answers
    500: a 200 that stored nothing would show a switch that did not switch)."""
    with _lock:
        state, _ = _load(path)
        state["auto"] = bool(on)
        if on:
            state.pop("checked_at", None)
            state.pop("failed_at", None)
        _save(path, state)


def dismiss(path, version):
    """Hide the notice for this one version; the next release is shown again."""
    if parse_version(version) is None:
        raise ValueError("not a version")
    with _lock:
        state, _ = _load(path)
        state["dismissed"] = version
        _save(path, state)
