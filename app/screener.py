"""Screener + seasonal/COT/structure signal computation.

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
from local_first_merge import _slug

__all__ = [
    'SEASONAL_MAX_WINDOW',
    'SEASONAL_MIN_RUN_DAYS',
    'SEASONAL_WINDOWS',
    'SEASONAL_WINDOW_DAYS',
    '_cot_net',
    '_screener_cot_hedge_signal',
    '_screener_cot_signal',
    '_screener_doy',
    '_screener_seasonal_event',
    '_screener_seasonal_signal',
    '_screener_structure_signal',
    '_seasonal_aggregate_dir',
    '_seasonal_confirmed_votes',
    '_seasonal_curve_direction',
    '_seasonal_distinct_curves',
    '_seasonal_gated_sequence',
    '_seasonal_signal_at',
    '_seasonal_window_curve',
    'build_screener_summary',
]



# ─────────────────────────────────────────────────────────────────────
#  SCREENER SIGNALS  (lean per-market summary -> ff_data/screener.json)
#  Signals are computed to match the on-chart logic exactly:
#   - seasonal:  3-of-4 confirmation (of the four 5/10/15Y+max curves at least three share a direction, none opposes), read over a short trailing window [today-SEASONAL_WINDOW_DAYS, today] so a season active now OR within the last few days still counts; else neutral
#   - cot:       latest net position sign (>=0 long = bullish)        [plain COT pane]
#   - cot_hedge: latest net vs midpoint of the trailing 12M window    [COT Hedging Program]
#   - structure: front contract last > next contract last = premium (backwardation)
# ─────────────────────────────────────────────────────────────────────
def _screener_doy(dstr):
    """Day-of-year ignoring Feb 29 (mirrors the frontend dayOfYearNoLeap)."""
    try:
        m, d = int(dstr[5:7]), int(dstr[8:10])
    except (TypeError, ValueError, IndexError):
        return None
    if m == 2 and d == 29:
        return None
    return (date(2021, m, d) - date(2021, 1, 1)).days


def _cot_net(row):
    net = row.get("cot_net")
    return row.get("comm_net") if net is None else net


# The seasonal lookback windows: three fixed look-backs (5/10/15Y) plus a 'max' curve
# built from the full available history. The screener seasonal signal applies a 3-of-4
# confirmation rule across the resulting distinct curves (quality > quantity); see
# _screener_seasonal_signal. The old (5,10,20,40) set masked the seasons of markets with
# ~20-30y of history: the 40Y window capped at available data and ended up near-identical
# to the 20Y curve (e.g. copper's ~27y produced twin 20Y/25Y curves, both flat right where
# its 5/10/15Y curves were clearly bearish). Spacing the look-backs 5/10/15 and making the
# fourth curve the genuine maximum keeps the four curves independent. This mirrors the
# Seasonals tab chart, which draws the same 5/10/15/Max curves.
SEASONAL_WINDOWS = (5, 10, 15)
SEASONAL_MAX_WINDOW = 100   # 'max' curve: large enough to use every available year

# The seasonal direction is gated in TWO steps (see _seasonal_gated_sequence):
#
# (1) Flicker filter — SEASONAL_MIN_RUN_DAYS. The raw 3-of-4 day-of-year vote can
#     briefly flicker directional a day or two BEFORE the genuine seasonal run begins
#     (the forward 21-day window in _seasonal_curve_direction catches a tiny pre-move),
#     then drop back to neutral, then the sustained run starts. A raw run shorter than
#     SEASONAL_MIN_RUN_DAYS is treated as noise and dropped, so such a pre-flicker can
#     never become the onset. This is what removes the "Vorlauf": the signal turns on
#     on the day the genuine run begins, never a few days early. (NOT the old 14-day
#     SEASONAL_MIN_RUN_DAYS hard gate, which dropped genuine short seasons — this is a
#     short noise filter applied per raw run, the tail smear below keeps short seasons.)
#
# (2) Trailing-window smear — SEASONAL_WINDOW_DAYS. The surviving (confirmed) direction
#     is carried FORWARD over this many days: a market still reads directional for a few
#     days after its confirmed run goes neutral. Backward-looking window, so it only ever
#     EXTENDS a run's tail (keeps a season "active now OR just rolled off within the last
#     few days") and never pulls an onset earlier. It also bridges a one/two-day neutral
#     dip inside a season. Soybean oil (3-of-4 run ends a day or two before today) is the
#     motivating keep-alive case.
SEASONAL_MIN_RUN_DAYS = 3   # a raw run must hold >= this many days to count as real (flicker filter)
SEASONAL_WINDOW_DAYS = 3


def _seasonal_window_curve(rows, years, latest_full):
    """Smoothed 365-day seasonal curve (each year indexed to 100 at its start, then
    averaged across the last `years` years) -> (curve, years_used), or None if too thin.
    `rows` must be the cleaned, ascending (date, close) list."""
    start = latest_full - years + 1
    by_year = {}
    for d, c in rows:
        y = int(d[:4])
        if y < start or y > latest_full:
            continue
        by_year.setdefault(y, []).append((d, c))
    paths = []
    for y in sorted(by_year):
        yr = sorted(by_year[y])
        if len(yr) < 120 or int(yr[0][0][5:7]) > 3:
            continue
        first = yr[0][1]
        if not first:
            continue
        vals = [None] * 365
        cursor, lastv = 0, 100.0
        for d, c in yr:
            idx = _screener_doy(d)
            if idx is None or idx < 0 or idx > 364:
                continue
            while cursor <= idx and cursor < 365:
                vals[cursor] = lastv
                cursor += 1
            lastv = c / first * 100
            vals[idx] = lastv
            cursor = max(cursor, idx + 1)
        while cursor < 365:
            vals[cursor] = lastv
            cursor += 1
        paths.append(vals)
    if not paths:
        return None

    def avg(i):
        vs = [p[i] for p in paths if p[i] is not None]
        return sum(vs) / len(vs) if vs else None

    raw_curve = [avg(i) for i in range(365)]
    if any(v is None for v in raw_curve):
        return None

    def smooth(i, radius=3):
        vals = [raw_curve[(i + off) % 365] for off in range(-radius, radius + 1)]
        return sum(vals) / len(vals)

    return [smooth(i) for i in range(365)], len(paths)


def _seasonal_curve_direction(curve, cur):
    """+1 / -1 if a significant seasonal trend is genuinely UNDERWAY at day-of-year
    `cur`, else 0. The signal is evaluated strictly on the forward window
    [cur, cur+21]: it fires only when the move over the NEXT 21 days from today is
    both large enough and consistent. No anticipation buffer -- it no longer fires
    before a trend window begins ("davor", the old +3-day starts_soon) nor lingers
    once the move has already happened ("dahinter", the old active-window tail /
    ends_soon bonus). Move is scaled to the curve's own yearly range (with a floor),
    so flat years never fire."""
    curve_range = max(curve) - min(curve)
    if curve_range < 0.5:
        return 0
    lookahead = 21
    min_consistency = 0.62
    min_move = max(0.35, min(1.15, curve_range * 0.12))
    end = (cur + lookahead) % 365
    move = curve[end] - curve[cur]
    if abs(move) < min_move:
        return 0
    direction = 1 if move > 0 else -1
    deltas = [
        curve[(cur + off + 1) % 365] - curve[(cur + off) % 365]
        for off in range(lookahead)
    ]
    consistency = sum(1 for d in deltas if d * direction > 0) / len(deltas)
    if consistency < min_consistency:
        return 0
    return direction


def _seasonal_distinct_curves(seasonal_history):
    """Cleaned seasonal history -> list of the distinct 5/10/15Y + max-history curves.
    Curves drawing on the same number of years are collapsed to one (a short-history
    market's 15Y and max curves are identical), so a short-history market contributes
    fewer than four. Returns None when there is no usable history; a list shorter than
    four means too little history for a 3-of-4 vote."""
    rows = [(str(r["date"])[:10], float(r["close"]))
            for r in (seasonal_history or [])
            if r and r.get("date") and r.get("close") is not None]
    if not rows:
        return None
    rows.sort()
    # Drop isolated reverting spikes (same filter as the seasonal chart).
    cleaned = []
    for i, (d, c) in enumerate(rows):
        prev = rows[i - 1] if i > 0 else None
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if prev and nxt and prev[1] and nxt[1]:
            lo = c < 0.5 * prev[1] and c < 0.5 * nxt[1]
            hi = c > 2 * prev[1] and c > 2 * nxt[1]
            if lo or hi:
                continue
        cleaned.append((d, c))
    rows = cleaned
    if not rows:
        return None

    last = rows[-1][0]
    last_year = int(last[:4])
    last_md = int(last[5:7]) * 100 + int(last[8:10])
    latest_full = last_year if last_md >= 1215 else last_year - 1

    distinct = {}                       # years_used -> curve
    for w in (*SEASONAL_WINDOWS, SEASONAL_MAX_WINDOW):
        built = _seasonal_window_curve(rows, w, latest_full)
        if built is not None:
            curve, years_used = built
            distinct[years_used] = curve
    return list(distinct.values())


def _seasonal_aggregate_dir(curves, doy):
    """3-of-4 vote across the distinct curves at one day-of-year -> +1 / -1 / 0.
    Fires only when >=3 curves share a direction AND none points the opposite way."""
    dirs = [_seasonal_curve_direction(c, doy) for c in curves]
    bull = dirs.count(1)
    bear = dirs.count(-1)
    if bull >= 3 and bear == 0:
        return 1
    if bear >= 3 and bull == 0:
        return -1
    return 0


def _seasonal_confirmed_votes(raw, min_run=SEASONAL_MIN_RUN_DAYS):
    """Flicker filter: zero out any circular run of identical nonzero votes shorter than
    `min_run` days. The raw 3-of-4 vote can flicker directional for a day or two right
    before the genuine seasonal run begins; those short runs are noise and must not seed
    an onset (that brief flicker is the "Vorlauf" we remove). Runs are measured around
    the year wrap (a December/January season counts as one run). Returns a new list."""
    n = len(raw)
    conf = list(raw)
    if all(v == 0 for v in raw):
        return conf
    start = next((i for i in range(n) if raw[i] == 0), 0)   # a neutral day, so no run is split
    k = 0
    while k < n:
        v = raw[(start + k) % n]
        if v == 0:
            k += 1
            continue
        length = 1
        while k + length < n and raw[(start + k + length) % n] == v:
            length += 1
        if length < min_run:
            for j in range(length):
                conf[(start + k + j) % n] = 0
        k += length
    return conf


def _seasonal_gated_sequence(curves):
    """365-day direction sequence (+1 / -1 / 0) -- the canonical seasonal direction by
    day-of-year, shared by the screener signal, the Weekly-Outlook event, and the
    content-bot backfill. Two gates (see the SEASONAL_*_DAYS comment above):
      1. Flicker filter -- raw 3-of-4 runs shorter than SEASONAL_MIN_RUN_DAYS are dropped,
         so a one/two-day pre-run flicker never becomes the onset (no Vorlauf).
      2. Trailing smear -- the surviving (confirmed) direction is carried forward over a
         [d - SEASONAL_WINDOW_DAYS, d] window, so a season active now OR just rolled off
         within the last few days still counts. The window is backward-looking, so it only
         extends a confirmed run's tail and never pulls an onset earlier.
    All-zero when there are fewer than four distinct curves."""
    n = 365
    if not curves or len(curves) < 4:
        return [0] * n
    raw = [_seasonal_aggregate_dir(curves, d) for d in range(n)]
    conf = _seasonal_confirmed_votes(raw)
    win = SEASONAL_WINDOW_DAYS
    out = [0] * n
    for d in range(n):
        seg = [conf[(d - off) % n] for off in range(0, win + 1)]
        bull = seg.count(1)
        bear = seg.count(-1)
        if bull and not bear:
            out[d] = 1
        elif bear and not bull:
            out[d] = -1
    return out


def _seasonal_signal_at(curves, doy):
    """Gated seasonal direction at a day-of-year -> 'bullish' / 'bearish' / 'neutral'.
    Needs four distinct curves (else neutral); reads the trailing-window 3-of-4 sequence."""
    if not curves or len(curves) < 4:
        return "neutral"
    v = _seasonal_gated_sequence(curves)[doy % 365]
    return "bullish" if v == 1 else "bearish" if v == -1 else "neutral"


def _screener_seasonal_signal(seasonal_history, curves=None):
    """Tightened seasonal filter (quality > quantity). Builds the distinct 5/10/15Y + max
    seasonal curves and combines two gates (via _seasonal_gated_sequence): (1) the 3-of-4
    rule -- at least three of the four INDEPENDENT curves share a direction and none points
    the opposite way; and (2) the flicker filter (SEASONAL_MIN_RUN_DAYS) -- that aligned
    direction must hold for a sustained run, not a one/two-day blip, so the signal never
    fires a few days early. Fewer than four independent curves -> neutral. Returns
    'bullish' / 'bearish' / 'neutral', or None when there is no usable history.

    `curves` may be passed pre-built (by build_screener_summary) to avoid rebuilding the
    distinct curves twice per market (signal + event)."""
    if curves is None:
        curves = _seasonal_distinct_curves(seasonal_history)
    if not curves:
        return None
    cur = _screener_doy(date.today().isoformat())
    if cur is None:
        cur = 58
    return _seasonal_signal_at(curves, cur)


def _screener_seasonal_event(seasonal_history, today=None, curves=None):
    """Next seasonal change for the Weekly Outlook — when the gated seasonal signal next
    flips. Returns ``{"type": "onset"|"offset", "date": ISO, "direction": "bullish"|"bearish"}``
    or ``None`` when there is no usable seasonal signal (fewer than four distinct curves).

    - ``onset``  — neutral today, turns directional on ``date`` (``direction`` = the new
      direction). This is "when does the seasonal switch on".
    - ``offset`` — directional today (``direction``), stops being that direction on
      ``date`` (the seasonal runway end).

    Uses the SAME deterministic 365-day gated day-of-year sequence as the live seasonal
    signal, scanned forward up to a year. The frontend turns ``date`` into a relative
    "in N days / next week" against the viewer's own today, so the projection stays
    correct even if the data is a day stale.

    `curves` may be passed pre-built (by build_screener_summary) to avoid rebuilding the
    distinct curves twice per market (signal + event).
    """
    if curves is None:
        curves = _seasonal_distinct_curves(seasonal_history)
    if not curves or len(curves) < 4:
        return None
    seq = _seasonal_gated_sequence(curves)
    today = today or date.today()
    cur_doy = _screener_doy(today.isoformat())
    if cur_doy is None:
        cur_doy = 58
    cur = seq[cur_doy % 365]
    for d in range(1, 366):
        fut = today + timedelta(days=d)
        fdoy = _screener_doy(fut.isoformat())
        if fdoy is None:                         # Feb 29 -> reuse the prior day's slot
            fdoy = _screener_doy((fut - timedelta(days=1)).isoformat()) or 0
        nxt = seq[fdoy % 365]
        if nxt != cur:
            if cur == 0:                         # neutral -> directional (onset)
                return {"type": "onset", "date": fut.isoformat(),
                        "direction": "bullish" if nxt == 1 else "bearish"}
            return {"type": "offset", "date": fut.isoformat(),   # current run ends
                    "direction": "bullish" if cur == 1 else "bearish"}
    return None


def _screener_cot_signal(cot_series):
    if not cot_series:
        return None
    net = _cot_net(cot_series[-1])
    if net is None:
        return None
    return "bullish" if net >= 0 else "bearish"


def _screener_cot_hedge_signal(cot_series, days=182):
    # 6-month positioning window (was 12m/365d). A backtest sweep of the full-score
    # rule showed a smooth plateau of better risk/return across ~120-240 days, with
    # 12 months on the weak end; 6 months sits in the sweet spot and matches the
    # standard 6-month hedger program, so the hedger point reacts to current rather
    # than year-old positioning.
    if not cot_series:
        return None
    try:
        last = date.fromisoformat(str(cot_series[-1].get("date"))[:10])
    except (TypeError, ValueError):
        return None
    cutoff = last - timedelta(days=days)
    window = []
    for r in cot_series:
        try:
            dt = date.fromisoformat(str(r.get("date"))[:10])
        except (TypeError, ValueError):
            continue
        if cutoff <= dt <= last:
            net = _cot_net(r)
            if net is not None:
                window.append(net)
    if not window:
        return None
    lo, hi = min(window), max(window)
    if hi == lo:
        # Flat window (constant net, or a single COT point): there is no positioning
        # range to sit high/low within, so `>= midpoint` would always read bullish.
        # That is not a signal — return neutral.
        return "neutral"
    midpoint = (lo + hi) / 2
    return "bullish" if window[-1] >= midpoint else "bearish"


def _screener_structure_signal(contracts):
    """Term structure = the nearest two contracts that both carry a live `last`.

    Robustness fallback: Yahoo sometimes drops the quote for a thinly-traded deferred
    contract (e.g. the US Dollar Index next month DXU…, which trades at a fraction of
    the front's volume). Comparing only contracts[0] vs contracts[1] would then return
    None and silently drop the market out of the 4/4 filter. Instead we compare the
    first two contracts that actually have a `last`, so the signal degrades to the next
    available deferred month rather than disappearing. Non-quoted far months carry
    last=None and are skipped, so no stale far-deferred print can leak in."""
    if not contracts:
        return None
    priced = [c.get("last") for c in contracts if c.get("last") is not None]
    if len(priced) < 2:
        return None
    front, nxt = priced[0], priced[1]
    return "premium" if front > nxt else "discount"


def build_screener_summary(by_cat):
    """One lean record per market with the four screener signals."""
    out = []
    for cat, payload in by_cat.items():
        for key, mk in payload.items():
            cc = mk.get("continuous_contract", {})
            contracts = mk.get("contracts") or []
            front = contracts[0] if contracts else {}
            # Build the distinct seasonal curves once and share them between the
            # signal and the event (both otherwise rebuild them from scratch).
            seasonal_history = cc.get("seasonal_history") or []
            seasonal_curves = _seasonal_distinct_curves(seasonal_history)
            out.append({
                "key": key,
                "display_name": mk.get("display_name"),
                "category": cat,
                "slug": _slug(cat),
                "last": front.get("last"),
                "change_pct": front.get("change_pct"),
                "seasonal": _screener_seasonal_signal(seasonal_history, curves=seasonal_curves),
                "cot": _screener_cot_signal(mk.get("cot_series") or []),
                "cot_hedge": _screener_cot_hedge_signal(mk.get("cot_series") or []),
                "structure": _screener_structure_signal(contracts),
                "seasonal_event": _screener_seasonal_event(seasonal_history, curves=seasonal_curves),
            })
    return out
