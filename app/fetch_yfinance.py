"""yfinance data: OHLCV/contracts/volume/seasonal fetch, calendar spread, continuous.

Split out of commodity_dashboard.py — see CLAUDE.md "Architecture".
"""

import bisect
import logging
import os
import csv
import contextlib
import io
import json
import re
import threading
import urllib.request
import urllib.parse
from datetime import date, datetime, time, timedelta
from dateutil.relativedelta import relativedelta

logging.getLogger("yfinance").setLevel(logging.CRITICAL)  # quiet without per-call stdout redirect

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
    SPREAD_MAX_GAP_DAYS,
    SPREAD_MIN_PAIR_POINTS,
    SPREAD_ROLL_CONFIRM_DAYS,
    SPREAD_SPIKE_REVERT_PCT,
    YF_CONTRACT_LOOKAHEAD,
    YF_LIQUID_ACTIVE_DAYS_AFTER_EXPIRY,
    YF_LIQUID_ACTIVE_DAYS_BEFORE_EXPIRY,
    YF_LIQUID_CONTINUOUS_EMPTY_STOP,
    YF_LIQUID_CONTINUOUS_FORWARD_MONTHS,
    YF_LIQUID_CONTINUOUS_LOOKBACK_MONTHS,
    YF_LIQUID_CONTINUOUS_MAX_CONTRACTS,
    YF_LIQUID_CONTINUOUS_MIN_VOLUME,
    YF_TOTAL_VOLUME_EMPTY_STOP,
    YF_TOTAL_VOLUME_LOOKAHEAD,
    YF_TOTAL_VOLUME_MAX_CONTRACTS,
    YF_TOTAL_VOLUME_MAX_POINTS,
    YF_PRICE_HISTORY_MAX_POINTS,
)
from series_utils import (
    BLANK,
    _coerce_iso_date,
    _drop_unsettled_tail,
    _round_price,
    _trim_leading_flat,
)
from contracts import build_contract_candidates, build_total_volume_contract_candidates
from local_first_merge import _merge_volume_series

__all__ = [
    'YahooFinanceClient',
    '_cached_seasonal_last_year',
    '_clean_contract_history_row',
    '_contract_is_active_for_day',
    '_contract_is_pre_active_for_day',
    '_drop_spike_revert_outliers',
    '_drop_spread_spike_reverts',
    '_existing_seasonal_years',
    '_expiry_sort_value',
    '_history_row_looks_tradable',
    '_should_refresh_seasonal',
    '_spread_pair',
    '_stabilised_front_chain',
    '_total_volume_rows_from_by_date',
    '_trailing_contiguous_spread',
    '_trailing_same_pair_spread',
    '_yf_client',
    'build_calendar_spread_series',
    'build_continuous_contract',
    'fetch_chart_history',
    'fetch_price_chart_history',
    'fetch_seasonal_price_history',
    'fetch_yfinance_liquid_continuous_history',
    'fetch_yfinance_total_volume_series',
    'select_yfinance_contracts',
]



