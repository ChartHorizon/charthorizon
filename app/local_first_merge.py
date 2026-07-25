"""Local-first merge/health: never-lose-history gatekeeping, volume/OI reconciliation.

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
    YF_TOTAL_VOLUME_LOOKAHEAD,
    YF_TOTAL_VOLUME_MAX_POINTS,
    YF_VOLUME_SUSPECT_LOOKBACK,
    YF_VOLUME_SUSPECT_MIN_REFERENCE,
    YF_VOLUME_SUSPECT_MIN_RUN,
    YF_VOLUME_SUSPECT_RATIO,
    YF_VOLUME_SUSPECT_RECENT_DAYS,
)
from series_utils import _median
from contracts import build_contract_candidates, build_total_volume_contract_candidates

__all__ = [
    '_OI_SOURCE_PRIORITY',
    '_VOLUME_SOURCE_PRIORITY',
    '_cached_contract_volume_series',
    '_choose_fresh_or_previous_contracts',
    '_choose_fresh_or_previous_series',
    '_history_looks_worse',
    '_is_yfinance_volume_source',
    '_load_existing_market_payloads',
    '_mark_suspect_yfinance_volume_holes',
    '_merge_oi_series',
    '_merge_volume_series',
    '_oi_series_from_cot',
    '_safe_cache_token',
    '_series_dates',
    '_series_health',
    '_slug',
    '_volume_series_from_history',
]



def _volume_series_from_history(history, source, method, contract_count=None):
    rows = []
    for entry in history or []:
        day = str(entry.get("date") or "")[:10]
        volume = entry.get("volume")
        if not day or volume is None:
            continue
        try:
            volume_int = int(volume)
        except (TypeError, ValueError):
            continue
        if volume_int <= 0:
            continue
        row = {
            "date": day,
            "volume": volume_int,
            "source": source,
            "method": method,
        }
        if contract_count is not None:
            row["contract_count"] = contract_count
        rows.append(row)
    return rows


# ─────────────────────────────────────────────────────────────────────
#  HTML GENERATION  (sidebar index + category JSON, lazy loaded)
# ─────────────────────────────────────────────────────────────────────
def _slug(category):
    """Converts 'Livestock/Dairy' -> 'livestock_dairy' (file name)."""
    return (category.lower()
            .replace(" ", "_").replace("&", "and")
            .replace("/", "_").replace("\\", "_"))


def _load_existing_market_payloads(data_dir):
    existing = {}
    if not os.path.isdir(data_dir):
        return existing
    for name in os.listdir(data_dir):
        if not (name.startswith("data_") and name.endswith(".json")) or name == "data_quality.json":
            continue
        path = os.path.join(data_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            if isinstance(payload, dict):
                existing.update(payload)
        except Exception:
            continue
    return existing


def _series_dates(rows):
    dates = []
    for row in rows or []:
        try:
            day = date.fromisoformat(str(row.get("date") or "")[:10])
        except (TypeError, ValueError):
            continue
        dates.append(day)
    return sorted(set(dates))


def _series_health(rows, *, kind="generic"):
    dates = _series_dates(rows)
    if not dates:
        return {
            "status": "missing",
            "points": 0,
            "years": 0,
            "start": None,
            "end": None,
            "max_gap_days": None,
        }

    max_gap = 0
    for prev, cur in zip(dates, dates[1:]):
        max_gap = max(max_gap, (cur - prev).days)
    years = len({d.year for d in dates})
    # Count UNIQUE dates, not raw rows: a fresh fetch padded with duplicate-date rows
    # must not pass the "materially shorter" gate while actually covering fewer days.
    points = len(dates)

    status = "ok"
    if kind == "price" and (points < 900 or years < 4):
        status = "limited_history"
    elif kind == "seasonal" and years < 15:
        status = "limited_history"
    elif kind == "volume" and points < 180:
        status = "limited_history"
    if max_gap and max_gap > 21 and kind in {"price", "volume"}:
        status = "gappy"

    return {
        "status": status,
        "points": points,
        "years": years,
        "start": dates[0].isoformat(),
        "end": dates[-1].isoformat(),
        "max_gap_days": max_gap,
    }


def _history_looks_worse(fresh_rows, previous_rows, *, kind):
    """Rejects fresh API data when it would degrade a good local EoD history."""
    fresh = _series_health(fresh_rows, kind=kind)
    previous = _series_health(previous_rows, kind=kind)
    if previous["points"] <= 0:
        return False, fresh, previous, "no_previous_history"
    if fresh["points"] <= 0:
        return True, fresh, previous, "fresh_history_missing"

    try:
        fresh_end = date.fromisoformat(fresh["end"])
        previous_end = date.fromisoformat(previous["end"])
    except (TypeError, ValueError):
        fresh_end = previous_end = None

    if fresh_end and previous_end and fresh_end < previous_end - timedelta(days=7):
        return True, fresh, previous, "fresh_history_older_than_local_store"

    min_ratio = 0.90 if kind == "seasonal" else 0.75
    if fresh["points"] < previous["points"] * min_ratio:
        return True, fresh, previous, "fresh_history_materially_shorter"

    if kind == "seasonal" and fresh["years"] + 2 < previous["years"]:
        return True, fresh, previous, "fresh_seasonal_years_materially_shorter"

    fresh_gap = fresh.get("max_gap_days") or 0
    previous_gap = previous.get("max_gap_days") or 0
    if kind in {"price", "volume"} and fresh_gap > 21 and (not previous_gap or previous_gap <= 14):
        return True, fresh, previous, "fresh_history_has_large_gaps"

    return False, fresh, previous, "fresh_history_accepted"


def _choose_fresh_or_previous_series(fresh_rows, previous_rows, *, kind):
    use_previous, fresh_health, previous_health, reason = _history_looks_worse(
        fresh_rows,
        previous_rows,
        kind=kind,
    )
    return {
        "series": list(previous_rows or []) if use_previous else list(fresh_rows or []),
        "used": "previous_local_store" if use_previous else "fresh_api",
        "reason": reason,
        "fresh": fresh_health,
        "previous": previous_health,
    }


def _choose_fresh_or_previous_contracts(fresh_contracts, previous_contracts):
    """Per-contract local-first merge: when a fresh Yahoo quote failed for a
    contract (available=False), reuse that same yf_symbol's last known-good
    quote (last/change/volume/open_interest) from the previous refresh instead
    of leaving it null. Mirrors _choose_fresh_or_previous_series, which already
    protects price/seasonal history the same way — a transient/partial yfinance
    outage must not wipe contract volume, which frontContractIndex() (chart.js)
    needs to keep the FRONT-month pick on the actively-traded contract instead
    of falling back to the nearest-by-calendar contract.
    """
    previous_by_symbol = {
        c.get("yf_symbol"): c for c in (previous_contracts or []) if c.get("yf_symbol")
    }
    merged = []
    for c in fresh_contracts or []:
        if c.get("available") or not c.get("yf_symbol"):
            merged.append(c)
            continue
        prev = previous_by_symbol.get(c["yf_symbol"])
        if not prev or not prev.get("available"):
            merged.append(c)
            continue
        out = dict(c)
        for field in ("last", "change", "change_pct", "volume", "open_interest", "available"):
            out[field] = prev.get(field)
        out["source"] = "previous_local_store"
        merged.append(out)
    return merged


def _oi_series_from_cot(cot_series):
    """Builds a weekly OI base series from the CFTC COT data (field `oi`).

    CFTC reports total open interest every week (Tuesdays), going back years.
    This is the only Open Interest source used for the launch build.
    """
    rows = []
    for entry in cot_series or []:
        day = str(entry.get("date") or "")[:10]
        oi = entry.get("oi")
        if not day or oi is None:
            continue
        try:
            oi_int = int(oi)
        except (TypeError, ValueError):
            continue
        if oi_int <= 0:
            continue
        rows.append({
            "date": day,
            "oi": oi_int,
            "source": "cftc_cot",
            "method": "weekly_total_open_interest_from_cftc_cot",
        })
    return rows


# Higher number = higher priority when two sources report the same date.
_OI_SOURCE_PRIORITY = {"cftc_cot": 1}


def _merge_oi_series(existing_series, snapshot, cot_series=None, max_points=1300):
    """Merges OI points from several sources into one clean, sorted daily series.

    Inputs are considered low -> high priority on a date collision (later wins on an
    equal-rank tie), so a fresh CFTC value REVISES a previously stored date instead of
    being silently kept stale:
      - the previously stored CFTC series (oldest baseline)
      - weekly COT history from this run (revisions + new weeks)
      - the live snapshot (highest)
    Dates present only in the stored series are never dropped (no collision), so the
    never-lose-history invariant still holds.
    """
    by_date = {}

    def consider(row):
        if not row:
            return
        day = str(row.get("date") or "")[:10]
        value = row.get("oi")
        if not day or value is None:
            return
        try:
            if int(value) <= 0:
                return
        except (TypeError, ValueError):
            return
        prev = by_date.get(day)
        if prev is None:
            by_date[day] = row
            return
        # On a date collision keep the higher-priority source.
        new_rank = _OI_SOURCE_PRIORITY.get(row.get("source"), 0)
        old_rank = _OI_SOURCE_PRIORITY.get(prev.get("source"), 0)
        if new_rank >= old_rank:
            by_date[day] = row

    for row in existing_series or []:
        consider(row)
    for row in _oi_series_from_cot(cot_series):
        consider(row)
    consider(snapshot)

    merged = [by_date[key] for key in sorted(by_date)]
    return merged[-max_points:]


_VOLUME_SOURCE_PRIORITY = {
    "yfinance_continuous_volume": 1,
    "yfinance_contract_sum": 2,
}


def _is_yfinance_volume_source(source):
    return source in _VOLUME_SOURCE_PRIORITY


def _mark_suspect_yfinance_volume_holes(series):
    """
    Flags long runs where yfinance volume collapses far below the recent norm.

    We deliberately do not fill these gaps with synthetic values. The chart can
    omit marked rows so obvious missing-volume stretches do not distort scaling,
    while the raw value remains stored for auditability.
    """
    rows = [dict(row) for row in series or []]
    latest_day = None
    for row in rows:
        try:
            row_day = date.fromisoformat(str(row.get("date") or "")[:10])
        except (TypeError, ValueError):
            continue
        latest_day = row_day if latest_day is None or row_day > latest_day else latest_day
    recent_cutoff = (
        latest_day - timedelta(days=YF_VOLUME_SUSPECT_RECENT_DAYS)
        if latest_day is not None
        else None
    )
    tagged = []
    reference = []

    for row in rows:
        clean = dict(row)
        try:
            volume_int = int(clean.get("volume"))
        except (TypeError, ValueError):
            tagged.append((clean, False))
            continue

        try:
            row_day = date.fromisoformat(str(clean.get("date") or "")[:10])
        except (TypeError, ValueError):
            row_day = None
        within_recent = recent_cutoff is not None and row_day is not None and row_day >= recent_cutoff
        ref = _median(reference[-YF_VOLUME_SUSPECT_LOOKBACK:])
        suspect = (
            within_recent
            and
            ref is not None
            and ref >= YF_VOLUME_SUSPECT_MIN_REFERENCE
            and 0 < volume_int < ref * YF_VOLUME_SUSPECT_RATIO
        )
        tagged.append((clean, suspect))
        if not suspect and volume_int >= YF_VOLUME_SUSPECT_MIN_REFERENCE:
            reference.append(volume_int)

    out = []
    i = 0
    while i < len(tagged):
        row, suspect = tagged[i]
        if not suspect:
            out.append(row)
            i += 1
            continue

        j = i
        while j < len(tagged) and tagged[j][1]:
            j += 1
        run_len = j - i
        for k in range(i, j):
            clean = tagged[k][0]
            if run_len >= YF_VOLUME_SUSPECT_MIN_RUN:
                clean = dict(clean)
                clean["raw_volume"] = clean.get("volume")
                clean["source"] = "yfinance_volume_suspect_low"
                clean["method"] = "suspect_missing_active_contract_volume"
                clean["suspect"] = True
            out.append(clean)
        i = j

    return out


def _merge_volume_series(
    existing_series,
    fresh_series,
    fallback_history=None,
    max_points=YF_TOTAL_VOLUME_MAX_POINTS,
):
    by_date = {}

    def consider(row):
        if not row:
            return
        day = str(row.get("date") or "")[:10]
        value = row.get("volume")
        if not day or value is None:
            return
        try:
            volume_int = int(value)
        except (TypeError, ValueError):
            return
        if volume_int <= 0:
            return
        clean = dict(row)
        clean["date"] = day
        clean["volume"] = volume_int
        prev = by_date.get(day)
        if prev is None:
            by_date[day] = clean
            return
        # For yfinance volume, the summed contract series should never be
        # materially lower than front-month/continuous volume. If it is lower,
        # it usually means we summed far-deferred contracts for an old date.
        # Keep the larger yfinance value so old 12M windows do not look empty.
        if _is_yfinance_volume_source(clean.get("source")) and _is_yfinance_volume_source(prev.get("source")):
            if clean["volume"] >= prev["volume"]:
                by_date[day] = clean
            return
        new_rank = _VOLUME_SOURCE_PRIORITY.get(clean.get("source"), 0)
        old_rank = _VOLUME_SOURCE_PRIORITY.get(prev.get("source"), 0)
        if new_rank >= old_rank:
            by_date[day] = clean

    for row in _volume_series_from_history(
        fallback_history or [],
        "yfinance_continuous_volume",
        "continuous_contract_volume_fallback",
        contract_count=1,
    ):
        consider(row)
    for row in existing_series or []:
        if row.get("estimated") or row.get("source") in {"yfinance_volume_gap_fill", "yfinance_volume_suspect_low"}:
            continue
        consider(row)
    for row in fresh_series or []:
        consider(row)

    merged = [by_date[key] for key in sorted(by_date)]
    merged = merged[-max_points:]
    return _mark_suspect_yfinance_volume_holes(merged)


def _safe_cache_token(value):
    return re.sub(r"[^A-Za-z0-9_.=-]+", "_", str(value or ""))


def _cached_contract_volume_series(data_dir, cfg, period="5y"):
    """Uses lazy single-contract cache files, when present, to improve local total volume immediately."""
    cache_dir = os.path.join(data_dir, "contract_history")
    if not os.path.isdir(cache_dir) or cfg.get("chart_format") == "dxy_index_proxy":
        return []

    by_date = {}
    candidates = build_total_volume_contract_candidates(cfg)
    if not candidates:
        candidates = build_contract_candidates(cfg, count=YF_TOTAL_VOLUME_LOOKAHEAD)
    for contract in candidates:
        symbol = contract.get("yf_symbol")
        if not symbol:
            continue
        path = os.path.join(cache_dir, f"{_safe_cache_token(symbol)}_{_safe_cache_token(period)}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            continue
        rows = payload.get("history") if isinstance(payload, dict) else None
        for row in rows or []:
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

    out = []
    for day in sorted(by_date):
        item = by_date[day]
        out.append({
            "date": day,
            "volume": int(item["volume"]),
            "source": "yfinance_contract_sum",
            "method": "cached_summed_yfinance_single_contract_histories",
            "contract_count": len(item["symbols"]),
        })
    return out[-YF_TOTAL_VOLUME_MAX_POINTS:]
