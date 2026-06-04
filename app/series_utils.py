"""Settled-EoD / series helpers: settle-date gating, rounding, trimming, median.

Split out of commodity_dashboard.py — see CLAUDE.md "Architecture".
"""

import os
import csv
import contextlib
import io
import json
import re
import urllib.request
import urllib.parse
from datetime import date, datetime, time, timedelta
from dateutil.relativedelta import relativedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None

try:
    import yfinance as yf
except ImportError:
    yf = None  # The script warns and still generates HTML with placeholders

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

# ---- cross-module dependencies (from the lower layers) ----
from market_config import (
    YF_EOD_BOARD_SETTLE_MIN_RATIO,
    YF_EOD_SETTLE_READY_ET,
    YF_VOLUME_SUSPECT_LOOKBACK,
    YF_VOLUME_SUSPECT_MIN_REFERENCE,
    YF_VOLUME_SUSPECT_RATIO,
)

__all__ = [
    'BLANK',
    'SPEC_PRIVATE_KEYS',
    '_bar_date',
    '_board_settled_eod_date',
    '_cap_series_to_date',
    '_coerce_iso_date',
    '_drop_unsettled_tail',
    '_eastern_now',
    '_latest_settled_eod_date',
    '_median',
    '_round_price',
    '_trim_leading_flat',
]



def _coerce_iso_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


SPEC_PRIVATE_KEYS = {
    "hours_session",
    "hours_windows",
    "hours_pauses",
}


# ─────────────────────────────────────────────────────────────────────
#  DATA FETCHING
# ─────────────────────────────────────────────────────────────────────
BLANK = {
    "last": None, "change": None, "change_pct": None,
    "volume": None, "open_interest": None, "available": False, "source": None,
}


def _trim_leading_flat(rows):
    """Removes leading placeholder bars (volume 0/None and O=H=L=C), which yfinance
    returns for far-dated contracts that are not actively traded yet. Such
    bars would otherwise appear as a long horizontal line at the chart start."""
    i, n = 0, len(rows)
    while i < n:
        r = rows[i]
        flat = r["open"] == r["high"] == r["low"] == r["close"]
        if flat and not r.get("volume"):
            i += 1
        else:
            break
    return rows[i:]


def _eastern_now():
    """Current New York time — futures settle on the US calendar. dateutil keeps 3.7 happy."""
    if ZoneInfo is not None:
        return datetime.now(ZoneInfo("America/New_York"))
    from dateutil import tz
    return datetime.now(tz.gettz("America/New_York"))


def _latest_settled_eod_date(now_et=None):
    """Latest business day whose futures session has settled, as of `now_et` (ET).

    Mirrors start.py's freshness gate: today's bar counts as a settled EoD only after
    YF_EOD_SETTLE_READY_ET; before that (and on weekends) the latest settled EoD is the
    previous business day."""
    now_et = now_et or _eastern_now()
    day = now_et.date()
    if day.weekday() < 5 and now_et.time() >= YF_EOD_SETTLE_READY_ET:
        return day
    day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _bar_date(row):
    try:
        return date.fromisoformat(str(row.get("date") or "")[:10])
    except (TypeError, ValueError):
        return None


