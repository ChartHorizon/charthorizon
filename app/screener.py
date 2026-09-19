"""Screener + seasonal/COT/structure signal computation.

Split out of commodity_dashboard.py — see CLAUDE.md "Architecture".
"""

import bisect
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
from market_config import CONTRACT_SPECS
from series_utils import _coerce_iso_date
from calendar_utils import compute_expiry
from local_first_merge import _slug

__all__ = [
    'SCORE_SIGNALS',
    'SEASONAL_LOOKAHEAD_DAYS',
    'SEASONAL_MAX_GAP_DAYS',
    'SEASONAL_MAX_WINDOW',
    'SEASONAL_MIN_RUN_DAYS',
    'SEASONAL_MIN_SEASON_DAYS',
    'SEASONAL_MIN_SEASON_SHARE',
    'SEASONAL_ROLL_MAX_OFFSET',
    'SEASONAL_ROLL_MIN_ANCHORS',
    'SEASONAL_ROLL_MIN_GAP_RATIO',
    'SEASONAL_WINDOWS',
    'SEASONAL_WINDOW_DAYS',
    'SPREAD_SIGNAL_MAX_LAG_DAYS',
    '_cot_net',
    '_screener_cot_hedge_signal',
    '_screener_doy',
    '_screener_seasonal_event',
    '_screener_seasonal_signal',
    '_screener_structure_signal',
    '_seasonal_aggregate_dir',
    '_seasonal_confirmed_votes',
    '_seasonal_curve_direction',
    '_seasonal_distinct_curves',
    '_seasonal_drop_minor_seasons',
    '_seasonal_gated_sequence',
    '_seasonal_path',
    '_seasonal_runs',
    '_seasonal_season_share',
    '_seasonal_signal_at',
    '_seasonal_smear',
    '_seasonal_window_curve',
    '_signal_dir',
    '_three_three_seasonal_at',
    '_three_three_seasonal_sequence',
    'build_screener_summary',
    'build_three_three_log',
    'build_three_three_periods',
    'mark_seasonal_roll_days',
    'merge_three_three_periods',
    'seasonal_runway',
    'screener_score',
]



# ─────────────────────────────────────────────────────────────────────
#  SCREENER SIGNALS  (lean per-market summary -> ff_data/screener.json)
#  Three signals, summed into `score` (-3 … +3) by screener_score(). The plain COT
#  sign was dropped on 2026-08-29 (a constant in structurally-hedged markets).
#  Each is computed to match the on-chart logic; cot_hedge matches the chart's 6M range:
#   - seasonal:  3-of-4 confirmation (of the four 5/10/15Y+max curves at least three share a direction, none opposes), read over a short trailing window [today-SEASONAL_WINDOW_DAYS, today] so a season active now OR within the last few days still counts, and only inside a season lasting SEASONAL_MIN_SEASON_DAYS whose curves move SEASONAL_MIN_SEASON_SHARE of their range; else neutral
#   - cot_hedge: latest net vs midpoint of the trailing 6M window     [COT Hedging Program]
#   - structure: front contract > next contract = premium (backwardation) — read off the
#                same calendar_spread_series the chart pane draws (volume-led front),
#                with the nearest priced contract pair as fallback
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
#     on the day the genuine run begins, never a few days early. (A noise filter on raw
#     runs only; how long a season must last is step 3.)
#
# (2) Trailing-window smear — SEASONAL_WINDOW_DAYS. The surviving (confirmed) direction
#     is carried FORWARD over this many days: a market still reads directional for a few
#     days after its confirmed run goes neutral. Backward-looking window, so it only ever
#     EXTENDS a run's tail (keeps a season "active now OR just rolled off within the last
#     few days") and never pulls an onset earlier. It also bridges a one/two-day neutral
#     dip inside a season. Soybean oil (3-of-4 run ends a day or two before today) is the
#     motivating keep-alive case.
#
# (3) Season gate — SEASONAL_MIN_SEASON_DAYS and SEASONAL_MIN_SEASON_SHARE. Only long, distinct
#     seasons count (operator decision 2026-09-12: "nur längere und markante Seasonals, die 1-2
#     Wochen oder länger bestehen"). A season is one run of the smeared sequence, the span the
#     screener badge shows, tail included. It must last SEASONAL_MIN_SEASON_DAYS, and its curves
#     must move by SEASONAL_MIN_SEASON_SHARE of their own yearly range, from its first confirmed
#     day to the end of its last day's forward window: the leg the Seasonals tab draws, measured
#     against the scale that tab draws it on. A season failing either is removed with the votes
#     that seed it, as if they had never been cast. A season that passes stays exactly as it was,
#     except where a removed opposite season had been cancelling its first or last days.
SEASONAL_MIN_RUN_DAYS = 3   # a raw run must hold >= this many days to count as real (flicker filter)
SEASONAL_WINDOW_DAYS = 3
SEASONAL_MIN_SEASON_DAYS = 14
SEASONAL_MIN_SEASON_SHARE = 0.25
SEASONAL_LOOKAHEAD_DAYS = 21   # the forward window _seasonal_curve_direction judges a day on