class YahooFinanceClient:
    """Small adapter layer: caching, quiet failures and a consistent result format."""

    def __init__(self):
        self._ticker_cache = {}
        self._quote_cache = {}
        self._history_cache = {}

    def _ticker(self, symbol):
        if yf is None:
            return None
        if symbol not in self._ticker_cache:
            self._ticker_cache[symbol] = yf.Ticker(symbol)
        return self._ticker_cache[symbol]

    def _history(self, symbol, period, interval="1d", quiet=False):
        cache_key = (symbol, period, interval)
        if cache_key in self._history_cache:
            return self._history_cache[cache_key]

        ticker = self._ticker(symbol)
        if ticker is None:
            return None

        # yfinance noise is silenced via its logger (CRITICAL at import). We no longer
        # redirect process-global stdout/stderr here — that is unsafe when markets are
        # fetched concurrently (Task 8). `quiet` is kept for call-site compatibility.
        hist = ticker.history(period=period, interval=interval)
        self._history_cache[cache_key] = hist
        return hist

    def quote(self, yf_symbol, quiet=False):
        if yf_symbol in self._quote_cache:
            return dict(self._quote_cache[yf_symbol])
        if yf is None:
            return dict(BLANK)

        try:
            hist = self._history(yf_symbol, period="10d", interval="1d", quiet=quiet)
            if hist is None or hist.empty:
                self._quote_cache[yf_symbol] = dict(BLANK)
                return dict(BLANK)

            # Build settled-EoD rows, then quote off the last *settled* bar — never a
            # still-forming pre-settle print (same rule as chart_history).
            rows = []
            for idx, row in hist.iterrows():
                o, h, l, c = row["Open"], row["High"], row["Low"], row["Close"]
                if any(v != v for v in (o, h, l, c)):
                    continue
                rows.append({
                    "date": idx.strftime("%Y-%m-%d"),
                    "open": _round_price(float(o)), "high": _round_price(float(h)),
                    "low": _round_price(float(l)), "close": _round_price(float(c)),
                    "volume": int(row["Volume"]) if "Volume" in row and row["Volume"] == row["Volume"] else None,
                })
            rows = _drop_unsettled_tail(rows)
            if not rows:
                self._quote_cache[yf_symbol] = dict(BLANK)
                return dict(BLANK)

            last_close = rows[-1]["close"]
            prev_close = rows[-2]["close"] if len(rows) >= 2 else last_close
            change = last_close - prev_close
            change_pct = (change / prev_close * 100) if prev_close else 0.0
            volume = rows[-1]["volume"]

            out = {
                "last": _round_price(last_close),
                "change": _round_price(change),
                "change_pct": round(change_pct, 2),
                "volume": volume,
                "open_interest": None,
                "available": True,
                "source": "yfinance",
            }
            self._quote_cache[yf_symbol] = out
            return dict(out)
        except Exception as e:
            if not quiet:
                print(f"   ⚠  yfinance {yf_symbol}: {e}")
            self._quote_cache[yf_symbol] = dict(BLANK)
            return dict(BLANK)

    def chart_history(self, yf_continuous, period="5y", quiet=False):
        if yf is None:
            return []
        try:
            hist = self._history(yf_continuous, period=period, interval="1d", quiet=quiet)
            if hist is None or hist.empty:
                return []

            out = []
            for idx, row in hist.iterrows():
                o, h, l, c = row["Open"], row["High"], row["Low"], row["Close"]
                if any(v != v for v in (o, h, l, c)):  # NaN-Check
                    continue
                out.append({
                    "date": idx.strftime("%Y-%m-%d"),
                    "open": _round_price(float(o)),
                    "high": _round_price(float(h)),
                    "low": _round_price(float(l)),
                    "close": _round_price(float(c)),
                    "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else None,
                })
            return _drop_unsettled_tail(_trim_leading_flat(out))
        except Exception as e:
            print(f"   ⚠  chart history {yf_continuous}: {e}")
            return []


class _ThreadLocalYahooClient:
    """Each thread gets its own YahooFinanceClient. The client's caches + yfinance
    Ticker objects are not safe to share across the Task 8 fetch pool, so we never do."""
    def __init__(self):
        self._local = threading.local()

    def _client(self):
        c = getattr(self._local, "client", None)
        if c is None:
            c = YahooFinanceClient()
            self._local.client = c
        return c

    def __getattr__(self, name):
        return getattr(self._client(), name)

_yf_client = _ThreadLocalYahooClient()


def fetch_chart_history(yf_continuous, period="20y"):
    """
    Fetches daily OHLC + volume history for a yfinance chart symbol.
    ~20 years of daily data -> Daily/Weekly/Monthly/Quarterly and all ranges can be
    derived client-side (the maximized "Charts" tab needs the deep tail for its higher
    timeframes; the Futures tab still only renders up to its 5Y range).

    Returns: list of {date, open, high, low, close, volume}
    """
    return _yf_client.chart_history(yf_continuous, period=period)


def fetch_price_chart_history(cfg, period="20y"):
    """Loads the main chart history through the configured yfinance symbol."""
    symbol = cfg.get("yf_continuous")
    return symbol, fetch_chart_history(symbol, period=period)


