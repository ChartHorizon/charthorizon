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
import csv
import contextlib
import io
import json
import tempfile
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


# Background-refresh progress (read by start.py's /api/refresh-status). cwd is the
# data root when the generator runs, so this resolves to <data_root>/ff_data/.
PROGRESS_FILE = os.path.join("ff_data", "refresh_progress.json")


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


def gather_commodity_data(count=6):
    """
    Collects yfinance contracts, continuous charts and CFTC data for each market.
    """
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
    _done = 0
    for key, cfg in COMMODITIES.items():
        _write_refresh_progress(done=_done, current=cfg.get("display_name", key),
                                category=cfg.get("category", ""))
        _done += 1

        cfg["_key"] = key  # lets build_contract_list find the spec/expiry rule
        print(f"→ {cfg['display_name']}")
        contracts = select_yfinance_contracts(cfg, count=count)

        # chart history (native Yahoo front-month continuous)
        print(f"   · chart history {cfg.get('yf_continuous')}…")
        chart_symbol, chart_history = fetch_price_chart_history(cfg)
        # Seasonal tendency is refreshed at most once per year (see helper);
        # in between, the cached seasonal series is reused in the merge step.
        if _should_refresh_seasonal(key):
            seasonal_history = fetch_seasonal_price_history(cfg, chart_history)
            if seasonal_history:
                print(f"   · seasonal history: {seasonal_history[0]['date']} → {seasonal_history[-1]['date']} ({len(seasonal_history):,} bars, yearly refresh)")
        else:
            seasonal_history = []  # reuse the cached seasonal history (refreshed yearly)
            print("   · seasonal history: reusing cached (yearly refresh)")
        print("   · native front-month continuous chart from yfinance…")
        chart_history, total_volume_series, calendar_spread_series = fetch_yfinance_liquid_continuous_history(
            cfg,
            fallback_history=chart_history,
        )
        if total_volume_series:
            latest_vol = total_volume_series[-1]
            print(
                f"   · total volume: {latest_vol['volume']:,}"
                f"{' from ' + str(latest_vol.get('contract_count')) + ' contracts' if latest_vol.get('contract_count') else ''}"
                f" as of {latest_vol['date']}"
            )
        if chart_history:
            print(f"   · chart bars: {len(chart_history):,}")
        continuous_contract = build_continuous_contract(
            cfg,
            chart_symbol,
            chart_history,
            total_volume_series=total_volume_series,
        )
        continuous_contract["seasonal_history"] = seasonal_history

        # COT series for this market
        cot_series = cot_all.get(cfg.get("cftc_code"), [])

        dataset[key] = {
            "config": cfg,
            "contracts": contracts,
            "continuous_contract": continuous_contract,
            "daily_oi_snapshot": None,
            "cot_series": cot_series,
            "calendar_spread_series": calendar_spread_series,
        }

    _write_refresh_progress(done=_total, current=None, category=None)
    return dataset


def generate_html(dataset, out_path="commodity_dashboard.html", data_dir="ff_data"):
    """
    Generates:
      - one lightweight HTML file (sidebar structure only, no heavy data JSON)
      - one JSON file per category (ff_data/data_<category>.json)
    The HTML loads category data lazily via fetch().
    """
    os.makedirs(data_dir, exist_ok=True)
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
        # the gappy backfill that older accumulation produced.
        calendar_spread_series = _cap_series_to_date(entry.get("calendar_spread_series") or [], board_settled)
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
            "contracts": entry["contracts"],
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
        with open(fn, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        print(f"   ✓ {fn}  ({len(payload)} markets)")

    quality_path = os.path.join(data_dir, "data_quality.json")
    with open(quality_path, "w", encoding="utf-8") as f:
        json.dump(quality_index, f, ensure_ascii=False)
    print(f"   ✓ {quality_path}  (data health report)")

    screener_path = os.path.join(data_dir, "screener.json")
    screener_rows = build_screener_summary(by_cat)
    with open(screener_path, "w", encoding="utf-8") as f:
        json.dump(screener_rows, f, ensure_ascii=False)
    print(f"   ✓ {screener_path}  ({len(screener_rows)} markets · screener signals)")

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
    gen_date = date.today().strftime("%b %d, %Y")
    data_version = datetime.now().strftime("%Y%m%d%H%M%S")

    config = {
        "index": index,
        "firstKey": first_key,
        "dataDir": data_dir,
        "genDate": gen_date,
        "dataVersion": data_version,
    }
    config_path = os.path.join(data_dir, "config.js")
    with open(config_path, "w", encoding="utf-8") as f:
        f.write("window.__CONFIG__ = " + json.dumps(config, ensure_ascii=False) + ";\n")
    print(f"\n✓ Frontend config written: {config_path}")
    print(f"   (Static frontend: app/index.html + app/web/; data in ./{data_dir}/)")
    _write_refresh_progress(state="done", done=len(COMMODITIES), current=None,
                            category=None, latest_eod=gen_date)
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
