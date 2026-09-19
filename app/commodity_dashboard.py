#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  COMMODITY FUTURES DASHBOARD GENERATOR
═══════════════════════════════════════════════════════════════════════
  Builds a standalone, responsive HTML file with:
    - custom candlestick chart including CFTC COT + Open Interest
    - futures curve table for the next six contract months
    - dropdowns/tabs for switching between markets

  Data sources (all free):
    - yfinance            -> prices, contracts and chart history
    - CFTC Public API     -> COT + Open Interest

  Add a new market by extending COMMODITIES.
═══════════════════════════════════════════════════════════════════════
"""

import os
import sys
# `time` is datetime.time in this module (see the datetime import below), so the
# clock has to come in under a name of its own.
import time as wallclock
import csv
import contextlib
import io
import json
import tempfile
import re
import threading
import concurrent.futures
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

# ─────────────────────────────────────────────────────────────────────
#  This file is now a thin orchestrator. The data-generation building
#  blocks were split into focused modules (see CLAUDE.md). They are
#  re-exported here so `import commodity_dashboard as cd` keeps exposing
#  the full namespace (the content_bot relies on cd.<helper>), and so
#  this file stays runnable as a script (python3 commodity_dashboard.py).
# ─────────────────────────────────────────────────────────────────────
from market_config import *  # noqa: F401,F403
from series_utils import *  # noqa: F401,F403
from fetch_cftc import *  # noqa: F401,F403
from calendar_utils import *  # noqa: F401,F403
from contracts import *  # noqa: F401,F403
from local_first_merge import *  # noqa: F401,F403
from fetch_yfinance import *  # noqa: F401,F403
from screener import *  # noqa: F401,F403
import fx_rates
import fetch_yfinance

import yahoo_gateway
from market_config import YF_GATEWAY_CAPACITY, YF_GATEWAY_REFILL_PER_SEC


def _build_generator_session():
    """Browser-impersonating session for the generator, mirroring start.py's live one."""
    if curl_requests is None:
        return None
    try:
        return curl_requests.Session(impersonate="chrome")
    except Exception:
        return None


# The generator profile. Must be installed before fetch_yfinance issues its first
# request, so this sits at import time, not inside gather_commodity_data(). Deliberately
# omits lock_path: the generator is the process that HOLDS ff_data/refresh.lock, so
# giving it lock_path would make it stand itself down and fetch nothing.
yahoo_gateway.configure(
    capacity=YF_GATEWAY_CAPACITY,
    refill_per_sec=YF_GATEWAY_REFILL_PER_SEC,
    session_factory=_build_generator_session,
)


# Background-refresh progress (read by start.py's /api/refresh-status). cwd is the
# data root when the generator runs, so this resolves to <data_root>/ff_data/.
PROGRESS_FILE = os.path.join("ff_data", "refresh_progress.json")


_REPLACE_RETRIES = 10          # ~2.5 s total; a served file is let go long before that
_REPLACE_RETRY_SLEEP = 0.25
_WIN_SHARING_ERRORS = (5, 32)  # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION


