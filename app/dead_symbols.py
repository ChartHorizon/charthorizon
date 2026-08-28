# ── dead_symbols.py ── Memo of contract symbols Yahoo has purged, so the nightly scan
# stops asking for them. Pure and file-backed: no network, no yfinance import.
#
# The 12-month lookback in the liquid-continuous scan walks a year of expired contracts
# per market — that history is REQUIRED (it is what the historical volume-led continuous
# is built from), so expiry alone is never a reason to skip. Only a symbol Yahoo has
# actually stopped serving may be skipped, and only under two rules that each guard a
# real failure:
#
#   1. Never memoize on an error or a 429. A rate-limited symbol looks exactly like an
#      empty one at the call site, and memoizing it would turn one throttled night into
#      permanently missing data.
#   2. Never memoize a contract whose expiry is still ahead. Those legitimately return
#      empty today and trade later; the calendar spread's deferred leg is built from
#      precisely those months (see _contract_is_pre_active_for_day).

from __future__ import annotations

import json
import os
import tempfile
from datetime import date, datetime

REPROBE_DAYS = 30   # a memo entry expires, so a Yahoo-side restoration is picked up


def _parse(value):
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def load(path):
    """The memo, or {} for a missing/corrupt/unreadable file. Never raises: a broken
    memo must cost extra requests, never a failed refresh."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            memo = json.load(f)
    except (OSError, ValueError):
        return {}
    return memo if isinstance(memo, dict) else {}


def save(path, memo):
    """Atomic write (tempfile + os.replace), so a crash cannot leave half a JSON file
    that every later load would have to discard. Best-effort: a filesystem problem
    costs the memo, not the refresh."""
    try:
        directory = os.path.dirname(path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".dead_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(memo, f, ensure_ascii=False, sort_keys=True)
            os.replace(tmp, path)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except OSError:
        pass


def is_dead(memo, symbol, today):
    """True if `symbol` was confirmed purged and the entry has not aged out.

    REPROBE_DAYS is a TTL counted from the day the entry was confirmed: it stays
    dead for the days strictly inside that window and re-probes exactly ON the
    REPROBE_DAYS-th day, mirroring record_empty's own boundary rule below (an
    expiry equal to `today` is "not yet past" and refused). The symmetric reading
    here is that an age equal to REPROBE_DAYS is "no longer within the grace
    window" — so it must re-probe rather than stay memoized one day longer.
    """
    entry = memo.get(symbol)
    if not isinstance(entry, dict):
        return False
    confirmed = _parse(entry.get("confirmed"))
    if confirmed is None:
        return False
    return (today - confirmed).days < REPROBE_DAYS


def record_empty(memo, symbol, expiry, today):
    """Memoize `symbol` as purged. Returns True if it was recorded.

    CALL THIS ONLY when the request SUCCEEDED and returned zero rows — never from an
    exception handler. Refuses any contract whose expiry is missing, unparseable, or
    not strictly in the past."""
    expiry_date = _parse(expiry)
    if expiry_date is None or expiry_date >= today:
        return False
    memo[symbol] = {"confirmed": today.strftime("%Y-%m-%d")}
    return True