def _drop_unsettled_tail(rows, now_et=None):
    """Strip trailing bars that are not a settled end-of-day price, so a pre-settle /
    still-forming bar is never stored as the EoD (the data-integrity rule: always the
    settlement price, never an intraday snapshot).

      (1) date  — drop any bar dated after the latest settled EoD (a forming bar pulled
                  by a refresh that ran before the settle, e.g. mid-session), and
      (2) volume — drop the current-session bar when its volume is only a small fraction
                  of the recent norm: an unfinished intraday/overnight print, not the close.

    Fully-elapsed prior sessions are never dropped — a low-volume *past* day (e.g. a
    half-session holiday) is a legitimate settled bar, so stored history is preserved.
    A genuine same-day half-session is simply picked up on the next refresh, by which
    point it is a prior, fully-settled day."""
    if not rows:
        return rows
    rows = list(rows)
    cutoff = _latest_settled_eod_date(now_et)
    # (1) forming bars beyond the settled cutoff
    while rows:
        d = _bar_date(rows[-1])
        if d is not None and d > cutoff:
            rows.pop()
        else:
            break
    # (2) a partial current-session bar (date >= cutoff) that is not a finished session
    if rows:
        d = _bar_date(rows[-1])
        if d is not None and d >= cutoff:
            recent = [v for v in (r.get("volume") for r in rows[-1 - YF_VOLUME_SUSPECT_LOOKBACK:-1])
                      if isinstance(v, (int, float)) and v > 0]
            ref = _median(recent)
            vol = rows[-1].get("volume")
            # A settled session always has trades: a 0/None-volume current bar in a market
            # that normally reports volume is an unfinished/forming print, not a settlement.
            zero_volume_partial = len(recent) >= 3 and (vol is None or vol == 0)
            # ...or a current bar whose volume is only a small fraction of the recent norm.
            low_volume_partial = (
                isinstance(vol, (int, float)) and vol > 0
                and ref is not None and ref >= YF_VOLUME_SUSPECT_MIN_REFERENCE
                and vol < ref * YF_VOLUME_SUSPECT_RATIO
            )
            if zero_volume_partial or low_volume_partial:
                rows.pop()
    return rows


def _board_settled_eod_date(dataset):
    """The latest session the *reliable* board has settled, by majority vote.

    Index futures, energies, grains, FX, rates — they all settle on one US calendar, so
    there is a single latest-settled-EoD date for the whole board. Each market with
    trustworthy volume (recent median >= the suspect floor) votes its own last *full*
    session — walking back past any partial/forming tail. The board date is the majority
    vote, so a handful of markets whose yfinance volume is sparse/broken (e.g. metals with
    an absurdly low median) can't drag the date forward, and the heavyweight markets that
    truly fix the settled session win. Illiquid markets are then capped to this date so no
    market keeps a session the reliable board hasn't settled. Returns None when no market
    has trustworthy volume (then per-market trimming stands alone)."""
    from collections import Counter
    votes = []
    for entry in (dataset or {}).values():
        history = (entry.get("continuous_contract") or {}).get("history") or []
        if len(history) < 10:
            continue
        recent = [v for v in (r.get("volume") for r in history[-1 - YF_VOLUME_SUSPECT_LOOKBACK:-1])
                  if isinstance(v, (int, float)) and v > 0]
        ref = _median(recent)
        if ref is None or ref < YF_VOLUME_SUSPECT_MIN_REFERENCE:
            continue  # sparse/unreliable yfinance volume -> no vote
        for row in reversed(history):
            vol = row.get("volume")
            if isinstance(vol, (int, float)) and vol >= ref * YF_EOD_BOARD_SETTLE_MIN_RATIO:
                d = _bar_date(row)
                if d is not None:
                    votes.append(d)
                break
    if not votes:
        return None
    return Counter(votes).most_common(1)[0][0]


def _cap_series_to_date(rows, cutoff):
    """Drop trailing dated rows past the board-wide settled EoD `cutoff` (undated rows kept)."""
    if cutoff is None or not rows:
        return rows
    out = []
    for r in rows:
        d = _bar_date(r)
        if d is None or d <= cutoff:
            out.append(r)
    return out


def _round_price(v):
    """Round OHLC with precision scaled to the price magnitude. Markets priced >= 1
    keep 4 decimals (unchanged); smaller instruments get more so tiny prices aren't
    collapsed. The Japanese Yen future trades ~0.0063 — rounding it to 4 decimals
    flattened every candle (open==high==low==close), which `_history_row_looks_tradable`
    then dropped as non-tradable, leaving the JPY calendar spread empty."""
    av = abs(v)
    if av >= 1:
        nd = 4
    elif av >= 0.01:
        nd = 6
    else:
        nd = 8
    return round(v, nd)


def _median(values):
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2