def _replace_with_retry(tmp, path):
    """os.replace(tmp, path), retried while Windows says the target is in use.

    POSIX renames over an open file without a word. Windows does not: MoveFileEx has to
    open the destination for DELETE, and CPython's open() shares read and write but never
    delete — so replacing a file another process is reading fails outright with
    ERROR_SHARING_VIOLATION. The other process here is our own web server: http.server
    holds a file open for the whole response, and boot.js pulls all ~57 MB of category
    JSON through it *while a refresh runs* (start.py kicks one on every warm start).

    Uncaught, that surfaced as a refresh dying partway with a PermissionError traceback,
    having written some category files and not others and no new config.js at all — the
    half-updated state the atomic write exists to prevent, reached by a different road.
    The window is one response long, so a short retry closes it.

    Only the two sharing errors are retried; anything else (a full disk, a read-only
    folder) is raised on the first attempt, as before.
    """
    for attempt in range(_REPLACE_RETRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:
            last = attempt == _REPLACE_RETRIES - 1
            if last or not sys.platform.startswith("win"):
                raise
            if getattr(exc, "winerror", None) not in _WIN_SHARING_ERRORS:
                raise
            wallclock.sleep(_REPLACE_RETRY_SLEEP)


def _sweep_stale_temp_files(directory, max_age=3600):
    """Delete orphaned .tmp_*.part files left behind by a hard-killed refresh.

    _write_atomic unlinks its own temp on any exception, but a TerminateProcess (the
    closed console window on Windows, a reboot, a power cut) runs no handler — and the
    category payloads are 6-14 MB each, so the leftovers are not small. Nothing ever
    collected them.

    The age guard means a temp belonging to a live writer is never touched: the refresh
    lock already makes a second writer unlikely, this makes it harmless.
    """
    try:
        names = os.listdir(directory)
    except OSError:
        return                # no data dir yet: nothing to sweep
    now = wallclock.time()
    for name in names:
        if not (name.startswith(".tmp_") and name.endswith(".part")):
            continue
        victim = os.path.join(directory, name)
        try:
            if now - os.path.getmtime(victim) > max_age:
                os.unlink(victim)
        except OSError:
            pass              # gone already, or held open — either way not ours to force


def _write_atomic(path, write_body):
    """Write a file through a temp file + os.replace, so an interrupted refresh can
    never leave half of one behind.

    `open(path, "w")` truncates the moment it is called, so every payload the generator
    writes — the category JSONs are 6-14 MB each and take seconds — spent that whole
    window as a partial file on disk. A kill in it (a closed console window, a reboot,
    an out-of-memory browser taking the machine with it) left a truncated file that the
    frontend could not parse; for config.js that meant a dashboard that could not boot
    at all. The fsync is the other half: on NTFS, os.replace alone can still surface a
    zero-length file after a power loss.

    `write_body` receives the open text handle. Raises whatever it raises — but leaves
    the previous file, and no temp, behind."""
    directory = os.path.dirname(path) or "."
    # mkstemp creates 0600. These payloads were 0644 when they were written in place,
    # and the chartbot reads them, so carry the mode over rather than silently narrowing it.
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp_", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            write_body(f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        _replace_with_retry(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_three_three_log(path):
    """The 3/3 period log as it stands on disk, or {} when it is absent or unreadable.

    It is MERGED into rather than rebuilt (see screener.merge_three_three_periods): the
    reconstruction reaches only as far back as a market's calendar-spread series, which is
    trimmed on every refresh, so anything older lives on in this file alone. It is also
    rewritten on every refresh, which puts it in the same crash window as every other
    payload here — a truncated log must degrade to "no history" and let the refresh
    rebuild what it can, never take the refresh down with it."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            log = json.load(f)
    except (OSError, ValueError):
        return {}
    return log if isinstance(log, dict) else {}


def _write_refresh_progress(**fields):
    """Best-effort: merge fields into ff_data/refresh_progress.json (atomic write).
    Never raises — progress reporting must never break a refresh."""
    try:
        os.makedirs("ff_data", exist_ok=True)
        data = {}
        if os.path.exists(PROGRESS_FILE):
            try:
                with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}
        data.update(fields)
        fd, tmp = tempfile.mkstemp(dir="ff_data", prefix=".progress_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, PROGRESS_FILE)
        except Exception:
            # os.replace failed after the temp was written — don't leak the orphan.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        pass


def _gather_one_market(key, cfg, cot_all, count):
    """Fetch one market's yfinance data. Self-contained so it can run on a worker thread."""
    cfg["_key"] = key  # lets build_contract_list find the spec/expiry rule
    print(f"→ {cfg['display_name']}")
    contracts = select_yfinance_contracts(cfg, count=count)
    chart_symbol, chart_history = fetch_price_chart_history(cfg)
    if _should_refresh_seasonal(key):
        seasonal_history = fetch_seasonal_price_history(cfg, chart_history)
    else:
        seasonal_history = []  # reuse the cached seasonal history (refreshed yearly)
    chart_history, total_volume_series, calendar_spread_series = fetch_yfinance_liquid_continuous_history(
        cfg, fallback_history=chart_history)
    continuous_contract = build_continuous_contract(
        cfg, chart_symbol, chart_history, total_volume_series=total_volume_series)
    continuous_contract["seasonal_history"] = seasonal_history
    # Which contract each trailing bar of the native =F series settled on: the live overlay's
    # source for this series. Private — generate_html turns it into `settled_contract` for the
    # bar the written series actually ends on. A failure costs this market its live candle on
    # the continuous chart, never the refresh.
    try:
        continuous_contract["_settled_by_date"] = resolve_settled_contracts(
            cfg, chart_history, contracts)
    except Exception as exc:
        print(f"   ⚠  {cfg['display_name']}: settled contract not resolved ({exc})")
    cot_series = cot_all.get(cfg.get("cftc_code"), [])
    return key, {
        "config": cfg,
        "contracts": contracts,
        "continuous_contract": continuous_contract,
        "daily_oi_snapshot": None,
        "cot_series": cot_series,
        "calendar_spread_series": calendar_spread_series,
    }


def gather_commodity_data(count=6):
    """
    Collects yfinance contracts, continuous charts and CFTC data for each market.
    """
    fetch_yfinance.load_dead_memo()
    print("   Data sources: yfinance (OHLCV/prices/charts/contracts) · CFTC (weekly OI + COT)")

    # CFTC publishes COT weekly at 15:30 ET (holiday delays possible). Only fetch
    # after the release window and only if the stored Tuesday report date is old.
    cot_status = _cot_refresh_status()
    if cot_status["should_refresh"]:
        rel = cot_status.get("release_date")
        rpt = cot_status.get("report_date")
        suffix = f" (release {rel}, report date {rpt})" if rel and rpt else f" ({cot_status['reason']})"
        print(f"-> Loading CFTC COT report{suffix}...")
        cot_all = fetch_cftc_cot()
    else:
        nxt = cot_status.get("next_release")
        next_msg = f"; next release {nxt} after 15:30 ET" if nxt else ""
        print(f"-> CFTC COT report: reusing stored data ({cot_status['reason']}{next_msg})")
        cot_all = _stored_cot_series_by_code()
        if not cot_all:  # safety net: nothing stored after all -> fetch
            print("   · no stored COT found, fetching instead")
            cot_all = fetch_cftc_cot()
    print()

    dataset = {}
    _total = len(COMMODITIES)
    _write_refresh_progress(state="running", total=_total, done=0, current=None, category=None)
    items = list(COMMODITIES.items())
    workers = max(1, int(REFRESH_FETCH_WORKERS))

    # Prime the lazy seasonal-year cache single-threaded so the parallel workers below
    # don't race its first-touch population (fetch_yfinance._existing_seasonal_years).
    if items:
        _should_refresh_seasonal(items[0][0])

    if workers <= 1:
        _done = 0
        for key, cfg in items:
            _write_refresh_progress(done=_done, current=cfg.get("display_name", key),
                                    category=cfg.get("category", ""))
            _done += 1
            k, entry = _gather_one_market(key, cfg, cot_all, count)
            dataset[k] = entry
    else:
        _progress_lock = threading.Lock()
        _done = {"n": 0}

        def _task(item):
            key, cfg = item
            with _progress_lock:
                _write_refresh_progress(done=_done["n"], current=cfg.get("display_name", key),
                                        category=cfg.get("category", ""))
            k, entry = _gather_one_market(key, cfg, cot_all, count)
            with _progress_lock:
                _done["n"] += 1
                _write_refresh_progress(done=_done["n"], current=None, category=None)
            return k, entry

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            for k, entry in ex.map(_task, items):
                dataset[k] = entry

    _write_refresh_progress(done=_total, current=None, category=None)
    fetch_yfinance.save_dead_memo()
    return dataset


def _previous_fx_rates(config_path):
    """Read the fxRates block from an existing ff_data/config.js, or None.

    Used as the fallback when the BIS fetch fails, so a daily refresh keeps the
    last-known rates instead of dropping back to the forex.js built-in default.
    """
    try:
        with open(config_path, encoding="utf-8") as f:
            raw = f.read().strip()
        raw = raw[raw.index("{"):raw.rindex("}") + 1]
        return json.loads(raw).get("fxRates") or None
    except Exception:
        return None


def _data_as_of_label(board_settled, dataset):
    """The date `config.js` says the data is "as of" (`genDate`, echoed as `latest_eod`).

    It used to be `date.today()`: the LOCAL calendar day the run finished, which is not a
    date of the data at all. A refresh that ended after midnight in Europe labelled Friday's
    session "Sep 12", a Saturday, in Settings and on every FX card. It is the board's settled
    session now, or without a board vote the newest bar actually written. The format is
    unchanged, so nothing that reads it has to change.
    """
    day = board_settled
    if day is None:
        for entry in (dataset or {}).values():
            history = (entry.get("continuous_contract") or {}).get("history") or []
            if not history:
                continue
            try:
                last = date.fromisoformat(str(history[-1].get("date") or "")[:10])
            except ValueError:
                continue
            if day is None or last > day:
                day = last
    return (day or date.today()).strftime("%b %d, %Y")


def generate_html(dataset, out_path="commodity_dashboard.html", data_dir="ff_data"):
    """
    Generates:
      - one lightweight HTML file (sidebar structure only, no heavy data JSON)
      - one JSON file per category (ff_data/data_<category>.json)
    The HTML loads category data lazily via fetch().
    """
    os.makedirs(data_dir, exist_ok=True)
    _sweep_stale_temp_files(data_dir)
    existing_payloads = _load_existing_market_payloads(data_dir)

    # Board-wide settled EoD: the latest session the verifiable (full-volume) markets
    # agree on. Illiquid markets are capped to it below, so no market can keep a
    # pre-settle bar the liquid board has already rejected (data rule: settled EoD only).
    board_settled = _board_settled_eod_date(dataset)
    if board_settled is not None:
        print(f"   · board-wide settled EoD: {board_settled.isoformat()} (illiquid markets capped to this)")

    # 1) Lightweight index: metadata only per market (for the sidebar)
    index = {}   # key -> {display_name, category, slug}
    by_cat = {}  # category -> { key -> full_payload }
    quality_index = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "policy": "Fresh API data is rejected when it would materially shorten, age, or gap a healthier local EoD history.",
        "markets": {},
    }

    for key, entry in dataset.items():
        cfg = entry["config"]
        cat = cfg["category"]
        index[key] = {
            "display_name": cfg["display_name"],
            "category": cat,
            "slug": _slug(cat),
        }
        spec = dict(CONTRACT_SPECS.get(key, {}))
        for private_key in SPEC_PRIVATE_KEYS:
            spec.pop(private_key, None)
        previous_payload = existing_payloads.get(key, {})
        contracts = _choose_fresh_or_previous_contracts(
            entry["contracts"], previous_payload.get("contracts"))
        reused_contracts = sum(1 for c in contracts if c.get("source") == "previous_local_store")
        if reused_contracts:
            plural = "s" if reused_contracts != 1 else ""
            print(f"   · {cfg['display_name']}: {reused_contracts} contract quote{plural} "
                  f"reused from previous refresh (fresh Yahoo quote unavailable)")
        existing_series = [
            row for row in (previous_payload.get("daily_oi_series") or [])
            if row.get("source") == "cftc_cot"
        ]
        daily_oi_series = _merge_oi_series(
            existing_series,
            None,
            cot_series=entry.get("cot_series", []),
        )
        # No accumulation: the spread is just the current contiguous block (the
        # currently-traded contracts), recomputed fresh each refresh — this avoids
        # the gappy backfill that older accumulation produced. Recomputed-from-scratch
        # is NOT the same as "an empty recomputation is the answer", though: the local
        # store stands in when the fresh pass reaches no further than it does (see
        # _choose_fresh_or_previous_spread), so a throttled night can no longer blank
        # the pane — in the JSON or, via purge_calendar_spread, in the archive.
        calendar_spread_series = _choose_fresh_or_previous_spread(
            _cap_series_to_date(entry.get("calendar_spread_series") or [], board_settled),
            previous_payload.get("calendar_spread_series"),
        )
        if calendar_spread_series and calendar_spread_series[0].get("source") == "previous_local_store":
            print(f"   · {cfg['display_name']}: calendar spread reused from previous refresh "
                  f"(fresh scan reached no further)")
        # COT: keep the fresh series, but fall back to the previously stored COT
        # when the fresh fetch is empty (mirrors the OI handling above), so a
        # blank/partial CFTC response never wipes a market's COT from the JSON.
        cot_series = entry.get("cot_series") or previous_payload.get("cot_series") or []
        fresh_continuous = dict(entry.get("continuous_contract", {}))
        continuous = dict(fresh_continuous)
        previous_continuous = previous_payload.get("continuous_contract", {})

        price_choice = _choose_fresh_or_previous_series(
            fresh_continuous.get("history") or [],
            previous_continuous.get("history") or [],
            kind="price",
        )
        if price_choice["used"] == "previous_local_store":
            for field in (
                "format", "label", "yf_symbol", "tv_symbol", "risk_symbol",
                "risk_role", "source", "roll_method",
            ):
                if field in previous_continuous:
                    continuous[field] = previous_continuous[field]
        # Settled-EoD guarantee (single chokepoint): whether we kept the fresh fetch or
        # fell back to the local store, the written history must never end on a pre-settle
        # bar. This also strips a stale partial tail left by an earlier pre-settle refresh.
        # The board cap then enforces the same settled date across illiquid markets too.
        continuous["history"] = _cap_series_to_date(
            _drop_unsettled_tail(price_choice["series"]), board_settled)
        # The contract the written series' last bar settled on — what the live overlay splices
        # today's candle from (see resolve_settled_contracts). Looked up by the day the series
        # ends on, never carried over to another day.
        settled_contract = _settled_contract_for_history(
            continuous["history"], continuous.pop("_settled_by_date", None),
            previous_continuous.get("settled_contract"))
        if settled_contract:
            continuous["settled_contract"] = settled_contract

        fresh_seasonal_history = list(fresh_continuous.get("seasonal_history") or [])
        previous_seasonal_history = list(previous_continuous.get("seasonal_history") or [])
        if fresh_seasonal_history:
            seasonal_choice = _choose_fresh_or_previous_series(
                fresh_seasonal_history,
                previous_seasonal_history,
                kind="seasonal",
            )
            continuous["seasonal_history"] = seasonal_choice["series"]
        elif previous_seasonal_history:
            seasonal_choice = {
                "series": previous_seasonal_history,
                "used": "previous_local_store",
                "reason": "yearly_refresh_not_due",
                "fresh": _series_health([], kind="seasonal"),
                "previous": _series_health(previous_seasonal_history, kind="seasonal"),
            }
            continuous["seasonal_history"] = previous_seasonal_history
        else:
            fallback_seasonal = continuous.get("history") or []
            seasonal_choice = {
                "series": fallback_seasonal,
                "used": "price_history_fallback",
                "reason": "no_dedicated_seasonal_history_available",
                "fresh": _series_health(fallback_seasonal, kind="seasonal"),
                "previous": _series_health([], kind="seasonal"),
            }
            continuous["seasonal_history"] = fallback_seasonal

        if not continuous.get("seasonal_history"):
            continuous["seasonal_history"] = (
                previous_continuous.get("seasonal_history")
                or continuous.get("history")
                or []
            )
        # Mark the bars where the native =F switched contract, so every seasonal curve — screener,
        # 3/3 log, Seasonals tab, content bot — takes the same roll gaps out (mark_seasonal_roll_days).
        # Recomputed on every refresh, since the history itself is re-fetched once a year. Copies:
        # the price history this may fall back to is never touched. A failure leaves the history
        # unmarked, i.e. raw closes as before — never a lost refresh.
        try:
            continuous["seasonal_history"] = mark_seasonal_roll_days(
                key, cfg, continuous.get("seasonal_history") or [])
        except Exception as exc:
            print(f"   ⚠  {cfg['display_name']}: seasonal roll days not marked ({exc})")
        existing_volume_series = previous_continuous.get("total_volume_series") or []
        fresh_volume_series = list(fresh_continuous.get("total_volume_series") or [])
        fresh_volume_series.extend(_cached_contract_volume_series(data_dir, cfg))
        continuous["total_volume_series"] = _cap_series_to_date(
            _merge_volume_series(
                existing_volume_series,
                fresh_volume_series,
                fallback_history=continuous.get("history", []),
            ),
            board_settled,
        )
        quality_report = {
            "display_name": cfg["display_name"],
            "category": cat,
            "price": {
                "used": price_choice["used"],
                "reason": price_choice["reason"],
                "health": _series_health(continuous.get("history", []), kind="price"),
                "fresh": price_choice["fresh"],
                "previous": price_choice["previous"],
            },
            "seasonal": {
                "used": seasonal_choice["used"],
                "reason": seasonal_choice["reason"],
                "health": _series_health(continuous.get("seasonal_history", []), kind="seasonal"),
                "fresh": seasonal_choice["fresh"],
                "previous": seasonal_choice["previous"],
                "has_5y": _series_health(continuous.get("seasonal_history", []), kind="seasonal")["years"] >= 5,
                "has_15y": _series_health(continuous.get("seasonal_history", []), kind="seasonal")["years"] >= 15,
                "has_40y": _series_health(continuous.get("seasonal_history", []), kind="seasonal")["years"] >= 40,
                "roll_adjusted_bars": sum(1 for r in continuous.get("seasonal_history", []) if r.get("roll")),
            },
            "volume": {
                "health": _series_health(continuous.get("total_volume_series", []), kind="volume"),
                "estimated_points": sum(1 for r in continuous.get("total_volume_series", []) if r.get("estimated")),
                "suspect_points": sum(
                    1 for r in continuous.get("total_volume_series", [])
                    if r.get("suspect") or r.get("source") == "yfinance_volume_suspect_low"
                ),
            },
            "open_interest": {
                "health": _series_health(daily_oi_series, kind="generic"),
                "latest_source": daily_oi_series[-1].get("source") if daily_oi_series else None,
            },
            "cot": {
                "health": _series_health(cot_series, kind="generic"),
            },
        }
        continuous["data_quality"] = {
            "price": quality_report["price"],
            "seasonal": quality_report["seasonal"],
            "volume": quality_report["volume"],
        }
        quality_index["markets"][key] = quality_report

        by_cat.setdefault(cat, {})[key] = {
            "display_name": cfg["display_name"],
            "category": cat,
            "currency": cfg["currency"],
            "unit": cfg["unit"],
            "tick_decimals": cfg["tick_decimals"],
            "contracts": contracts,
            "continuous_contract": continuous,
            "daily_oi_series": daily_oi_series,
            "calendar_spread_series": calendar_spread_series,
            "cot_series": cot_series,
            "specs": spec,
            "roll_dates": build_roll_dates(key, cfg, continuous.get("history") or []),
        }

    # 2) Write one JSON file per category
    for cat, payload in by_cat.items():
        fn = os.path.join(data_dir, f"data_{_slug(cat)}.json")
        _write_atomic(fn, lambda f, p=payload: json.dump(p, f, ensure_ascii=False))
        print(f"   ✓ {fn}  ({len(payload)} markets)")

    quality_path = os.path.join(data_dir, "data_quality.json")
    _write_atomic(quality_path, lambda f: json.dump(quality_index, f, ensure_ascii=False))
    print(f"   ✓ {quality_path}  (data health report)")

    screener_path = os.path.join(data_dir, "screener.json")
    screener_rows = build_screener_summary(by_cat)
    _write_atomic(screener_path, lambda f: json.dump(screener_rows, f, ensure_ascii=False))
    print(f"   ✓ {screener_path}  ({len(screener_rows)} markets · screener signals)")

    # The 3/3 period log behind the Weekly Outlook's shaded band and the content bot's
    # card-mode markers. Written HERE, next to the screener rows it is scored against,
    # because it used to be written by the bot alone: an on-screen feature then hung on a
    # semi-automatic Telegram run, and markets that turned 3/3 afterwards drew no band at
    # all while ones that had fallen to 2/3 kept theirs. Merged into the stored file, not
    # rebuilt — see _read_three_three_log.
    #
    # Wrapped defensively for the same reason as the SQLite mirror below, and one more
    # besides: this runs BEFORE config.js is written, so an exception here would end the
    # refresh with every category JSON already replaced and no new config.js — the
    # half-updated state _write_atomic exists to prevent, reached from another road again.
    # A band that stops advancing is a cosmetic loss and self-healing: _write_atomic leaves
    # the stored log untouched on a failure, and the next refresh merges into it as before.
    try:
        three_three_path = os.path.join(data_dir, "three_three_log.json")
        three_three_log = build_three_three_log(
            by_cat, screener_rows, previous=_read_three_three_log(three_three_path))
        _write_atomic(three_three_path,
                      lambda f: json.dump(three_three_log, f, ensure_ascii=False, indent=2))
        active = sum(1 for e in three_three_log.values() if e.get("active"))
        print(f"   ✓ {three_three_path}  ({len(three_three_log)} markets · {active} active 3/3)")
    except Exception as exc:
        print(f"   ⚠  3/3 period log skipped ({exc}) — the stored log is kept; the "
              f"Weekly Outlook band may lag until the next refresh")

    # 2a) Mirror everything into the durable SQLite EoD archive. The dashboard
    #     keeps reading the JSON above; the database is the long-term store and
    #     enables incremental updates. Wrapped defensively: a DB problem must
    #     never break JSON generation / the website.
    try:
        import eod_store
        db_path = os.path.join(data_dir, "charthorizon.db")
        kept = 0
        with eod_store.connect(db_path) as conn:
            eod_store.purge_non_cftc_open_interest(conn)
            eod_store.purge_estimated_volume_gap_fill(conn)
            eod_store.purge_suspect_volume_markers(conn)
            eod_store.purge_calendar_spread(conn)   # spread is a current snapshot, rewritten fresh
            for cat, payload in by_cat.items():
                for market_key, mk in payload.items():
                    cc = mk.get("continuous_contract", {})
                    # Local-first merge per series: the archive only ever grows
                    # or gets recent dates corrected. If a fresh fetch is shorter,
                    # older, or gappier than what's stored, the archive wins.
                    for fresh, reader, writer in (
                        (cc.get("history", []), eod_store.read_ohlcv, eod_store.write_ohlcv),
                        (cc.get("total_volume_series", []), eod_store.read_total_volume, eod_store.write_total_volume),
                        (mk.get("daily_oi_series", []), eod_store.read_open_interest, eod_store.write_open_interest),
                        (mk.get("cot_series", []), eod_store.read_cot, eod_store.write_cot),
                    ):
                        stored = reader(conn, market_key)
                        if eod_store.merge_is_safe(stored, fresh):
                            writer(conn, market_key, eod_store.merge_series(stored, fresh))
                        else:
                            kept += 1  # kept local archive (fresh was worse)
                    # Calendar spread: current snapshot only (table purged above),
                    # so just write the fresh contiguous block — no accumulation.
                    eod_store.write_calendar_spread(
                        conn, market_key, mk.get("calendar_spread_series", []))
                    eod_store.write_market_meta(conn, market_key, {
                        "display_name": mk.get("display_name"),
                        "category": mk.get("category"),
                        "currency": mk.get("currency"),
                        "unit": mk.get("unit"),
                        "tick_decimals": mk.get("tick_decimals"),
                        "cftc_code": COMMODITIES.get(market_key, {}).get("cftc_code"),
                        "last_refresh": date.today().isoformat(),
                        "quality_json": json.dumps(cc.get("data_quality", {}), ensure_ascii=False),
                    })
            stats = eod_store.store_stats(conn)
        kept_note = f" · {kept} series kept local (fresh was worse)" if kept else ""
        print(f"   ✓ {db_path}  (SQLite archive: "
              f"{stats['ohlcv_bars']:,} bars · {stats['open_interest']:,} OI · {stats['cot']:,} COT"
              f" · {stats['calendar_spread']:,} spread{kept_note})")
    except Exception as exc:
        print(f"   ⚠  SQLite archive skipped ({exc}) — JSON dashboard data is unaffected")

    # 2b) Sidebar order: most broadly-followed / popular categories first.
    #     Curated popularity ranking (keep in sync with CATEGORY_POPULARITY in the
    #     frontend). Any future category not listed is appended afterwards, ordered
    #     by CFTC OI coverage then name, so new categories still sort sensibly.
    CATEGORY_POPULARITY = [
        "Indices", "Crypto", "Metals", "Energy", "Currencies",
        "Agriculture", "Bonds", "Softs", "Livestock/Dairy",
    ]
    pop_rank = {cat: i for i, cat in enumerate(CATEGORY_POPULARITY)}

    def _category_rank(cat):
        if cat in pop_rank:
            return (0, pop_rank[cat], 0, cat)
        markets = by_cat.get(cat, {})
        markets_with_oi = sum(1 for p in markets.values() if p.get("daily_oi_series"))
        oi_volume = sum((p["daily_oi_series"][-1].get("oi", 0) or 0)
                        for p in markets.values() if p.get("daily_oi_series"))
        return (1, -markets_with_oi, -oi_volume, cat)

    ordered_cats = sorted(by_cat.keys(), key=_category_rank)
    cat_position = {cat: i for i, cat in enumerate(ordered_cats)}
    print("   · sidebar order (popularity): " + " > ".join(ordered_cats))

    # Rebuild index in the new category order (markets keep their in-category order).
    index = {
        key: meta for key, meta in sorted(
            index.items(), key=lambda kv: cat_position.get(kv[1]["category"], 999)
        )
    }

    # 3) Write the lightweight index + dynamic values to ff_data/config.js
    # Stable default start instrument (independent of sidebar order): prefer WTI,
    # else fall back to the first available market.
    first_key = "wti_crude" if "wti_crude" in index else next(iter(index))
    # What the data is "as of" — the settled session, not the day the run happened to finish.
    gen_date = _data_as_of_label(board_settled, dataset)
    data_version = datetime.now().strftime("%Y%m%d%H%M%S")

    config_path = os.path.join(data_dir, "config.js")

    # Central-bank policy rates for the FX strength score: live from BIS, with a
    # fallback to the previous values so a BIS outage never breaks the refresh.
    # forex.js prefers window.__CONFIG__.fxRates over its built-in default.
    fx_rate_table = fx_rates.fetch_fx_rates() or _previous_fx_rates(config_path)

    config = {
        "index": index,
        "firstKey": first_key,
        "dataDir": data_dir,
        "genDate": gen_date,
        "dataVersion": data_version,
    }
    if fx_rate_table:
        config["fxRates"] = fx_rate_table
    _write_atomic(config_path, lambda f: f.write(
        "window.__CONFIG__ = " + json.dumps(config, ensure_ascii=False) + ";\n"))
    print(f"\n✓ Frontend config written: {config_path}")
    print(f"   (Static frontend: app/index.html + app/web/; data in ./{data_dir}/)")
    # data_version rides along so an open page can tell THIS run from an earlier one over the
    # same data (web/refresh.js): gen_date names only the settled session.
    _write_refresh_progress(state="done", done=len(COMMODITIES), current=None,
                            category=None, latest_eod=gen_date, data_version=data_version)
    return config_path


if __name__ == "__main__":
    print("═" * 60)
    print("  COMMODITY DASHBOARD GENERATOR")
    print("═" * 60)
    print("  OHLCV/charts/contracts via yfinance · Open Interest/COT via CFTC")
    if yf is None:
        print("  ⚠ yfinance missing:  pip install yfinance python-dateutil pypdf curl_cffi")
    print()

    data = gather_commodity_data(count=6)
    generate_html(data)
    print("\nDone!")
    print("IMPORTANT: The page loads category data via fetch(), so it must run through a")
    print("web server, not by double-clicking the HTML file / file://.")
    print("The easiest path is start.py, which handles that automatically.")
