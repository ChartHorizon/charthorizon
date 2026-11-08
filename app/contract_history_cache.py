"""The contract-history cache file and the settle cutoff, in one stdlib-only place.

Two processes touch ``ff_data/contract_history/``: the web server (``start.py``) and the
data generator subprocess. If each kept its own idea of the file's shape and of when a
session counts as settled, a file written by one could be judged stale or malformed by the
other. So both import this module. It imports nothing outside the stdlib at module level
(start.py loads it before the launcher has installed dateutil); the exchange calendar is
imported lazily inside the function that needs it.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import date, datetime, time, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python 3.7
    ZoneInfo = None

__all__ = [
    "PERIOD", "SETTLE_READY_ET", "EXPIRED_SETTLE_DAYS", "eastern_now",
    "latest_settled_eod_date", "cache_path", "build_payload", "is_complete_answer",
    "write_payload", "keep", "prune",
]

PERIOD = "5y"
SETTLE_READY_ET = time(17, 30)
# write_payload's temps (".ch_*.tmp") older than this belong to a killed writer: a live one
# holds its temp for the length of one json.dump.
STALE_TEMP_SECONDS = 3600
# How long after its last trading day a contract's history is taken as final, so that one
# answer serves every later settle (is_complete_answer). A margin, not a measurement: the
# scheduled expiry (compute_expiry) can sit a few days off the exchange's real one.
EXPIRED_SETTLE_DAYS = 7


def _eastern_tz():
    if ZoneInfo is not None:
        return ZoneInfo("America/New_York")
    from dateutil import tz
    return tz.gettz("America/New_York")


def eastern_now() -> datetime:
    """Current New York time; dateutil keeps this Python 3.7 compatible."""
    return datetime.now(_eastern_tz())


def _is_session_day(day: date) -> bool:
    """A US futures session: a weekday that is not an exchange holiday. The holiday table is
    the generator's own (calendar_utils), imported lazily."""
    from calendar_utils import _is_business_day
    return _is_business_day(day)


def _latest_business_day_on_or_before(day: date) -> date:
    while not _is_session_day(day):
        day -= timedelta(days=1)
    return day


def _previous_business_day(day: date) -> date:
    return _latest_business_day_on_or_before(day - timedelta(days=1))


def latest_settled_eod_date(now_et: datetime) -> date:
    """Latest session date whose settled EoD bar should already exist from yfinance.

    17:30 ET is a practical delay buffer after the US futures close; before that, today's
    bar has not settled yet, so the previous session is the latest settled date. It is a
    requirement as well as a trim (cache refetch, card-mode refusal), which is why exchange
    holidays count: trimming past a date with no bar is harmless, demanding a Labor Day bar
    would refuse every card all evening.
    """
    today = now_et.date()
    if not _is_session_day(today):
        return _latest_business_day_on_or_before(today)
    if now_et.time() < SETTLE_READY_ET:
        return _previous_business_day(today)
    return today


def cache_path(symbol: str, period: str, data_dir: str = "ff_data") -> str:
    safe_symbol = re.sub(r"[^A-Za-z0-9_.=-]+", "_", symbol)
    safe_period = re.sub(r"[^A-Za-z0-9_.=-]+", "_", period)
    return os.path.join(data_dir, "contract_history", f"{safe_symbol}_{safe_period}.json")