def _drop_spike_revert_outliers(history, jump=0.06, neighbor_tol=0.03):
    """Drops single-day spike-and-revert bad prints from a daily price series.

    A bar is removed only when it is an isolated round-trip spike: its close
    deviates from BOTH neighbours by >= ``jump`` while the two neighbours agree
    within ``neighbor_tol`` (the price returns to where it was). Sustained moves
    and genuine V-reversals — where the next day does NOT return to the pre-spike
    level — are kept, so real volatility is never smoothed away. Conservative by
    design: only obvious Yahoo glitches are dropped and nothing is synthesised.
    """
    rows = list(history or [])
    if len(rows) < 3:
        return rows
    keep = [True] * len(rows)
    for i in range(1, len(rows) - 1):
        try:
            p0 = float(rows[i - 1]["close"])
            p1 = float(rows[i]["close"])
            p2 = float(rows[i + 1]["close"])
        except (TypeError, ValueError, KeyError):
            continue
        if p0 <= 0 or p1 <= 0 or p2 <= 0:
            continue
        dev_prev = abs(p1 - p0) / p0
        dev_next = abs(p1 - p2) / p2
        neighbours_agree = abs(p2 - p0) / p0 <= neighbor_tol
        is_local_extreme = (p1 - p0) * (p1 - p2) > 0
        if dev_prev >= jump and dev_next >= jump and neighbours_agree and is_local_extreme:
            keep[i] = False
    return [r for r, k in zip(rows, keep) if k]


def fetch_seasonal_price_history(cfg, fallback_history=None):
    """Loads the longest available yfinance history for seasonal tendency charts."""
    symbol = cfg.get("yf_continuous")
    if not symbol:
        return fallback_history or []
    history = _drop_spike_revert_outliers(
        _yf_client.chart_history(symbol, period="max", quiet=True)
    )
    if len(history) >= max(260, len(fallback_history or [])):
        return history
    return fallback_history or history or []


_existing_seasonal_years = None


def _cached_seasonal_last_year(key, data_dir="ff_data"):
    """Most recent year present in the previously stored seasonal history for a market."""
    global _existing_seasonal_years
    if _existing_seasonal_years is None:
        _existing_seasonal_years = {}
        try:
            for name in os.listdir(data_dir):
                if not (name.startswith("data_") and name.endswith(".json")):
                    continue
                with open(os.path.join(data_dir, name), encoding="utf-8") as f:
                    payload = json.load(f)
                if isinstance(payload, dict):
                    for k, v in payload.items():
                        sh = (v.get("continuous_contract") or {}).get("seasonal_history") or []
                        if sh:
                            _existing_seasonal_years[k] = str(sh[-1].get("date", ""))[:4]
        except Exception:
            pass
    yr = _existing_seasonal_years.get(key)
    return int(yr) if yr and yr.isdigit() else None


def _should_refresh_seasonal(key, data_dir="ff_data"):
    """Seasonal tendency barely changes year to year, so the expensive
    full-history fetch only runs about once a year: when there is no cached
    seasonal yet, or on the first update of a new calendar year. Otherwise the
    cached series is reused (handled in the merge-with-existing step)."""
    last_year = _cached_seasonal_last_year(key, data_dir)
    if last_year is None:
        return True
    return last_year < date.today().year


def fetch_yfinance_total_volume_series(cfg, period="5y", count=YF_TOTAL_VOLUME_MAX_CONTRACTS):
    """Builds a daily continuous-volume series by summing available Yahoo contracts."""
    if yf is None or cfg.get("chart_format") == "dxy_index_proxy":
        return []

    by_date = {}
    active_contracts = 0
    empty_streak = 0
    candidates = build_total_volume_contract_candidates(cfg, max_contracts=count)
    if not candidates:
        candidates = build_contract_candidates(cfg, count=YF_TOTAL_VOLUME_LOOKAHEAD)

    for contract in candidates:
        symbol = contract.get("yf_symbol")
        if not symbol:
            continue
        rows = _yf_client.chart_history(symbol, period=period, quiet=True)
        found_volume = False
        for row in rows:
            day = str(row.get("date") or "")[:10]
            volume = row.get("volume")
            if not day or volume is None:
                continue
            try:
                volume_int = int(volume)
            except (TypeError, ValueError):
                continue
            if volume_int <= 0:
                continue
            item = by_date.setdefault(day, {"volume": 0, "symbols": set()})
            item["volume"] += volume_int
            item["symbols"].add(symbol)
            found_volume = True

        if found_volume:
            active_contracts += 1
            empty_streak = 0
        else:
            empty_streak += 1
            if active_contracts and empty_streak >= YF_TOTAL_VOLUME_EMPTY_STOP:
                break

    out = []
    for day in sorted(by_date):
        item = by_date[day]
        out.append({
            "date": day,
            "volume": int(item["volume"]),
            "source": "yfinance_contract_sum",
            "method": "summed_yfinance_single_contract_histories",
            "contract_count": len(item["symbols"]),
        })
    return out[-YF_TOTAL_VOLUME_MAX_POINTS:]