# A year with a hole longer than this between two of its bars is left out of every seasonal curve:
# the hole is flat-filled, so it draws a season that never traded (platinum 2006-2007 carry 63-day
# holes). 21 days is the line _series_health draws for "gappy"; no exchange closure comes near it.
SEASONAL_MAX_GAP_DAYS = 21

# Contract-roll gaps — see mark_seasonal_roll_days. The roll bar is searched within
# SEASONAL_ROLL_MAX_OFFSET sessions of the first bar after each scheduled expiry and trusted only
# where its mean overnight gap is SEASONAL_ROLL_MIN_GAP_RATIO times the market's normal one.
# Measured 2026-09-11 over the stored histories: lean hogs 10.4x, corn 9.2x, sugar 8.6x on the first
# bar after expiry; the Treasuries and the ICE softs one session earlier; gold, silver, copper,
# cotton, bitcoin and ether show no roll gap at all (<= 1.8x) and stay unmarked.
SEASONAL_ROLL_MAX_OFFSET = 5
SEASONAL_ROLL_MIN_GAP_RATIO = 2.0
SEASONAL_ROLL_MIN_ANCHORS = 8       # expiries the calibration needs before it trusts a mean gap

# The structure signal reads the calendar spread only while it keeps pace with the price
# history: at most this many days between the last spread point and the market's latest
# bar. Wide enough for a holiday weekend plus a missed refresh, narrow enough that a
# series which stopped (trimmed by the trailing-contiguity pass) hands over to the
# nearest-contract fallback instead of freezing a stale reading.
SPREAD_SIGNAL_MAX_LAG_DAYS = 7


def _max_gap_days(rows):
    """Largest calendar-day distance between two consecutive (date, value) rows."""
    days = [date.fromisoformat(d[:10]) for d, _ in rows]
    return max(((b - a).days for a, b in zip(days, days[1:])), default=0)


def _seasonal_window_curve(rows, years, latest_full):
    """Smoothed 365-day seasonal curve (each year indexed to 100 at its start, then
    averaged across the last `years` years) -> (curve, years_used), or None if too thin.
    `rows` must be the cleaned, ascending (date, value) list — the roll-adjusted level
    _seasonal_distinct_curves builds. A year with a hole of more than SEASONAL_MAX_GAP_DAYS
    is not a seasonal year."""
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
        if _max_gap_days(yr) > SEASONAL_MAX_GAP_DAYS:
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

    # Smoothed across the ends of the year without wrapping into the other end: past Dec 31 the
    # curve continues from where December ends (January plus the year's drift). Wrapped, the first
    # and last three days averaged January's 100 with December's level, which put a hook into both
    # ends of every trending curve (cocoa's 5Y: 166 on Dec 28, 138 on Dec 31, 129 on Jan 1).
    drift = raw_curve[-1] - raw_curve[0]

    def at(i):
        years, day = divmod(i, 365)
        return raw_curve[day] + years * drift

    def smooth(i, radius=3):
        return sum(at(i + off) for off in range(-radius, radius + 1)) / (2 * radius + 1)

    return [smooth(i) for i in range(365)], len(paths)


