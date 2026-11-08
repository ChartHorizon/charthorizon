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
import series_utils

import yahoo_gateway
import contract_history_cache
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


# The Windows-safe os.replace lives in atomic_replace (stdlib only), because start.py's own
# progress and acknowledgement writes need it too and start.py cannot import this module
# before dateutil is installed. The name stays, so the call sites and tests keep it.
from atomic_replace import replace_with_retry as _replace_with_retry  # noqa: E402


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
    Never raises — progress reporting must never break a refresh. The replace is retried
    on a Windows sharing violation (_replace_with_retry): the server reads this file for
    every /api/refresh-status poll (once a second from the page and from loading.html), and
    a lost write may be the phase="rest" transition."""
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
            _replace_with_retry(tmp, PROGRESS_FILE)
        except Exception:
            # os.replace failed after the temp was written — don't leak the orphan.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        pass


def _batch_volumes(symbols, quotes=None):
    """{symbol: volume} for volume > 0, from one batch quote. Order-only input for
    choosing lead/next; never written to a file. Never raises."""
    try:
        if quotes is None:
            quotes = lambda s: yahoo_gateway.gateway().quotes(
                s, priority=yahoo_gateway.PRIORITY_BULK)
        out = {}
        for sym, row in (quotes(list(symbols)) or {}).items():
            vol = (row or {}).get("volume")
            if isinstance(vol, (int, float)) and vol > 0:
                out[sym] = vol
        return out
    except Exception:
        return {}


# Guards the per-run `written` set (symbols whose cache file this run already wrote),
# which phase "fronts" and every phase-2 worker share.
_written_lock = threading.Lock()


def _write_contract_history(symbol, now_et=None, period=contract_history_cache.PERIOD,
                            expiry=None, contract_type="single_expiry_month"):
    """Write one answer into ff_data/contract_history/ from the frame this run already holds:
    a contract's 5y history for the server's lazy endpoint and for the next run, or the =F
    chart (period CONTINUOUS_CHART_PERIOD) for the next run only. True when the file is
    there for this run's settle. Never requests: no cached frame, no file.

    The rows are the generator's own ingest rows (chart_history: its trim and its volume
    test), so a file never carries a bar the generator rejected as unsettled. They are then
    cut at the SERVER's cutoff (holiday-aware) for `now_et`, which is also the stamp: a file
    never extends past its own `settled_through`, whatever the generator's clock (which does
    not skip holidays, and reads the time at the write) would have kept.

    `now_et` is when the run started (gather_commodity_data passes it), not when the file is
    written. A frame fetched at 17:28 ET still holds that session's forming bar when it is
    written at 17:31; read then, the cutoff would be today and the bar would go out stamped
    as settled, and the server would never ask again. Every frame is fetched after the run
    started, so the cutoff at the start is one each frame has already passed.

    Two readers, two stamps. `settled_through` (the server's) is set only when the last bar
    reaches the cutoff: a shorter file must not stand as current behind
    CONTRACT_HISTORY_RETRY_SECONDS, or the content bot, shooting straight after the 23:30
    refresh, would hit STALE_CARD on it. A short or empty answer is still Yahoo's whole answer
    for this settle — a thin far month that did not print, a month not listed yet — so it is
    written with `settled_through: null` (the server refetches it at once, as if there were no
    file) and `complete_for` (the next run of the same settle takes it instead of asking:
    contract_history_cache.is_complete_answer). `complete_for` is left out when the
    generator's clock and the server's disagree (an exchange holiday after the settle: the
    rows here are cut short of what this run ingested), and an empty answer is not kept while
    the 429 breaker is open, when "empty" can be a throttle in disguise. `expiry` lets an
    expired contract's file serve every later settle.

    A file this run took instead of asking (reuse on, and fetch_yfinance.load_kept_answer
    would take it) is kept as it is: rewriting it would date an old answer as a new one. Only
    its mtime moves, for prune(). One it could not read was asked again, and is rewritten.

    Never raises: a write that fails in any way prints one line and returns False."""
    if _yf_client.cached_history(symbol, period) is None:
        return False
    try:
        now = now_et or contract_history_cache.eastern_now()
        cutoff = contract_history_cache.latest_settled_eod_date(now)
        path = contract_history_cache.cache_path(symbol, period)
        if fetch_yfinance.cache_reuse_cutoff() == cutoff and (
                _yf_client.answered_from_cache(symbol, period)
                or fetch_yfinance.load_kept_answer(symbol, period, cutoff) is not None):
            contract_history_cache.keep(path)
            return True
    except Exception:
        return False
    try:
        rows = _yf_client.chart_history(symbol, period=period, quiet=True, raise_errors=True)
    except Exception:
        return False
    try:
        settled = cutoff.isoformat()
        rows = [r for r in rows or [] if str(r.get("date") or "")[:10] <= settled]
        reaches = bool(rows) and str(rows[-1].get("date") or "")[:10] >= settled
        complete = series_utils._latest_settled_eod_date(now) == cutoff
        if not rows and yahoo_gateway.gateway().cooldown_active():
            complete = False
        if not reaches and not complete:
            return False
        payload = contract_history_cache.build_payload(
            symbol, period, rows, cutoff if reaches else None, now.timestamp(),
            complete_for=cutoff if complete else None, expiry=expiry,
            contract_type=contract_type)
        return contract_history_cache.write_payload(path, payload, replace=_replace_with_retry)
    except Exception as exc:
        # write_payload absorbs an OSError itself; anything else (a value json cannot
        # encode, a bad row) would leave through the pool's ex.map and end the refresh. The
        # file is an optimisation: without it the server fetches lazily, as it always did.
        print(f"   ⚠  {symbol}: contract-history cache file not written ({exc})")
        return False


def _gather_fronts(items, existing_payloads, workers, quotes=None, written=None, now_et=None,
                   reused=None):
    """Phase "fronts": every market's lead contract, then every market's next one, fetched
    before anything else and written straight into the contract-history cache.

    Lead/next come from one batch volume quote (order only, never written), else the
    previous run's stored volumes, else the first candidates (pick_lead_and_next). The task
    list is all leads, then all nexts; a ThreadPoolExecutor's queue is FIFO, so that is the
    order the requests go out in. The pool's clients are thread-local and never shared, so
    each task hands back what its client fetched (cache_added_since) and it is merged per
    market into `cached`, which phase 2 seeds and nobody mutates. Symbols whose file was
    written are added to `written`, symbols answered from a kept file (no request) to
    `reused`; `now_et` is the run's start (see _write_contract_history).

    Returns {market_key: {"lead": sym|None, "next": sym|None,
                          "cached": {"history": {...}, "quotes": {...}}}}."""
    candidates = {}
    for key, cfg in items:
        cfg["_key"] = key  # lets build_contract_list find the spec/expiry rule
        candidates[key] = build_contract_candidates(cfg)
    volumes = _batch_volumes(
        [c["yf_symbol"] for cands in candidates.values() for c in cands], quotes=quotes)

    expiries = {c["yf_symbol"]: c.get("expiry") for cands in candidates.values() for c in cands}
    fronts, leads, nexts = {}, [], []
    for key, cands in candidates.items():
        stored = (existing_payloads or {}).get(key)
        previous = stored.get("contracts") if isinstance(stored, dict) else None
        lead, nxt = pick_lead_and_next(cands, volumes, previous)
        lead_sym = (lead or {}).get("yf_symbol")
        next_sym = (nxt or {}).get("yf_symbol")
        fronts[key] = {"lead": lead_sym, "next": next_sym,
                       "cached": {"history": {}, "quotes": {}}}
        if lead_sym:
            leads.append((key, lead_sym))
        if next_sym:
            nexts.append((key, next_sym))
    tasks = leads + nexts
    total = len(tasks)
    print(f"-> Front months first: {len(leads)} leads, then {len(nexts)} next months "
          f"(batch volume for {len(volumes)} contracts)")

    progress_lock = threading.Lock()
    done = {"n": 0}
    _write_refresh_progress(phase="fronts", fronts_done=0, fronts_total=total)

    def _task(task):
        key, sym = task
        snapshot = _yf_client.cache_snapshot()
        _yf_client.quote(sym, quiet=True)
        if _yf_client.answered_from_cache(sym) and reused is not None:
            with _written_lock:
                reused.add(sym)
        if (_write_contract_history(sym, now_et=now_et, expiry=expiries.get(sym))
                and written is not None):
            with _written_lock:
                written.add(sym)
        with progress_lock:
            done["n"] += 1
            _write_refresh_progress(phase="fronts", fronts_done=done["n"], fronts_total=total)
        return key, sym, _yf_client.cache_added_since(snapshot)

    if tasks:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(workers))) as ex:
            for key, _sym, added in ex.map(_task, tasks):
                cached = fronts[key]["cached"]
                cached["history"].update(added["history"])
                cached["quotes"].update(added["quotes"])
    return fronts


def _write_market_histories(cfg, contracts, chart_symbol, frames, written, now_et=None,
                            count=6):
    """Phase 2's share of the cache: every 5y answer this market's task holds (`frames`, what
    its client added since the task began, the seeded fronts included) that this run has not
    written yet, and the =F chart. Whoever asked: the total-volume scan (most of a refresh's
    requests, and the ones only the TOTAL pane needs), quote() on the chain and on candidates
    past the scan's window, the settled-contract probe. The next run of the same settle reads
    them back instead of asking (contract_history_cache.is_complete_answer). A symbol belongs
    to one market, so no two workers race on it. The candidate lists only supply expiries."""
    period = contract_history_cache.PERIOD
    expiries = {}
    candidates = (list(contracts or [])
                  + build_total_volume_contract_candidates(
                      cfg,
                      lookback_months=YF_LIQUID_CONTINUOUS_LOOKBACK_MONTHS,
                      forward_months=YF_LIQUID_CONTINUOUS_FORWARD_MONTHS,
                      max_contracts=YF_LIQUID_CONTINUOUS_MAX_CONTRACTS)
                  + build_contract_candidates(cfg, count=max(YF_CONTRACT_LOOKAHEAD, count)))
    for c in candidates:
        sym = c.get("yf_symbol")
        if sym and sym not in expiries:
            expiries[sym] = c.get("expiry")
    for sym in sorted({k[0] for k in frames if k[1] == period and k[2] == "1d"}):
        with _written_lock:
            if sym in written:
                continue
        if _write_contract_history(sym, now_et=now_et, expiry=expiries.get(sym)):
            with _written_lock:
                written.add(sym)
    if chart_symbol:
        _write_contract_history(chart_symbol, now_et=now_et,
                                period=fetch_yfinance.CONTINUOUS_CHART_PERIOD,
                                contract_type="continuous_front_month")


def _gather_one_market(key, cfg, cot_all, count, cached=None, written=None, now_et=None):
    """Fetch one market's yfinance data. Self-contained so it can run on a worker thread.

    `cached` is what phase "fronts" fetched for this market: seeded into this thread's
    client first, so its lead and next are not requested a second time."""
    # A pool thread's client outlives its task: what was added since this point is this
    # market's (seeded frames included), which is what _write_market_histories keeps.
    snapshot = _yf_client.cache_snapshot()
    if cached:
        _yf_client.seed(cached)
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
    _write_market_histories(cfg, contracts, chart_symbol,
                            _yf_client.cache_added_since(snapshot)["history"],
                            set() if written is None else written, now_et=now_et, count=count)
    cot_series = cot_all.get(cfg.get("cftc_code"), [])
    return key, {
        "config": cfg,
        "contracts": contracts,
        "continuous_contract": continuous_contract,
        "daily_oi_snapshot": None,
        "cot_series": cot_series,
        "calendar_spread_series": calendar_spread_series,
    }


def _first_pass_market(key, cfg, cot_all, count, front):
    """A first-pass board entry for one market, from what phase "fronts" fetched plus the
    =F chart. Runs on a pool thread; returns (key, entry, added_cached), where
    `added_cached` is what this thread's client fetched here, for phase 2 to seed.

    Every background refresh writes one (start.py), so this is a first run's AND a warm
    start's. The seasonal `max` frame is fetched only when it is due (_should_refresh_seasonal:
    nothing stored, i.e. a first run, or a new calendar year); otherwise the entry carries
    none and generate_html keeps the stored one, exactly as phase 2 does. When it is fetched,
    it is asked for BEFORE the 20-year chart, so _cached_superset cuts the chart out of it
    instead of requesting it separately. The chain is read offline: only
    lead and next are priced, the other rows stay `available: False` ("–"). The spread is
    left empty for phase 2 to fill: with only lead and next fetched, it cannot see the
    predecessor and would show the current pair starting long before the real roll. The
    total volume is not empty on the board, although this entry carries none: generate_html
    builds it as on every run, from the =F series' own volume merged with
    _cached_contract_volume_series, which on a first run sums just the lead and next files
    phase "fronts" wrote. The complete run's sum over the whole chain replaces it, because
    the volume merge keeps the larger value per day."""
    front = front or {}
    if front.get("cached"):
        _yf_client.seed(front["cached"])
    snapshot = _yf_client.cache_snapshot()
    cfg["_key"] = key  # lets build_contract_list find the spec/expiry rule
    seasonal_history = (fetch_seasonal_price_history(cfg, None)
                        if _should_refresh_seasonal(key) else [])
    chart_symbol, chart_history = fetch_price_chart_history(cfg)
    # Cleaned as the complete run cleans it (fetch_yfinance_liquid_continuous_history): a
    # spike-and-revert print the complete board drops must not open the dashboard. The USD
    # Index keeps its raw cash/index proxy there, so it does here.
    if cfg.get("chart_format") != "dxy_index_proxy":
        chart_history = _clean_continuous_history(chart_history)
    contracts = select_yfinance_contracts(cfg, count=count, offline=True)
    continuous_contract = build_continuous_contract(
        cfg, chart_symbol, chart_history, total_volume_series=[])
    continuous_contract["seasonal_history"] = seasonal_history
    # Lead and next only: the unpriced chain rows would each cost a 1-month request.
    picked = [c for c in contracts if c["yf_symbol"] in (front.get("lead"), front.get("next"))]
    try:
        continuous_contract["_settled_by_date"] = resolve_settled_contracts(
            cfg, chart_history, picked)
    except Exception as exc:
        print(f"   ⚠  {cfg['display_name']}: settled contract not resolved ({exc})")
    entry = {
        "config": cfg,
        "contracts": contracts,
        "continuous_contract": continuous_contract,
        "daily_oi_snapshot": None,
        "cot_series": cot_all.get(cfg.get("cftc_code"), []),
        "calendar_spread_series": [],
    }
    return key, entry, _yf_client.cache_added_since(snapshot)


def _run_first_pass(items, cot_all, count, fronts, workers, on_first_pass):
    """Build the first-pass dataset on the pool, hand each market's new frames to phase 2
    through `fronts[key]["cached"]`, then call `on_first_pass(dataset)`.

    A first pass is a head start, never a requirement: any failure here, the hook's
    included, prints a warning and the complete run goes on as if there had been none."""
    print(f"-> First-pass board: {len(items)} markets from the front months "
          f"(the complete board follows)")

    def _task(item):
        key, cfg = item
        return _first_pass_market(key, cfg, cot_all, count, fronts[key])
    try:
        dataset = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(workers))) as ex:
            for key, entry, added in ex.map(_task, items):
                dataset[key] = entry
                cached = fronts[key]["cached"]
                cached["history"].update(added["history"])
                cached["quotes"].update(added["quotes"])
        on_first_pass(dataset)
    except Exception as exc:
        print(f"   ⚠  first-pass board skipped ({exc}); the complete run continues")


def gather_commodity_data(count=6, on_first_pass=None, fresh=False):
    """
    Collects yfinance contracts, continuous charts and CFTC data for each market.

    `on_first_pass(dataset)` (every background refresh) is called between phase "fronts" and
    phase "rest" with a partial but renderable dataset (see _first_pass_market) — unless
    there is nothing for it to show (see _gather_all).

    Every answer of a settle is asked for once. A run reads back what an earlier run kept for
    the same settle in ff_data/contract_history/ (contract_history_cache.is_complete_answer):
    the generator ingests settled bars only, so a second request before the next settle
    could only return the same rows. That is a later start on the same day, or any start
    between Friday's settle and Monday's. The first run after each settle asks for
    everything, as before. `fresh` (start.py --force-refresh) asks for everything regardless.
    Reuse stays off on an exchange holiday after its settle, when the generator's clock and
    the server's name different sessions.
    """
    # Before any request: every contract-history file this run writes is cut and stamped
    # at the settle cutoff of this moment, never at its write time (_write_contract_history).
    run_now = contract_history_cache.eastern_now()
    cutoff = contract_history_cache.latest_settled_eod_date(run_now)
    if fresh:
        print("-> Cache: not read (--force-refresh); every answer is asked for again")
    elif series_utils._latest_settled_eod_date(run_now) != cutoff:
        print(f"-> Cache: not read (exchange holiday after the {cutoff.isoformat()} settle)")
    else:
        fetch_yfinance.enable_cache_reuse(cutoff)
    try:
        dataset = _gather_all(count, on_first_pass, run_now)
        reused = fetch_yfinance.cache_reuse_count()
        if fetch_yfinance.cache_reuse_cutoff() is not None:
            print(f"-> Cache: {reused} answers for the {cutoff.isoformat()} settle answered from "
                  f"ff_data/contract_history (no Yahoo request)")
        return dataset
    finally:
        fetch_yfinance.disable_cache_reuse()


def _gather_all(count, on_first_pass, run_now):
    """gather_commodity_data's run, with reuse already set up for it.

    The first pass is skipped when it could show nothing new: a board is on disk and every
    front month was answered from a kept file, i.e. no new settle since the run that wrote
    that board. It would cost a whole board write (~7 s on the main thread while every worker
    waits) to put the same numbers on screen a second time."""
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
    # The phase fields go back to "not started" with the run: the previous run left
    # phase="rest" behind, and a reader waiting for phase 1 would take that as this run's.
    # Its first_pass_version goes too, or an open page would wait on the old board's stamp.
    _write_refresh_progress(state="running", total=_total, done=0, current=None, category=None,
                            phase=None, fronts_done=0, fronts_total=None,
                            first_pass_version=None)
    items = list(COMMODITIES.items())
    workers = max(1, int(REFRESH_FETCH_WORKERS))

    # Prime the lazy seasonal-year cache single-threaded so the parallel workers below
    # don't race its first-touch population (fetch_yfinance._existing_seasonal_years).
    if items:
        _should_refresh_seasonal(items[0][0])

    # Phase "fronts": every lead, then every next, fetched first and written into the
    # contract-history cache. Phase 2 ("rest") seeds each market with what it fetched and
    # skips the files it wrote; total requests are unchanged, only their order moves.
    written, reused = set(), set()
    existing = _load_existing_market_payloads("ff_data")
    fronts = _gather_fronts(items, existing, workers, written=written, now_et=run_now,
                            reused=reused)
    front_syms = {s for f in fronts.values() for s in (f["lead"], f["next"]) if s}
    # A first run writes a board from the front months now, so the dashboard can open;
    # phase 2 then seeds the frames the first pass added (the seasonal `max` above all).
    if on_first_pass is not None:
        if existing and front_syms and front_syms <= reused:
            print("-> First-pass board skipped: every front month answered from the cache, "
                  "so the stored board already shows this settle")
        else:
            _run_first_pass(items, cot_all, count, fronts, workers, on_first_pass)
    _write_refresh_progress(phase="rest")

    def _cached(key):
        return (fronts.get(key) or {}).get("cached")

    if workers <= 1:
        _done = 0
        for key, cfg in items:
            _write_refresh_progress(done=_done, current=cfg.get("display_name", key),
                                    category=cfg.get("category", ""))
            _done += 1
            k, entry = _gather_one_market(key, cfg, cot_all, count, cached=_cached(key),
                                          written=written, now_et=run_now)
            dataset[k] = entry
    else:
        _progress_lock = threading.Lock()
        _done = {"n": 0}

        def _task(item):
            key, cfg = item
            with _progress_lock:
                _write_refresh_progress(done=_done["n"], current=cfg.get("display_name", key),
                                        category=cfg.get("category", ""))
            k, entry = _gather_one_market(key, cfg, cot_all, count, cached=_cached(key),
                                          written=written, now_et=run_now)
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


def _first_pass_volume_cap(existing_volume_series, board_settled):
    """The last day a first pass may write into a stored total-volume series: the stored
    series' own last day, never past the board's settled session."""
    days = [d for d in (_bar_date(r) for r in existing_volume_series) if d is not None]
    if not days:
        return board_settled
    last = max(days)
    return last if board_settled is None else min(last, board_settled)


def generate_html(dataset, out_path="commodity_dashboard.html", data_dir="ff_data",
                  first_pass=False):
    """
    Generates:
      - one lightweight HTML file (sidebar structure only, no heavy data JSON)
      - one JSON file per category (ff_data/data_<category>.json)
    The HTML loads category data lazily via fetch().

    `first_pass=True` (the board from the front months that every background refresh
    writes before its phase 2, see _first_pass_market) writes the category files,
    data_quality.json, screener.json and config.js only. Not the 3/3 log, which is merged
    and never rebuilt, so a period reconstructed from partial inputs would be kept for good;
    not the SQLite archive, which upserts per date; no prune; and no state="done", or the
    open page would take the run as finished — it announces itself as `first_pass_version`
    instead. Over a stored board (a warm start) the rows it has not priced keep their stored
    values, the spread and the 3/3 band stay the stored ones, and the total-volume series
    is held at its stored last day (_first_pass_volume_cap); phase 2 replaces all of it.
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
        # A first pass prices lead and next only: the other rows were not asked for yet, which
        # this line would report as a Yahoo failure in every market.
        if reused_contracts and not first_pass:
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
        volume_cap = board_settled
        if first_pass and existing_volume_series:
            # On a first pass only lead and next have been fetched for the new sessions, so
            # their sum there is a fraction of the market's total (a third, for crude) and
            # would stand as TOTAL until phase 2. A warm start holds the pane at the stored
            # last day instead; a first run has nothing stored and shows what it has.
            volume_cap = _first_pass_volume_cap(existing_volume_series, board_settled)
        continuous["total_volume_series"] = _cap_series_to_date(
            _merge_volume_series(
                existing_volume_series,
                fresh_volume_series,
                fallback_history=continuous.get("history", []),
            ),
            volume_cap,
        )
        seasonal_health = _series_health(continuous.get("seasonal_history", []), kind="seasonal")
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
                "health": seasonal_health,
                "fresh": seasonal_choice["fresh"],
                "previous": seasonal_choice["previous"],
                "has_5y": seasonal_health["years"] >= 5,
                "has_15y": seasonal_health["years"] >= 15,
                "has_40y": seasonal_health["years"] >= 40,
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

    # 2) Write one JSON file per category. Every file here is encoded with json.dumps and
    #    written in one piece: json.dump onto a file never takes the C encoder (CPython uses it
    #    only for a one-shot encode), and the nine category files took 2.8 s that way against
    #    0.7 s, for the same text byte for byte (test_board_cpu).
    for cat, payload in by_cat.items():
        fn = os.path.join(data_dir, f"data_{_slug(cat)}.json")
        _write_atomic(fn, lambda f, p=payload: f.write(json.dumps(p, ensure_ascii=False)))
        print(f"   ✓ {fn}  ({len(payload)} markets)")

    quality_path = os.path.join(data_dir, "data_quality.json")
    _write_atomic(quality_path, lambda f: f.write(json.dumps(quality_index, ensure_ascii=False)))
    print(f"   ✓ {quality_path}  (data health report)")

    screener_path = os.path.join(data_dir, "screener.json")
    # Each market's seasonal curves are built once and read by the screener and the 3/3 log
    # alike (each used to build its own: ~1 s per run, test_board_cpu).
    seasonal_curves = seasonal_curves_by_market(by_cat)
    screener_rows = build_screener_summary(by_cat, seasonal_curves=seasonal_curves)
    _write_atomic(screener_path, lambda f: f.write(json.dumps(screener_rows, ensure_ascii=False)))
    print(f"   ✓ {screener_path}  ({len(screener_rows)} markets · screener signals)")

    if first_pass:
        print("   · first pass: the 3/3 log and the SQLite archive wait for the complete run")
    else:
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
                by_cat, screener_rows, previous=_read_three_three_log(three_three_path),
                seasonal_curves=seasonal_curves)
            _write_atomic(three_three_path,
                          lambda f: f.write(json.dumps(three_three_log, ensure_ascii=False,
                                                       indent=2)))
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
    # Not on the first pass: BIS has a 30 s timeout and stands in front of config.js, which
    # the splash is waiting for. It keeps the previous rates (none on a true first run, so
    # forex.js uses its built-in table); the complete run asks BIS as always.
    if first_pass:
        fx_rate_table = _previous_fx_rates(config_path)
    else:
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
    if first_pass:
        # The run goes on: the progress stays state="running" for the open page to follow,
        # and first_pass_version tells it there is a board to apply meanwhile (refresh.js).
        _write_refresh_progress(first_pass_version=data_version)
        return config_path
    try:
        import contract_history_cache
        contract_history_cache.prune(data_dir=data_dir)
    except Exception as exc:  # housekeeping only; never fails a refresh
        print(f"   ⚠ contract-history prune skipped: {exc}")
    # data_version rides along so an open page can tell THIS run from an earlier one over the
    # same data (web/refresh.js): gen_date names only the settled session.
    _write_refresh_progress(state="done", done=len(COMMODITIES), current=None,
                            category=None, latest_eod=gen_date, data_version=data_version)
    return config_path