def _clean_contract_history_row(row, day=None):
    """Normalizes one yfinance OHLC row and rejects incomplete candles."""
    if not row:
        return None
    day = day or str(row.get("date") or "")[:10]
    if not day:
        return None
    try:
        o = float(row.get("open"))
        h = float(row.get("high"))
        l = float(row.get("low"))
        c = float(row.get("close"))
    except (TypeError, ValueError):
        return None
    if any(v != v for v in (o, h, l, c)):
        return None
    volume = row.get("volume")
    try:
        volume_int = int(volume) if volume is not None else 0
    except (TypeError, ValueError):
        volume_int = 0
    return {
        "date": day,
        "open": _round_price(o),
        "high": _round_price(h),
        "low": _round_price(l),
        "close": _round_price(c),
        "volume": volume_int,
    }


def _history_row_looks_tradable(row):
    if not row:
        return False
    volume = row.get("volume") or 0
    if volume < YF_LIQUID_CONTINUOUS_MIN_VOLUME:
        return False
    flat = row.get("open") == row.get("high") == row.get("low") == row.get("close")
    return not flat


def _contract_is_active_for_day(contract, day):
    """
    Keeps the volume-led selector from choosing very far deferred contracts.

    Yahoo often no longer serves the exact contract that was active several
    years ago, while still returning prices for later expiries on those dates.
    Without this guard a 2025 contract could become the "highest volume" candle
    in 2024 simply because the true 2024 contract is no longer available.
    """
    exp = _coerce_iso_date(contract.get("expiry"))
    row_day = _coerce_iso_date(day)
    if not exp or not row_day:
        return True
    if row_day > exp + timedelta(days=YF_LIQUID_ACTIVE_DAYS_AFTER_EXPIRY):
        return False
    if row_day < exp - timedelta(days=YF_LIQUID_ACTIVE_DAYS_BEFORE_EXPIRY):
        return False
    return True


def _contract_is_pre_active_for_day(contract, day):
    """True for a row that is only *too early* for the activity window (not expired).

    These deferred rows are deliberately kept out of the volume-led selection (see
    `_contract_is_active_for_day`), but the calendar spread needs them as a possible
    NEXT leg: the month following the lead contract is regularly more than
    `YF_LIQUID_ACTIVE_DAYS_BEFORE_EXPIRY` away from its own expiry (e.g. with gold's
    lead at GCZ26, the next tradable month GCG27 only enters the window a week before
    GCQ26 dies). Without them the spread has nothing to pair the lead against and falls
    back to the nearest, dying expiry.
    """
    exp = _coerce_iso_date(contract.get("expiry"))
    row_day = _coerce_iso_date(day)
    if not exp or not row_day:
        return False
    return row_day < exp - timedelta(days=YF_LIQUID_ACTIVE_DAYS_BEFORE_EXPIRY)


def _total_volume_rows_from_by_date(by_date, method):
    out = []
    for day in sorted(by_date):
        item = by_date[day]
        out.append({
            "date": day,
            "volume": int(item["volume"]),
            "source": "yfinance_contract_sum",
            "method": method,
            "contract_count": len(item["symbols"]),
        })
    return out[-YF_TOTAL_VOLUME_MAX_POINTS:]


def _expiry_sort_value(row):
    exp = _coerce_iso_date(row.get("expiry"))
    return exp.toordinal() if exp else 99999999


def _drop_spread_spike_reverts(rows, pct=SPREAD_SPIKE_REVERT_PCT):
    """Drop a single-day calendar-spread value that spikes away from both
    neighbours and reverts the next day (a bad single-contract print), leaving a
    gap. The tolerance scales with the front price so near-zero spreads in
    low-priced markets aren't over-cut."""
    if len(rows) < 3:
        return rows
    keep = [True] * len(rows)
    for i in range(1, len(rows) - 1):
        prev, cur, nxt = rows[i - 1], rows[i], rows[i + 1]
        tol = pct * abs(float(cur.get("front_close") or 0.0))
        if tol <= 0:
            continue
        d_in = cur["spread"] - prev["spread"]
        d_out = nxt["spread"] - cur["spread"]
        spike = abs(d_in) > tol and abs(d_out) > tol and (d_in > 0) != (d_out > 0)
        reverts = abs(nxt["spread"] - prev["spread"]) <= tol
        if spike and reverts:
            keep[i] = False
    return [r for i, r in enumerate(rows) if keep[i]]