def _seasonal_path(curve, start, days):
    """The curve's levels on day indices start .. start + days, read across Dec 31 as the next
    year continuing from where this one ends rather than jumping back to January's 100. The
    year's drift is taken off the curve's own ends, carried on at December's last slope. Read
    wrapped, a forward window over the year end compared December with January and voted the
    year's whole drift as a December season: 73 points "down" in 21 days on cocoa's 5Y curve,
    with all four curves agreeing."""
    n = len(curve)
    carry = 2 * curve[-1] - curve[-2] - curve[0]
    return [curve[i % n] + (i // n) * carry for i in range(start, start + days + 1)]


def _seasonal_curve_direction(curve, cur):
    """+1 / -1 if a significant seasonal trend is genuinely UNDERWAY at day-of-year
    `cur`, else 0. The signal is evaluated strictly on the forward window
    [cur, cur+21]: it fires only when the move over the NEXT 21 days from today is
    both large enough and consistent. No anticipation buffer -- it no longer fires
    before a trend window begins ("davor", the old +3-day starts_soon) nor lingers
    once the move has already happened ("dahinter", the old active-window tail /
    ends_soon bonus). Move is scaled to the curve's own yearly range (with a floor),
    so flat years never fire. A window over the year end reads on into next January
    (_seasonal_path)."""
    curve_range = max(curve) - min(curve)
    if curve_range < 0.5:
        return 0
    min_consistency = 0.62
    min_move = max(0.35, min(1.15, curve_range * 0.12))
    path = _seasonal_path(curve, cur, SEASONAL_LOOKAHEAD_DAYS)
    move = path[-1] - path[0]
    if abs(move) < min_move:
        return 0
    direction = 1 if move > 0 else -1
    deltas = [b - a for a, b in zip(path, path[1:])]
    consistency = sum(1 for d in deltas if d * direction > 0) / len(deltas)
    if consistency < min_consistency:
        return 0
    return direction


def _positive_float(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _roll_adjusted_levels(rows):
    """(date, close, open, roll) rows -> (date, level) rows. The level is the close times a factor
    that changes only on a marked roll bar, where it takes the overnight gap back out: that bar then
    moves by close / open, the session's own move (flat when it has no usable open). Unmarked history
    keeps its raw closes exactly. Non-positive closes are skipped — nothing can chain through them."""
    out, factor, prev_close = [], 1.0, None
    for d, close, open_, roll in rows:
        if close <= 0:
            continue
        if roll and prev_close is not None:
            o = _positive_float(open_)
            factor *= prev_close / o if o else prev_close / close
        prev_close = close
        out.append((d, close * factor))
    return out


def _overnight_gaps(rows):
    """|open / previous close - 1| per bar; None for the first bar and any unusable print."""
    gaps = [None]
    for prev, row in zip(rows, rows[1:]):
        o, pc = _positive_float(row.get("open")), _positive_float(prev.get("close"))
        gaps.append(abs(o / pc - 1) if o and pc else None)
    return gaps


def _seasonal_roll_anchors(key, cfg, dates):
    """Index of the first bar after each scheduled expiry of the market's contract chain. An expiry
    followed by a hole (next bar more than a week later) is not a roll the series can show."""
    rule = CONTRACT_SPECS.get(key, {}).get("expiry_rule")
    months = sorted(set((cfg or {}).get("contract_months") or []))
    if not rule or not months or not dates:
        return []
    out = set()
    for year in range(int(dates[0][:4]), int(dates[-1][:4]) + 2):
        for month in months:
            expiry = compute_expiry(rule, year, month)
            if expiry is None:
                continue
            i = bisect.bisect_right(dates, expiry.isoformat())
            if 0 < i < len(dates) and (date.fromisoformat(dates[i]) - expiry).days <= 7:
                out.add(i)
    return sorted(out)


def _seasonal_roll_offset(gaps, anchors):
    """(offset, ratio): the session around the scheduled expiry whose mean overnight gap stands out
    most against the series' own mean gap. None when too few expiries can be measured."""
    usable = [g for g in gaps if g is not None]
    if len(anchors) < SEASONAL_ROLL_MIN_ANCHORS or not usable:
        return None
    base = sum(usable) / len(usable)
    if base <= 0:
        return None
    best = None
    for k in range(-SEASONAL_ROLL_MAX_OFFSET, SEASONAL_ROLL_MAX_OFFSET + 1):
        at = [gaps[i + k] for i in anchors if 0 < i + k < len(gaps) and gaps[i + k] is not None]
        if len(at) < SEASONAL_ROLL_MIN_ANCHORS:
            continue
        ratio = sum(at) / len(at) / base
        if best is None or ratio > best[1]:
            best = (k, ratio)
    return best


def mark_seasonal_roll_days(key, cfg, rows):
    """A seasonal history with `roll: True` on every bar where the native `=F` switched contract.

    The contract calendar repeats every year, so the spread between the expiring and the next
    contract lands on the same day-of-year every year, and a seasonal average reads that jump as a
    season. The bar is found per market from its own data: of the sessions within
    SEASONAL_ROLL_MAX_OFFSET of the first bar after each scheduled expiry, the one whose mean
    overnight gap (open vs previous close) stands out most against the series' mean gap — trusted
    only at SEASONAL_ROLL_MIN_GAP_RATIO or more, so a market without a clear roll gap stays
    unmarked. One offset per market, deliberately: calibrating per era caught a convention drift in
    three markets but picked noise offsets in a dozen thin blocks. The curves then take the
    overnight gap out of every marked bar (_roll_adjusted_levels).

    Copies: the input rows are never modified — the seasonal history can be the very list the price
    history is — and a mark left by an earlier refresh is dropped before marking again."""
    out = [{k: v for k, v in r.items() if k != "roll"} if "roll" in r else r for r in (rows or [])]
    dates = [str(r.get("date"))[:10] for r in out]
    if any(a > b for a, b in zip(dates, dates[1:])):
        return out                  # the anchors need ascending dates, which the generator writes
    anchors = _seasonal_roll_anchors(key, cfg, dates)
    found = _seasonal_roll_offset(_overnight_gaps(out), anchors)
    if found is None or found[1] < SEASONAL_ROLL_MIN_GAP_RATIO:
        return out
    for i in anchors:
        j = i + found[0]
        if 0 < j < len(out):
            out[j] = dict(out[j], roll=True)
    return out


def _seasonal_distinct_curves(seasonal_history):
    """Cleaned seasonal history -> list of the distinct 5/10/15Y + max-history curves.
    Curves drawing on the same number of years are collapsed to one (a short-history
    market's 15Y and max curves are identical), so a short-history market contributes
    fewer than four. Returns None when there is no usable history; a list shorter than
    four means too little history for a 3-of-4 vote.

    Built on the roll-adjusted level, not the raw close: on a bar mark_seasonal_roll_days
    marked, the overnight gap is the spread between two contracts and is taken out. History
    without marks is the raw close path, exactly as before."""
    rows = [(str(r["date"])[:10], float(r["close"]), r.get("open"), bool(r.get("roll")))
            for r in (seasonal_history or [])
            if r and r.get("date") and r.get("close") is not None]
    if not rows:
        return None
    rows.sort(key=lambda row: row[0])
    # Drop isolated reverting spikes (same filter as the seasonal chart).
    cleaned = []
    for i, row in enumerate(rows):
        c = row[1]
        prev = rows[i - 1] if i > 0 else None
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if prev and nxt and prev[1] and nxt[1]:
            lo = c < 0.5 * prev[1] and c < 0.5 * nxt[1]
            hi = c > 2 * prev[1] and c > 2 * nxt[1]
            if lo or hi:
                continue
        cleaned.append(row)
    rows = _roll_adjusted_levels(cleaned)
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


def _seasonal_runs(seq):
    """(start, length, value) of every run of identical nonzero values in a day-of-year
    sequence, measured around the year wrap (a December/January season is one run)."""
    n = len(seq)
    if all(v == 0 for v in seq):
        return []
    start = next((i for i in range(n) if seq[i] == 0), 0)   # a neutral day, so no run is split
    runs, k = [], 0
    while k < n:
        v = seq[(start + k) % n]
        if v == 0:
            k += 1
            continue
        length = 1
        while k + length < n and seq[(start + k + length) % n] == v:
            length += 1
        runs.append(((start + k) % n, length, v))
        k += length
    return runs


def _seasonal_confirmed_votes(raw, min_run=SEASONAL_MIN_RUN_DAYS):
    """Flicker filter: zero out any circular run of identical nonzero votes shorter than
    `min_run` days. The raw 3-of-4 vote can flicker directional for a day or two right
    before the genuine seasonal run begins; those short runs are noise and must not seed
    an onset (that brief flicker is the "Vorlauf" we remove). Runs are measured around
    the year wrap (a December/January season counts as one run). Returns a new list."""
    n = len(raw)
    conf = list(raw)
    for start, length, _ in _seasonal_runs(raw):
        if length < min_run:
            for off in range(length):
                conf[(start + off) % n] = 0
    return conf


def _seasonal_smear(conf):
    """Trailing-window smear: day d reads a direction when some day of
    [d - SEASONAL_WINDOW_DAYS, d] voted it and none voted the other way."""
    n = len(conf)
    out = [0] * n
    for d in range(n):
        seg = [conf[(d - off) % n] for off in range(SEASONAL_WINDOW_DAYS + 1)]
        bull = seg.count(1)
        bear = seg.count(-1)
        if bull and not bear:
            out[d] = 1
        elif bear and not bull:
            out[d] = -1
    return out


def _seasonal_season_share(curves, first, last, direction):
    """How distinct a season is: each curve's move in the season's direction, from its first
    confirmed day to the end of its last confirmed day's forward window, as a share of that
    curve's yearly range, averaged over the curves. 1.0 spans the whole Seasonals chart; a
    wiggle on a trending curve is a few hundredths."""
    shares = []
    for curve in curves:
        rng = max(curve) - min(curve)
        path = _seasonal_path(curve, first, last - first + SEASONAL_LOOKAHEAD_DAYS)
        shares.append((path[-1] - path[0]) * direction / rng if rng > 0 else 0.0)
    return sum(shares) / len(shares) if shares else 0.0


def _seasonal_drop_minor_seasons(conf, curves):
    """Season gate: the confirmed votes with every season taken out that lasts less than
    SEASONAL_MIN_SEASON_DAYS or moves less than SEASONAL_MIN_SEASON_SHARE of its curves' range.
    A season is one run of the smeared sequence, the span the badge shows. It goes together
    with the votes in its trailing window that seed it, so smearing again leaves no stub, and
    an opposite season it had been cancelling gets those days back. Returns a new list."""
    n = len(conf)
    kept = list(conf)
    for start, length, v in _seasonal_runs(_seasonal_smear(conf)):
        voted = [off for off in range(length) if conf[(start + off) % n] == v]
        if (length >= SEASONAL_MIN_SEASON_DAYS and voted
                and _seasonal_season_share(curves, start + voted[0], start + voted[-1], v)
                >= SEASONAL_MIN_SEASON_SHARE):
            continue
        for off in range(-SEASONAL_WINDOW_DAYS, length):
            if kept[(start + off) % n] == v:
                kept[(start + off) % n] = 0
    return kept


def _seasonal_gated_sequence(curves):
    """365-day direction sequence (+1 / -1 / 0) -- the canonical seasonal direction by
    day-of-year, shared by the screener signal, the Weekly-Outlook event, and the
    content-bot backfill. Three gates (see the SEASONAL_* comment above):
      1. Flicker filter -- raw 3-of-4 runs shorter than SEASONAL_MIN_RUN_DAYS are dropped,
         so a one/two-day pre-run flicker never becomes the onset (no Vorlauf).
      2. Trailing smear -- the surviving (confirmed) direction is carried forward over a
         [d - SEASONAL_WINDOW_DAYS, d] window, so a season active now OR just rolled off
         within the last few days still counts. The window is backward-looking, so it only
         extends a confirmed run's tail and never pulls an onset earlier.
      3. Season gate -- a season shorter than SEASONAL_MIN_SEASON_DAYS, or fainter than
         SEASONAL_MIN_SEASON_SHARE of its curves' range, does not count at all.
    All-zero when there are fewer than four distinct curves."""
    n = 365
    if not curves or len(curves) < 4:
        return [0] * n
    raw = [_seasonal_aggregate_dir(curves, d) for d in range(n)]
    conf = _seasonal_confirmed_votes(raw)
    return _seasonal_smear(_seasonal_drop_minor_seasons(conf, curves))


def _seasonal_signal_at(curves, doy):
    """Gated seasonal direction at a day-of-year -> 'bullish' / 'bearish' / 'neutral'.
    Needs four distinct curves (else neutral); reads the trailing-window 3-of-4 sequence."""
    if not curves or len(curves) < 4:
        return "neutral"
    v = _seasonal_gated_sequence(curves)[doy % 365]
    return "bullish" if v == 1 else "bearish" if v == -1 else "neutral"


def _screener_seasonal_signal(seasonal_history, curves=None):
    """Tightened seasonal filter (quality > quantity). Builds the distinct 5/10/15Y + max
    seasonal curves and combines three gates (via _seasonal_gated_sequence): (1) the 3-of-4
    rule -- at least three of the four INDEPENDENT curves share a direction and none points
    the opposite way; (2) the flicker filter (SEASONAL_MIN_RUN_DAYS) -- that aligned
    direction must hold for a sustained run, not a one/two-day blip, so the signal never
    fires a few days early; and (3) the season gate -- only a season lasting
    SEASONAL_MIN_SEASON_DAYS whose curves move SEASONAL_MIN_SEASON_SHARE of their range
    counts. Fewer than four independent curves -> neutral. Returns
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


# The three signals the setup score is built from. Deliberately three, not four:
# the plain COT signal (sign of the net position) was dropped on 2026-08-29 because
# it is a per-market constant wherever hedgers are structurally one-sided -- 13 of 39
# markets never flipped it in 273 weeks, so it could only block one direction and gift
# the other. `cot_hedge` measures the same net against its own trailing range instead.
SCORE_SIGNALS = ("seasonal", "cot_hedge", "structure")


def _signal_dir(value):
    """Map a screener signal to a direction: +1 / -1 / 0.
    seasonal/cot_hedge speak bullish/bearish/neutral; structure speaks premium/discount.
    Anything else -- neutral, None, an unknown string -- is 0."""
    if value in ("bullish", "premium"):
        return 1
    if value in ("bearish", "discount"):
        return -1
    return 0


def screener_score(signals):
    """Signed alignment score over SCORE_SIGNALS (-3 … +3).

    This ONE number answers every consumer question, which is why no companion
    `alignment`/`aligned_count` field exists:
      abs(score) == 3  -> full 3/3 setup      sign -> direction
      abs(score) == 2  -> near miss: exactly two aligned + one neutral
    The near-miss property holds only because there are three signals: an opposing
    vote can never produce abs(score) > 1. A fourth signal would break it.
    """
    return sum(_signal_dir(signals.get(k)) for k in SCORE_SIGNALS)


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


def _screener_cot_hedge_position(cot_series, days=182):
    """Where the latest net sits in that same window, 0..1 (0 = low, 0.5 = midpoint).

    The verdict above is a side and says nothing about distance, and the distance is
    sometimes the whole story: Ethereum cleared the midpoint by 39 contracts in the
    2026-08-25 report — 0.35% of its range — which is a crossing on the definition and a
    coin-flip in fact. A consumer that reports turns (the weekly Ledger does) can only
    tell those apart with a number.

    Deliberately re-derived from the same window rather than returned alongside the
    verdict: the signal's return type is consumed by screener_score and the frontend, and
    widening it to a tuple to carry a diagnostic would touch every caller of the thing
    that must not drift. None wherever the verdict is None or neutral — a flat window has
    no range to hold a position in.
    """
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
        return None
    return round((window[-1] - lo) / (hi - lo), 4)


def _screener_structure_signal(contracts, spread_series=None, as_of=None):
    """Term structure: premium (backwardation) when the front trades over the next month.

    Primary source is the market's own `calendar_spread_series` — the very series the
    calendar-spread pane draws, whose front leg is the volume-led lead contract. Reading
    the signal off it keeps the screener, the chart and the chartbot's historical
    reconstruction (`content/chartbot/backfill.py`) on ONE definition of "front"; the
    nearest-expiry pair below disagrees with it whenever liquidity has rolled forward
    (e.g. soybean oil / live cattle in Aug 2026).

    `as_of` is the market's own latest price date: the spread only counts while it keeps
    up with the price history (SPREAD_SIGNAL_MAX_LAG_DAYS), so a series that stopped —
    trimmed by the trailing-contiguity pass, or missing entirely — hands over instead of
    freezing an old reading.

    Fallback = the nearest two contracts that both carry a live `last`. Yahoo sometimes
    drops the quote for a thinly-traded deferred contract (e.g. the US Dollar Index next
    month DXU…, which trades at a fraction of the front's volume). Comparing only
    contracts[0] vs contracts[1] would then return None and silently drop the market out
    of the 3/3 filter, so the signal degrades to the next available deferred month rather
    than disappearing. Non-quoted far months carry last=None and are skipped, so no stale
    far-deferred print can leak in."""
    last_point = None
    for row in reversed(spread_series or []):
        if row and row.get("spread") is not None:
            last_point = row
            break
    if last_point is not None:
        spread_day = _coerce_iso_date(str(last_point.get("date"))[:10])
        ref_day = _coerce_iso_date(str(as_of)[:10]) if as_of else None
        fresh = (spread_day is not None and ref_day is not None
                 and (ref_day - spread_day).days <= SPREAD_SIGNAL_MAX_LAG_DAYS)
        if fresh:
            return "premium" if float(last_point["spread"]) > 0 else "discount"

    if not contracts:
        return None
    priced = [c.get("last") for c in contracts if c.get("last") is not None]
    if len(priced) < 2:
        return None
    front, nxt = priced[0], priced[1]
    return "premium" if front > nxt else "discount"


def build_screener_summary(by_cat):
    """One lean record per market with the three screener signals and their score."""
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
            # Latest settled bar of this market — the reference the structure signal
            # measures the calendar spread's lag against (see _screener_structure_signal).
            history = cc.get("history") or []
            latest_bar_date = history[-1].get("date") if history else None
            row = {
                "key": key,
                "display_name": mk.get("display_name"),
                "category": cat,
                "slug": _slug(cat),
                "last": front.get("last"),
                "change_pct": front.get("change_pct"),
                "seasonal": _screener_seasonal_signal(seasonal_history, curves=seasonal_curves),
                "cot_hedge": _screener_cot_hedge_signal(mk.get("cot_series") or []),
                # The same verdict one COT release earlier. The window is anchored on the
                # series' LAST point (see _screener_cot_hedge_signal), so dropping that
                # point is exactly "as of the previous report" — not an approximation.
                # It is emitted here, next to the reading it is compared against, because
                # the consumer is the weekly Hedgers' Ledger, which reports the programs
                # that TURNED. Deriving it over there would put a second copy of this
                # definition in the content repo, which is the one thing the split between
                # screener.py and blog/hedgeboard.py exists to prevent. None for a market
                # with fewer than two COT points — no previous reading, not a turn.
                "cot_hedge_prev": _screener_cot_hedge_signal(
                    (mk.get("cot_series") or [])[:-1]),
                # Which COT cohort the two readings above are ABOUT. Not a signal, and the
                # only non-signal field here, but the tracked book is not always the
                # commercial one — the financial futures carry Leveraged Funds / Managed
                # Money / Asset Manager, i.e. speculators. A consumer that names the cohort
                # in prose (the Ledger does) would otherwise have to open the 60 MB market
                # JSONs for one string per market, or guess — and guessing here means
                # calling leveraged funds "hedgers".
                "cot_label": ((mk.get("cot_series") or [{}])[-1] or {}).get("cot_label"),
                # How far the net actually sits from that midpoint (0..1 in the window).
                # A side alone cannot separate a decisive crossing from a 39-contract one.
                "cot_hedge_pos": _screener_cot_hedge_position(mk.get("cot_series") or []),
                "structure": _screener_structure_signal(
                    contracts,
                    spread_series=mk.get("calendar_spread_series") or [],
                    as_of=latest_bar_date,
                ),
                "seasonal_event": _screener_seasonal_event(seasonal_history, curves=seasonal_curves),
            }
            row["score"] = screener_score(row)
            out.append(row)
    return out


# ── 3/3 period log (ff_data/three_three_log.json) ─────────────────────────────
#
# The Weekly Outlook's shaded band and its "active since / runway" line, and the content
# bot's card-mode markers, all read ONE file: three_three_log.json. It used to be written
# by the bot alone, which meant an on-screen feature hung on a semi-automatic Telegram run
# — cotton and soybean oil turned 3/3 after the last one and drew no band at all, while
# lean hogs kept painting an OPEN band two days after it had fallen to 2/3. The generator
# writes it now, on every refresh, from the same helpers build_screener_summary uses.
#
# Two properties the bot's rebuild did not have:
#   1. It MERGES. The reconstruction below reaches exactly as far back as the market's
#      calendar-spread series, which is trimmed on every refresh — so a rebuild from
#      scratch silently forgets every period older than that window (orange juice's May
#      period went that way). See merge_three_three_periods.
#   2. It closes an open period today's screener refutes. An open period means "still
#      running", and a market that reads 2/3 now positively is not.


def _three_three_seasonal_sequence(mk, curves=None):
    """The market's gated 365-day seasonal direction sequence, or None when its history
    is too thin for the 3-of-4 vote (fewer than four distinct curves)."""
    if curves is None:
        curves = _seasonal_distinct_curves(
            (mk.get("continuous_contract") or {}).get("seasonal_history"))
    if not curves or len(curves) < 4:
        return None
    return _seasonal_gated_sequence(curves)


def _three_three_seasonal_at(seq, iso):
    """Seasonal verdict on one calendar day, off the prebuilt sequence."""
    doy = _screener_doy(iso)
    if doy is None:
        doy = 58                      # Feb 29 (or an unparseable date): read Feb 28's slot
    v = seq[doy % 365]
    return "bullish" if v == 1 else "bearish" if v == -1 else "neutral"


def _three_three_at(seq, spread_by_date, cot_series, iso):
    """The alignment on a PAST day. The live `score` in screener.json only speaks for
    today, so the three signals are reconstructed for `iso` and sent through the same
    screener_score rule. Structure is the sign of that day's calendar spread — the
    volume-led front/next pair the chart pane draws, so the band cannot disagree with the
    line it sits behind."""
    if iso not in spread_by_date:
        return None
    cot_slice = [r for r in cot_series if str(r.get("date"))[:10] <= iso]
    score = screener_score({
        "seasonal": _three_three_seasonal_at(seq, iso),
        "cot_hedge": _screener_cot_hedge_signal(cot_slice),
        "structure": "premium" if spread_by_date[iso] > 0 else "discount",
    })
    return "bullish" if score == 3 else "bearish" if score == -3 else None


def build_three_three_periods(mk, curves=None):
    """Reconstruct the market's 3/3 periods [{direction, start, end}] over its calendar-
    spread window (end=None = still open). Seasonal is the only forward-predictable
    signal; the spread series is what bounds the reach backwards."""
    seq = _three_three_seasonal_sequence(mk, curves)
    if seq is None:
        return []
    spread_by_date = {str(r["date"])[:10]: r["spread"]
                      for r in (mk.get("calendar_spread_series") or [])
                      if r.get("spread") is not None}
    dates = sorted(spread_by_date)
    if not dates:
        return []
    cot_series = mk.get("cot_series") or []
    periods, cur = [], None
    for d in dates:
        st = _three_three_at(seq, spread_by_date, cot_series, d)
        if st == cur:
            continue
        if cur is not None and periods and periods[-1].get("end") is None:
            periods[-1]["end"] = d
        if st:
            periods.append({"direction": st, "start": d, "end": None})
        cur = st
    return periods


def seasonal_runway(mk, today=None, curves=None):
    """How much longer the (predictable) seasonal keeps backing the current direction
    before it flips and the setup falls to 2/3 -> {days, until, direction} or None."""
    seq = _three_three_seasonal_sequence(mk, curves)
    if seq is None:
        return None
    today = today or date.today()
    cur = _three_three_seasonal_at(seq, today.isoformat())
    if cur == "neutral":
        return None
    for d in range(1, 366):
        fut = today + timedelta(days=d)
        if _three_three_seasonal_at(seq, fut.isoformat()) != cur:
            return {"days": d, "until": fut.isoformat(), "direction": cur}
    return {"days": 365, "until": (today + timedelta(days=365)).isoformat(),
            "direction": cur}


def _spread_window_start(mk):
    """First priced day of the calendar-spread series — the earliest day
    build_three_three_periods can speak about. None when there is no series at all."""
    dates = [str(r["date"])[:10] for r in (mk.get("calendar_spread_series") or [])
             if r.get("spread") is not None]
    return min(dates) if dates else None


def merge_three_three_periods(previous, fresh, window_start):
    """Fold a fresh reconstruction into the stored periods.

    `fresh` is authoritative from `window_start` onwards — that is exactly the span it can
    see. Stored periods that START before it are kept, because nothing can recompute them
    any more; one that reaches INTO the window is clipped at its edge so the two halves
    cannot overlap or contradict each other. `window_start` is None when the market has no
    spread series at all, and then the stored log simply is the log.

    Copies throughout: the caller's `previous` comes straight off the file on disk and a
    later step closes open periods in place.
    """
    kept = []
    for p in (previous or []):
        start = str(p.get("start"))
        if window_start is not None and start >= window_start:
            continue                                   # inside the window: fresh wins
        q = dict(p)
        if window_start is not None and (q.get("end") is None or str(q["end"]) > window_start):
            q["end"] = window_start
        if q.get("end") is not None and str(q["end"]) <= start:
            continue                                   # clipped away entirely
        kept.append(q)
    return kept + [dict(p) for p in (fresh or [])]


def build_three_three_log(by_cat, screener_rows, previous=None, today=None):
    """{key: {active, periods, runway?}} for every market that has a 3/3 period to show.

    `previous` is the log as it stands on disk (see merge_three_three_periods) and
    `screener_rows` is what build_screener_summary just produced — the live verdict for
    today, which both opens a period the reconstruction cannot reach (a market with no
    usable spread history is 3/3 from today) and closes one it refutes.
    """
    previous = previous or {}
    today = today or date.today().isoformat()
    scores = {r.get("key"): r.get("score") for r in (screener_rows or [])}
    log = {}
    for payload in by_cat.values():
        for key, mk in payload.items():
            periods = merge_three_three_periods(
                (previous.get(key) or {}).get("periods") or [],
                build_three_three_periods(mk),
                _spread_window_start(mk))
            score = scores.get(key)
            cur_dir = "bullish" if score == 3 else "bearish" if score == -3 else None
            last = periods[-1] if periods else None
            open_last = last is not None and last.get("end") is None
            if cur_dir:
                # Guarantee an open period for today's 3/3 even without any reconstructed
                # history — a market whose spread series does not reach its season would
                # otherwise draw no band at all (cotton, soybean oil).
                if not (open_last and last["direction"] == cur_dir):
                    if open_last:
                        last["end"] = today
                    periods.append({"direction": cur_dir, "start": today, "end": None})
            elif open_last:
                # Refuted by today's screener: an open period paints a band that is still
                # running, and this market is not (lean hogs kept one for two days).
                last["end"] = today
            if not periods:
                continue
            active = periods[-1]["direction"] if periods[-1]["end"] is None else None
            entry = {"active": active, "periods": periods}
            if active and cur_dir:
                try:
                    rw = seasonal_runway(mk, today=date.fromisoformat(today))
                except ValueError:
                    rw = None
                if rw:
                    entry["runway"] = rw
            log[key] = entry
    return log