def run_generator(first_pass=False, fresh=False):
    """One generator run: gather, then write the complete board. `first_pass` (every
    background refresh, start.py) also writes a first-pass board between the phases: a
    first run's dashboard opens on it, and an open page shows the new front months on it
    long before the complete run ends. `fresh` asks Yahoo for every answer again instead of
    reading back what an earlier run of the same settle kept (start.py --force-refresh)."""
    hook = (lambda d: generate_html(d, first_pass=True)) if first_pass else None
    data = gather_commodity_data(count=6, on_first_pass=hook, fresh=fresh)
    generate_html(data)


if __name__ == "__main__":
    print("═" * 60)
    print("  COMMODITY DASHBOARD GENERATOR")
    print("═" * 60)
    print("  OHLCV/charts/contracts via yfinance · Open Interest/COT via CFTC")
    if yf is None:
        print("  ⚠ yfinance missing:  pip install yfinance python-dateutil pypdf curl_cffi")
    print()

    run_generator("--first-pass" in sys.argv[1:], fresh="--fresh" in sys.argv[1:])
    print("\nDone!")
    print("IMPORTANT: The page loads category data via fetch(), so it must run through a")
    print("web server, not by double-clicking the HTML file / file://.")
    print("The easiest path is start.py, which handles that automatically.")