def _trailing_contiguous_spread(rows, max_gap_days=SPREAD_MAX_GAP_DAYS):
    """Keep only the most recent run of spread points with no gap larger than
    ``max_gap_days``. Yahoo only serves the current front contracts, so dates
    before they became the real front/next come out sparse/gappy — everything
    before the last such gap is dropped so only currently-traded months remain."""
    if len(rows) < 2:
        return rows
    start = 0
    for i in range(len(rows) - 1, 0, -1):
        d_cur = _coerce_iso_date(rows[i]["date"])
        d_prev = _coerce_iso_date(rows[i - 1]["date"])
        if d_cur and d_prev and (d_cur - d_prev).days > max_gap_days:
            start = i
            break
    return rows[start:]


def _stabilised_front_chain(day_leads, confirm_days=SPREAD_ROLL_CONFIRM_DAYS):
    """Turn the raw per-day volume lead into a front that rolls once, forward only.

    Mid-roll the two nearest months trade almost equally, and the lead flips back and
    forth between them on consecutive sessions — brent printed
    X26 / V26x8 / X26 / V26x2 / X26 over two weeks. Taken literally that is five front
    changes, which chops the pane (which shows one contract pair) into one- and two-day
    slivers. So a higher lead is adopted only when it HOLDS for `confirm_days` sessions,
    and the front never moves back to an earlier month: a real roll is one-way.

    `day_leads` is [(day, chain_index), …] in date order; returns {day: chain_index}.
    A lone forward print therefore costs nothing, where a plain ratchet would have
    latched onto brent's stray 2026-08-05 X26 print and held it for the next eight
    sessions in which V26 was clearly the traded month.
    """
    out, current = {}, None
    for i, (day, lead) in enumerate(day_leads):
        if current is None:
            current = lead
        elif lead > current:
            window = [l for _, l in day_leads[i:i + confirm_days]]
            if len(window) == confirm_days and all(l >= lead for l in window):
                current = lead
        out[day] = current
    return out


def _spread_pair(row):
    return (row.get("front_contract"), row.get("next_contract"))


def _trailing_same_pair_spread(rows, min_points=SPREAD_MIN_PAIR_POINTS):
    """Keep the trailing run that measures the CURRENT front/next pair.

    A spliced series is not one indicator: each roll swaps in a different pair, and with
    it a different horizon, so the line steps to a new level for reasons that have
    nothing to do with the market (euro's Mar-Sep pair sat near -0.011 while the
    current Sep-Dec pair trades near -0.004). Plotted together the older segments own
    the y-axis and flatten the spread the reader is actually looking at. So the pane
    shows the spread of the pair that trades TODAY, starting on the day that pair
    became front/next.

    The day after a roll that pair has one point, which is a blank pane rather than an
    honest one — on 2026-08-21 four markets sat there at once. So while the current run
    is shorter than `min_points`, ONE preceding pair comes along for context (never
    more: the point is a readable pane, not a spliced history). Consumers must break
    the line where the pair changes — `chart.js` and `screener.js` start a new path
    segment there — so the roll step is never drawn as a move in the spread.
    """
    if not rows:
        return rows
    pair = _spread_pair(rows[-1])
    start = len(rows) - 1
    while start > 0 and _spread_pair(rows[start - 1]) == pair:
        start -= 1
    if len(rows) - start >= min_points or start == 0:
        return rows[start:]
    prev_pair = _spread_pair(rows[start - 1])
    prev_start = start - 1
    while prev_start > 0 and _spread_pair(rows[prev_start - 1]) == prev_pair:
        prev_start -= 1
    return rows[prev_start:]


