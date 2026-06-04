"""yfinance data: OHLCV/contracts/volume/seasonal fetch, calendar spread, continuous.

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
    SPREAD_MAX_GAP_DAYS,
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
    '_drop_spike_revert_outliers',
    '_drop_spread_spike_reverts',
    '_existing_seasonal_years',
    '_expiry_sort_value',
    '_history_row_looks_tradable',
    '_should_refresh_seasonal',
    '_total_volume_rows_from_by_date',
    '_trailing_contiguous_spread',
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

        if quiet:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                hist = ticker.history(period=period, interval=interval)
        else:
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


_yf_client = YahooFinanceClient()


def fetch_chart_history(yf_continuous, period="5y"):
    """
    Fetches daily OHLC + volume history for a yfinance chart symbol.
    Five years of daily data -> Weekly/Daily and all ranges can be derived client-side.

    Returns: list of {date, open, high, low, close, volume}
    """
    return _yf_client.chart_history(yf_continuous, period=period)


def fetch_price_chart_history(cfg, period="5y"):
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


def build_calendar_spread_series(candidates_by_date):
    """Front-minus-next calendar spread per day (negative = contango).

    Front = the nearest active expiry that day with a valid close; next = the
    next-nearest expiry with a valid close. Spread = front_close - next_close.

    The spread is computed for EVERY day on which both the current front month and
    the following month exist — liquidity is deliberately NOT gated. Thinly-traded
    deferred months on Yahoo (BTC monthly, USD Index) otherwise either stranded the
    old volume-led roll selector on an illiquid far contract or were dropped by a
    volume-ratio gate, leaving the current spread missing. Selecting strictly by
    expiry also removes the roll flip/flop chatter the forward ratchet guarded against.
    Real settled closes only (no synthetic fill); a spike-revert pass drops single bad
    prints and a trailing-contiguity pass keeps the most recent gap-free run.
    """
    rows = []
    for day in sorted(candidates_by_date):
        legs = sorted((r for r in candidates_by_date[day] if r.get("close") is not None),
                      key=_expiry_sort_value)
        if len(legs) < 2:
            continue
        front = legs[0]
        front_exp = _expiry_sort_value(front)
        nxt = next((r for r in legs[1:] if _expiry_sort_value(r) > front_exp), None)
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
    # Only the most recent contiguous block: the currently-traded contracts. Older
    # dates were measured with what is now a deferred contract and come out gappy.
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
            if not _contract_is_active_for_day(contract, day):
                continue

            found_tradable = True
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
            candidates_by_date.setdefault(day, []).append(enriched)

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

    # Calendar spread (front-next), selected strictly by nearest expiry — see the
    # helper. Computed whenever the current front month and the following month exist.
    calendar_spread_series = build_calendar_spread_series(candidates_by_date)

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
    history = history[-YF_TOTAL_VOLUME_MAX_POINTS:]
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