def build_payload(symbol: str, period: str, history: list, settled_through: date | None,
                  fetched_at: float, complete_for: date | None = None,
                  expiry: str | None = None,
                  contract_type: str = "single_expiry_month") -> dict:
    """The one file shape both processes read.

    `settled_through` is the server's: the settle this file can be served for without a
    refetch (_contract_history_is_current). The generator passes None for an answer whose
    rows stop before that settle (a thin month that did not print, or no rows at all), so the
    server refetches it at once instead of holding it behind its 600 s retry floor.

    `complete_for` and `expiry` are the generator's and only it writes them (the server's
    payload carries neither, so a file the server rewrites drops them): this file is Yahoo's
    whole answer as of the settle `complete_for` — see is_complete_answer."""
    payload = {
        "symbol": symbol,
        "period": period,
        "source": "yfinance",
        "contract_type": contract_type,
        "history": history,
        # Which settle this answer was built for, and when: _contract_history_is_current.
        "settled_through": settled_through.isoformat() if settled_through else None,
        "fetched_at": fetched_at,
    }
    if complete_for is not None:
        payload["complete_for"] = complete_for.isoformat()
    if expiry:
        payload["expiry"] = str(expiry)[:10]
    return payload


def _iso_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def is_complete_answer(payload, cutoff: date) -> bool:
    """True when the generator may take this file's rows instead of asking Yahoo, for the
    session settled at `cutoff`.

    The generator ingests settled bars only, so within one settle a second request can only
    return what the first one did. Three conditions make that safe:

      * the generator wrote it (`complete_for`): the rows are its own ingest rows, and a file
        the server rewrote carries no such field;
      * it was asked AFTER its session's calendar day ended in New York. A run straight after
        the settle (the 23:30 CET job is 17:30 ET) may hold a bar whose volume Yahoo is still
        completing; that file is asked again once, by the next run after midnight ET;
      * it answers this very settle — or the contract had expired more than
        EXPIRED_SETTLE_DAYS before the settle it answers, when nothing about it changes again.

    Anything unreadable is simply asked again."""
    if not isinstance(payload, dict) or not isinstance(payload.get("history"), list):
        return False
    complete_for = _iso_date(payload.get("complete_for"))
    if complete_for is None or complete_for > cutoff:
        return False
    try:
        fetched = datetime.fromtimestamp(float(payload.get("fetched_at")), _eastern_tz())
    except (TypeError, ValueError, OverflowError, OSError):
        return False
    if fetched.date() <= complete_for:
        return False
    if complete_for == cutoff:
        return True
    expiry = _iso_date(payload.get("expiry"))
    return expiry is not None and expiry + timedelta(days=EXPIRED_SETTLE_DAYS) < complete_for


def write_payload(path: str, payload: dict, replace=os.replace) -> bool:
    """Atomic best-effort write (temp file + fsync + replace). Returns False on any OSError,
    leaving no temp file behind; the cache is an optimisation, never a reason to fail."""
    cache_dir = os.path.dirname(path)
    tmp = None
    try:
        os.makedirs(cache_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=".ch_", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        replace(tmp, path)
        return True
    except OSError:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def keep(path: str) -> None:
    """Mark a file as still in use for prune(), which goes by mtime: a file the generator
    takes instead of rewriting is otherwise never touched again. Never raises."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def prune(max_age_days: float = 7, now_ts: float | None = None,
          data_dir: str = "ff_data") -> int:
    """Delete cached histories not written for ``max_age_days``, and write_payload temps
    older than STALE_TEMP_SECONDS; returns how many went.

    A refresh no longer wipes the cache (each file records the settle it was built for),
    so this is what stops contracts nobody opens any more from piling up. The temps are the
    other thing the old wipe used to take with it: write_payload removes its own on an
    OSError, but a writer that is killed (a closed console window, a reboot) runs no
    handler. Never raises.
    """
    import time
    now = time.time() if now_ts is None else now_ts
    cache_dir = os.path.join(data_dir, "contract_history")
    removed = 0
    try:
        names = os.listdir(cache_dir)
    except OSError:
        return 0
    for name in names:
        if name.endswith(".json"):
            max_age = max_age_days * 86400
        elif name.startswith(".ch_") and name.endswith(".tmp"):
            max_age = STALE_TEMP_SECONDS
        else:
            continue
        path = os.path.join(cache_dir, name)
        try:
            if now - os.path.getmtime(path) > max_age:
                os.remove(path)
                removed += 1
        except OSError:
            continue
    return removed