def build_calendar_spread_series(candidates_by_date, deferred_by_date=None):
    """Front-minus-next calendar spread per day (negative = contango).

    Front = the LEAD contract that day — the one carrying the most reported volume —
    next = the nearest expiry strictly after the front. Spread = front_close - next_close.
    Anchoring the front leg to volume (not just nearest expiry) keeps the spread on the
    actively-traded month: liquidity rolls forward before expiry, so the nearest calendar
    month can be nearly dead (e.g. mid-June gold trades August, not June) and a
    nearest-expiry front would measure an illiquid, stale leg.

    `deferred_by_date` maps a day to its NEAREST month still outside the volume-led
    activity window (`_contract_is_pre_active_for_day`) and supplies the NEXT leg when the
    lead is the farthest *active* month. That is the normal case, not an edge case: with gold's
    lead at GCZ26 the following month GCG27 sits ~190 days from its own expiry and is not
    an active candidate yet, so without the deferred pool the spread used to drop back
    onto the dying GCQ26 (1.3k lots) instead of the 250k-lot lead. Deferred rows are only
    ever the next leg — never the front — so the volume-led front stands unchanged.

    ONE active leg is therefore enough. Widely spaced contract months can put every other
    month outside the window permanently: sugar trades Mar/May/Jul/Oct, so the step from
    SBV26 (expiry Sep 30) to SBH27 (Feb 26) is five months and the market never has two
    active legs on the same day — it had no spread series AT ALL until the deferred month
    was allowed to be the partner. The spread then spans the real gap to the next LISTED
    month, which for such a market is exactly what a calendar spread is.

    The spread is computed for EVERY day on which the lead month and its immediate
    successor both print — liquidity is deliberately NOT gated past picking the lead.
    When no leg reports positive volume (thinly-traded deferred months on Yahoo — BTC
    monthly, USD Index), the front falls back to the nearest expiry so the spread never
    goes missing. `legs` is expiry-sorted, so ties in volume break toward the nearer
    expiry, and a spurious far-month volume print can at worst cost that one day, never
    strand the series on a far contract. Real settled closes only (no synthetic fill); a
    spike-revert pass drops single bad prints and a trailing-contiguity pass keeps the
    most recent gap-free run.
    """
    rows = []
    deferred_by_date = deferred_by_date or {}
    # Which chain positions this market actually lists, over the whole window. The next
    # leg is picked from THIS set, so the pairing is a property of the market and not of
    # whatever printed on a given day — see `_chain_successor`.
    listed_chain = sorted({r.get("chain_index")
                           for rows_ in candidates_by_date.values() for r in rows_
                           if r.get("chain_index") is not None and r.get("close") is not None}
                          | {r.get("chain_index") for r in deferred_by_date.values()
                             if r.get("chain_index") is not None and r.get("close") is not None})

    def _chain_successor(c):
        i = bisect.bisect_right(listed_chain, c)
        return listed_chain[i] if i < len(listed_chain) else None

    # Pass 1: the raw volume lead per day, then stabilised into a roll that only ever
    # moves forward and only once confirmed (see `_stabilised_front_chain`).
    legs_by_day, day_leads = {}, []
    for day in sorted(candidates_by_date):
        legs = sorted((r for r in candidates_by_date[day] if r.get("close") is not None),
                      key=_expiry_sort_value)
        if not legs:
            continue
        lead = max(legs, key=lambda r: (r.get("roll_basis_volume") or 0))
        if (lead.get("roll_basis_volume") or 0) <= 0:
            lead = legs[0]   # no volume anywhere → nearest active expiry
        chain = lead.get("chain_index")
        if chain is None:
            continue
        legs_by_day[day] = legs
        day_leads.append((day, chain))
    front_by_day = _stabilised_front_chain(day_leads)

    for day, _raw_lead in day_leads:
        legs = legs_by_day[day]
        chain = front_by_day[day]
        front = next((r for r in legs if r.get("chain_index") == chain), None)
        if front is None:
            continue   # the settled front did not print today
        # NEXT is the month that follows the front in the chain THIS MARKET LISTS — active
        # if it is one, otherwise the deferred row for that day. Never a month further out
        # than that: Yahoo leaves thin deferred months dark on individual days, and
        # substituting the next-but-one there made the pane alternate between two
        # different horizons from day to day (6EH26-6EU26 at -0.0088 against
        # 6EH26-6EZ26 at -0.0125, flipping on consecutive sessions). A day whose successor
        # has no print is dropped instead; the trailing-contiguity pass then decides how
        # far back the clean run reaches.
        #
        # The successor comes from `listed_chain` rather than being chain+1, so a month
        # Yahoo never serves does not silently cost the market its whole series — with a
        # hard chain+1 a single thin month going dark for one run (ETHV26, ~13 print days)
        # emptied Ethereum's spread completely. Pairing stays stable either way because
        # the choice is made once per market, not per day.
        target = _chain_successor(chain)
        if target is None:
            continue
        nxt = next((r for r in legs if r.get("chain_index") == target), None)
        if nxt is None:
            deferred = deferred_by_date.get(day)
            if (deferred is not None and deferred.get("close") is not None
                    and deferred.get("chain_index") == target):
                nxt = deferred
        if nxt is None:
            continue
        rows.append({
            "date": day,
            "spread": round(float(front["close"]) - float(nxt["close"]), 6),
            "front_contract": front.get("contract_symbol"),
            "next_contract": nxt.get("contract_symbol"),
            "front_close": round(float(front["close"]), 6),
            "next_close": round(float(nxt["close"]), 6),
            "source": "yfinance_liquid_contracts",
        })
    rows = _drop_spread_spike_reverts(rows)
    # ONE pair only — the one trading today (see `_trailing_same_pair_spread`); then the
    # most recent contiguous block within it, since even a single pair comes out gappy
    # once Yahoo stops serving one of its legs on individual days.
    rows = _trailing_same_pair_spread(rows)
    return _trailing_contiguous_spread(rows)[-YF_TOTAL_VOLUME_MAX_POINTS:]


