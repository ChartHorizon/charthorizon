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
    "PERIOD", "SETTLE_READY_ET", "eastern_now", "latest_settled_eod_date",
    "cache_path", "build_payload", "write_payload", "prune",
]

PERIOD = "5y"
SETTLE_READY_ET = time(17, 30)
# write_payload's temps (".ch_*.tmp") older than this belong to a killed writer: a live one
# holds its temp for the length of one json.dump.
STALE_TEMP_SECONDS = 3600


def eastern_now() -> datetime:
    """Current New York time; dateutil keeps this Python 3.7 compatible."""
    if ZoneInfo is not None:
        return datetime.now(ZoneInfo("America/New_York"))
    from dateutil import tz
    return datetime.now(tz.gettz("America/New_York"))


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


def build_payload(symbol: str, period: str, history: list, settled_through: date,
                  fetched_at: float) -> dict:
    return {
        "symbol": symbol,
        "period": period,
        "source": "yfinance",
        "contract_type": "single_expiry_month",
        "history": history,
        # Which settle this answer was built for, and when: _contract_history_is_current.
        "settled_through": settled_through.isoformat(),
        "fetched_at": fetched_at,
    }


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
