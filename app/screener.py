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
    'SEASONAL_LONG_WINDOWS',
    'SEASONAL_MIN_RUN_DAYS',
    'SEASONAL_SHORT_WINDOWS',
    '_cot_net',
    '_screener_cot_hedge_signal',
    '_screener_cot_signal',
    '_screener_doy',
    '_screener_seasonal_event',
    '_screener_seasonal_signal',
    '_screener_structure_signal',
    '_seasonal_aggregate_dir',
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
#   - seasonal:  3-of-4 confirmation: of the four seasonal curves (5/10/20/40Y) at least three must share a direction and none may oppose it, else neutral
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


# The four seasonal lookback windows (two short, two long). The screener seasonal
# signal applies a 3-of-4 confirmation rule across these curves (quality > quantity);
# see _screener_seasonal_signal.
SEASONAL_SHORT_WINDOWS = (5, 10)
SEASONAL_LONG_WINDOWS = (20, 40)

# Minimum-duration gate ("less is more"): the aligned 3-of-4 direction must hold for
# at least this many consecutive days-of-year, otherwise it is treated as a neutral
# blip. Without this gate the median seasonal window was ~9 days (88% under 21 days) --
# far too short/noisy for a high-conviction setup. At 14 days the median window roughly
# doubles and the count of seasonal windows drops ~73%, leaving only sustained seasons.
SEASONAL_MIN_RUN_DAYS = 14


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
    """Cleaned seasonal history -> list of the distinct 5/10/20/40-year curves. Curves
    drawing on the same number of years are collapsed to one (a short-history market's
    20Y and 40Y curves are identical), so a short-history market contributes fewer than
    four. Returns None when there is no usable history; a list shorter than four means
    too little history for a 3-of-4 vote."""
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
    for w in (*SEASONAL_SHORT_WINDOWS, *SEASONAL_LONG_WINDOWS):
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


def _seasonal_gated_sequence(curves, min_run=None):
    """365-day direction sequence (+1 / -1 / 0) after dropping any contiguous
    same-direction window shorter than `min_run` days (evaluated circularly). This is
    the 'less is more' duration filter: a brief seasonal blip no longer counts -- only a
    sustained run does. All-zero when there are fewer than four distinct curves."""
    if min_run is None:
        min_run = SEASONAL_MIN_RUN_DAYS
    n = 365
    if not curves or len(curves) < 4:
        return [0] * n
    raw = [_seasonal_aggregate_dir(curves, d) for d in range(n)]
    if all(v == raw[0] for v in raw):       # all-neutral, or one uninterrupted year-run
        return raw[:]
    out = raw[:]
    start = next(i for i in range(n) if raw[i] != raw[(i - 1) % n])
    i, seen = start, 0
    while seen < n:
        v = raw[i]
        ln = 0
        while ln < n and raw[(i + ln) % n] == v:
            ln += 1
        if v != 0 and ln < min_run:         # too short -> neutralize the whole run
            for k in range(i, i + ln):
                out[k % n] = 0
        i = (i + ln) % n
        seen += ln
    return out


def _seasonal_signal_at(curves, doy):
    """Gated seasonal direction at a day-of-year -> 'bullish' / 'bearish' / 'neutral'.
    Needs four distinct curves (else neutral) and a sustained run (>= SEASONAL_MIN_RUN_DAYS)."""
    if not curves or len(curves) < 4:
        return "neutral"
    v = _seasonal_gated_sequence(curves)[doy % 365]
    return "bullish" if v == 1 else "bearish" if v == -1 else "neutral"


def _screener_seasonal_signal(seasonal_history):
    """Tightened seasonal filter (quality > quantity). Builds the distinct 5/10/20/40-year
    seasonal curves and combines two gates: (1) the 3-of-4 rule -- at least three of the
    four INDEPENDENT curves share a direction and none points the opposite way; and (2) a
    minimum-duration gate (SEASONAL_MIN_RUN_DAYS) -- that aligned direction must hold for a
    sustained run, not a brief blip. Fewer than four independent curves -> neutral. Returns
    'bullish' / 'bearish' / 'neutral', or None when there is no usable history."""
    curves = _seasonal_distinct_curves(seasonal_history)
    if not curves:
        return None
    cur = _screener_doy(date.today().isoformat())
    if cur is None:
        cur = 58
    return _seasonal_signal_at(curves, cur)


def _screener_seasonal_event(seasonal_history, today=None):
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
    """
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
    midpoint = (min(window) + max(window)) / 2
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
            out.append({
                "key": key,
                "display_name": mk.get("display_name"),
                "category": cat,
                "slug": _slug(cat),
                "last": front.get("last"),
                "change_pct": front.get("change_pct"),
                "seasonal": _screener_seasonal_signal(cc.get("seasonal_history") or []),
                "cot": _screener_cot_signal(mk.get("cot_series") or []),
                "cot_hedge": _screener_cot_hedge_signal(mk.get("cot_series") or []),
                "structure": _screener_structure_signal(contracts),
                "seasonal_event": _screener_seasonal_event(cc.get("seasonal_history") or []),
            })
    return out