def fetch_yfinance_liquid_continuous_history(
    cfg,
    fallback_history=None,
    period="5y",
    count=YF_LIQUID_CONTINUOUS_MAX_CONTRACTS,
):
    """
    Builds a custom continuous chart from single-contract histories.

    For every trading date, the candle is selected from the available contract
    with the highest reported volume. That avoids front-month charts staying in
    a stale/illiquid contract until expiry and removes many spotty gaps that
    appear in the generic Yahoo continuous symbols.
    """
    if yf is None:
        return fallback_history or [], [], []
    # Index-proxy markets (USD Index): keep the price chart on the Yahoo cash/index
    # series (the ICE futures continuous DX=F is delisted) and skip the volume-led
    # overlay + summed-contract volume pane. The real ICE single contracts ARE still
    # fetched below so the front-next calendar spread can be built (see the
    # is_index_proxy branch after the spread).
    is_index_proxy = cfg.get("chart_format") == "dxy_index_proxy"

    candidates = build_total_volume_contract_candidates(
        cfg,
        lookback_months=YF_LIQUID_CONTINUOUS_LOOKBACK_MONTHS,
        forward_months=YF_LIQUID_CONTINUOUS_FORWARD_MONTHS,
        max_contracts=count,
    )
    if not candidates:
        return fallback_history or [], [], []

    candidates_by_date = {}
    deferred_by_date = {}    # not-yet-active months; next-leg pool for the calendar spread
    total_by_date = {}
    active_contracts = 0
    empty_streak = 0

    for contract in candidates:
        symbol = contract.get("yf_symbol")
        if not symbol:
            continue
        rows = _yf_client.chart_history(symbol, period=period, quiet=True)
        found_tradable = False
        for row in rows:
            clean = _clean_contract_history_row(row)
            if not clean:
                continue
            day = clean["date"]
            volume = clean.get("volume") or 0
            if volume > 0:
                item = total_by_date.setdefault(day, {"volume": 0, "symbols": set()})
                item["volume"] += int(volume)
                item["symbols"].add(symbol)

            if not _history_row_looks_tradable(clean):
                continue
            is_active = _contract_is_active_for_day(contract, day)
            # Not active yet (only too early, not expired) → keep it aside as a possible
            # NEXT leg for the calendar spread; it stays out of the volume-led selection.
            if not is_active and not _contract_is_pre_active_for_day(contract, day):
                continue

            found_tradable = found_tradable or is_active
            enriched = dict(clean)
            enriched.update({
                "source": "yfinance_liquid_contract",
                "yf_symbol": symbol,
                "contract_symbol": contract.get("contract_symbol"),
                "chain_index": contract.get("chain_index"),
                "contract_label": contract.get("delivery_month_label") or contract.get("label"),
                "delivery_month": contract.get("delivery_month"),
                "expiry": contract.get("expiry"),
                "roll_basis": "highest_volume",
                "roll_basis_volume": int(volume),
            })
            if is_active:
                candidates_by_date.setdefault(day, []).append(enriched)
            else:
                # Only the NEAREST deferred month per day is ever needed as a next leg,
                # and every deferred expiry lies beyond every active one that day (active
                # = within YF_LIQUID_ACTIVE_DAYS_BEFORE_EXPIRY of expiry, deferred = past
                # it), so this row always sits after the front. Keeping one instead of the
                # whole far chain saves ~8k rows per market on monthly-expiry contracts.
                prev = deferred_by_date.get(day)
                if prev is None or _expiry_sort_value(enriched) < _expiry_sort_value(prev):
                    deferred_by_date[day] = enriched

        if found_tradable:
            active_contracts += 1
            empty_streak = 0
        else:
            empty_streak += 1
            # Only stop once we have already collected data AND hit a long run of
            # empty contracts. Candidates run oldest-first, so a block of missing
            # old expiries (no longer served by Yahoo) must NOT abort the newer
            # part of the chain. Use a generous threshold for that reason.
            if active_contracts and empty_streak >= YF_LIQUID_CONTINUOUS_EMPTY_STOP:
                break

    # Build the clean continuous fallback (dense, trades every day).
    fallback_by_date = {}
    for row in fallback_history or []:
        clean = _clean_contract_history_row(row)
        if clean:
            clean["source"] = "yfinance_continuous_fallback"
            fallback_by_date[clean["date"]] = clean

    # Calendar spread (front-next): front = the lead (highest-volume) contract, next =
    # the nearest expiry after it — see the helper. Computed whenever a lead month and a
    # following month exist.
    calendar_spread_series = build_calendar_spread_series(candidates_by_date, deferred_by_date)

    if is_index_proxy:
        # Price stays the cash/index proxy (raw fallback); no stitched continuous and
        # no summed-contract volume pane — only the calendar spread is added.
        return fallback_history or [], [], calendar_spread_series

    # Native Yahoo front-month continuous (=F) only. The manipulated volume-led
    # overlay was removed: Yahoo's front-month series is the reliable source, and
    # the stitched overlay was the cause of the spotty rolls. The individual
    # contracts are still fetched above for the volume pane and the calendar
    # spread below — just not used to stitch the price chart.
    history = [fallback_by_date[day] for day in sorted(fallback_by_date)]
    history = history[-YF_PRICE_HISTORY_MAX_POINTS:]
    history = _drop_spike_revert_outliers(history)

    contract_total_volume = _total_volume_rows_from_by_date(
        total_by_date,
        "summed_yfinance_single_contract_histories_for_volume_led_continuous",
    )
    # A summed single-contract volume series should never sit materially below
    # the generic continuous symbol's own volume. When Yahoo omits an active
    # expiry (CAD often misses the Sep/Mar contracts), the sum collapses into
    # tiny far-deferred prints. Merge against the original continuous history
    # so the volume pane stays dense and useful instead of showing false gaps.
    total_volume = _merge_volume_series(
        [],
        contract_total_volume,
        fallback_history=fallback_history,
    )
    return history, total_volume, calendar_spread_series


def build_continuous_contract(cfg, yf_symbol, history, total_volume_series=None):
    """Packs the main chart history cleanly into the data model."""
    root = cfg.get("yf_root") or ""
    chart_format = cfg.get("chart_format", "continuous_front_month")
    label = cfg.get("chart_label") or (f"{root}1! Continuous Contract" if root else "Continuous Contract")
    method = cfg.get("chart_method", "Yahoo Finance Continuous Front-Month Future")
    return {
        "format": chart_format,
        "label": label,
        "yf_symbol": yf_symbol,
        "tv_symbol": cfg.get("tv_symbol"),
        "risk_symbol": cfg.get("risk_symbol"),
        "risk_role": cfg.get("risk_role"),
        "source": "yfinance",
        "roll_method": method,
        "history": history or [],
        "total_volume_series": total_volume_series or [],
    }


def select_yfinance_contracts(cfg, count=6):
    """
    Selects the first `count` Yahoo contracts with real price data.
    Front-month symbols that are no longer listed are skipped quietly.
    """
    candidates = build_contract_candidates(cfg, count=max(YF_CONTRACT_LOOKAHEAD, count))
    selected = []
    skipped = []

    for c in candidates:
        data = _yf_client.quote(c["yf_symbol"], quiet=True)
        if data.get("available"):
            c.update(data)
            selected.append(c)
            if len(selected) >= count:
                break
        else:
            skipped.append(c)

    if len(selected) < count:
        for c in skipped:
            c.update(dict(BLANK))
            selected.append(c)
            if len(selected) >= count:
                break

    if skipped:
        print(f"   · Yahoo: {len(selected)}/{len(candidates)} contracts selected, {len(skipped)} missing/expired skipped")
    else:
        print(f"   ✓ Yahoo: {len(selected)}/{len(candidates)} contracts available")

    # Sort chronologically; backfilled empty months could otherwise be out of order.
    selected.sort(key=lambda c: (c.get("year", 0), c.get("month", 0)))
    return selected[:count]
