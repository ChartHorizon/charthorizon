"""CFTC Public API: weekly COT + Open Interest fetch and release-window logic.

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
from datetime import date, datetime, time, timedelta, timezone
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
from market_config import COMMODITIES
from net_tls import https_context

__all__ = [
    'CFTC_CATEGORY_PREFERENCE',
    'CFTC_COT_RELEASE_TIME_ET',
    'CFTC_DATASETS',
    'CFTC_ET_TZ',
    'CFTC_KNOWN_RELEASE_DATES',
    'CFTC_PUBLIC_DOMAIN',
    'CFTC_ROW_LIMIT',
    'DEFAULT_CFTC_PREFERENCE',
    '_cftc_cache',
    '_code_to_category',
    '_cot_now_et',
    '_cot_refresh_status',
    '_cot_release_dates_for_year',
    '_cot_report_date_for_release',
    '_dataset_order_for',
    '_existing_cot_latest',
    '_fetch_cftc_dataset',
    '_finish_cot_result',
    '_latest_released_cot_report',
    '_next_cot_release',
    '_parse_cftc_date',
    '_released_cot_reports',
    '_should_refresh_cot',
    '_stored_cot_latest_date',
    '_stored_cot_series_by_code',
    '_to_int',
    '_wanted_cftc_codes',
    'fetch_cftc_cot',
    'fetch_cftc_cot_api',
    'fetch_cftc_cot_legacy_txt',
]



# ─────────────────────────────────────────────────────────────────────
#  CFTC COMMITMENT OF TRADERS (free, official)
# ─────────────────────────────────────────────────────────────────────
_cftc_cache = None  # { cftc_code: [{date, cot_net, cot_long, cot_short, ...}] }
CFTC_PUBLIC_DOMAIN = "https://publicreporting.cftc.gov/resource"
CFTC_ROW_LIMIT = 50000
CFTC_COT_RELEASE_TIME_ET = time(15, 45)  # CFTC release is 15:30 ET; 15 min buffer avoids edge/cache timing.
CFTC_ET_TZ = ZoneInfo("America/New_York") if ZoneInfo else None
CFTC_KNOWN_RELEASE_DATES = {
    # Official CFTC COT release dates for 2026. Most reports are Friday 15:30 ET;
    # starred holiday delays are published on the listed non-Friday date.
    2026: {
        date(2026, 1, 5), date(2026, 1, 9), date(2026, 1, 16), date(2026, 1, 23), date(2026, 1, 30),
        date(2026, 2, 6), date(2026, 2, 13), date(2026, 2, 20), date(2026, 2, 27),
        date(2026, 3, 6), date(2026, 3, 13), date(2026, 3, 20), date(2026, 3, 27),
        date(2026, 4, 3), date(2026, 4, 10), date(2026, 4, 17), date(2026, 4, 24),
        date(2026, 5, 1), date(2026, 5, 8), date(2026, 5, 15), date(2026, 5, 22), date(2026, 5, 29),
        date(2026, 6, 5), date(2026, 6, 12), date(2026, 6, 22), date(2026, 6, 26),
        date(2026, 7, 6), date(2026, 7, 10), date(2026, 7, 17), date(2026, 7, 24), date(2026, 7, 31),
        date(2026, 8, 7), date(2026, 8, 14), date(2026, 8, 21), date(2026, 8, 28),
        date(2026, 9, 4), date(2026, 9, 11), date(2026, 9, 18), date(2026, 9, 25),
        date(2026, 10, 2), date(2026, 10, 9), date(2026, 10, 16), date(2026, 10, 23), date(2026, 10, 30),
        date(2026, 11, 6), date(2026, 11, 16), date(2026, 11, 20), date(2026, 11, 30),
        date(2026, 12, 4), date(2026, 12, 11), date(2026, 12, 18), date(2026, 12, 28),
    },
}

CFTC_DATASETS = [
    {
        "id": "72hh-3qpy",
        "name": "Disaggregated Futures Only",
        "label": "Producer/Merchant Net",
        "long_field": "prod_merc_positions_long",
        "short_field": "prod_merc_positions_short",
    },
    {
        "id": "gpe5-46if",
        "name": "TFF Futures Only",
        "label": "Leveraged Funds Net",
        "long_field": "lev_money_positions_long",
        "short_field": "lev_money_positions_short",
    },
    {
        "id": "6dca-aqww",
        "name": "Legacy Futures Only",
        "label": "Commercial Net",
        "long_field": "comm_positions_long_all",
        "short_field": "comm_positions_short_all",
    },
]

# Preferred COT report per category (deterministic, independent of query order).
# The signal always reads the COMMERCIAL / hedger side of the market:
#   - physical commodities -> Disaggregated (Producer/Merchant = Commercials)
#   - financial contracts  -> Legacy (Commercial). TFF (Leveraged Funds = large
#     specs) is kept ONLY as a data fallback if a code is missing from Legacy.
CFTC_CATEGORY_PREFERENCE = {
    "Energy":          ["Disaggregated Futures Only", "Legacy Futures Only"],
    "Metals":          ["Disaggregated Futures Only", "Legacy Futures Only"],
    "Agriculture":     ["Disaggregated Futures Only", "Legacy Futures Only"],
    "Softs":           ["Disaggregated Futures Only", "Legacy Futures Only"],
    "Livestock/Dairy": ["Disaggregated Futures Only", "Legacy Futures Only"],
    "Indices":         ["Legacy Futures Only", "TFF Futures Only"],
    "Bonds":           ["Legacy Futures Only", "TFF Futures Only"],
    "Currencies":      ["Legacy Futures Only", "TFF Futures Only"],
}
DEFAULT_CFTC_PREFERENCE = [
    "Disaggregated Futures Only", "TFF Futures Only", "Legacy Futures Only",
]


def _code_to_category():
    """Maps each CFTC code to its market category."""
    mapping = {}
    for cfg in COMMODITIES.values():
        code = str(cfg.get("cftc_code") or "").strip()
        if code:
            mapping[code] = cfg.get("category")
    return mapping


def _dataset_order_for(category):
    """Dataset order to try for a category:
    preferred reports first, then the rest as fallback."""
    pref = CFTC_CATEGORY_PREFERENCE.get(category, DEFAULT_CFTC_PREFERENCE)
    rest = [d["name"] for d in CFTC_DATASETS if d["name"] not in pref]
    return pref + rest


def _to_int(value):
    if value in (None, ""):
        return None
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return None


def _parse_cftc_date(value):
    if not value:
        return None
    value = str(value).strip().replace('"', "")
    if "T" in value:
        return value.split("T", 1)[0]
    parts = value.split("/")
    if len(parts) == 3:
        return f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
    if len(value) >= 10 and value[4:5] == "-" and value[7:8] == "-":
        return value[:10]
    return None


def _finish_cot_result(result, source_name):
    for code in result:
        deduped = {}
        for row in result[code]:
            deduped[row["date"]] = row
        result[code] = list(deduped.values())
        result[code].sort(key=lambda r: r["date"])
        result[code] = result[code][-260:]  # ca. 5 Jahre Wochenhistorie
    print(f"   ✓ CFTC COT ({source_name}): {len(result)} markets loaded")
    return result


def _wanted_cftc_codes():
    return sorted({
        str(cfg.get("cftc_code")).strip()
        for cfg in COMMODITIES.values()
        if cfg.get("cftc_code")
    })


def _fetch_cftc_dataset(dataset, wanted_codes):
    if not wanted_codes:
        return {}

    quoted_codes = ",".join(f"'{code}'" for code in wanted_codes)
    long_field = dataset["long_field"]
    short_field = dataset["short_field"]
    params = urllib.parse.urlencode({
        "$limit": str(CFTC_ROW_LIMIT),
        "$select": (
            "report_date_as_yyyy_mm_dd,cftc_contract_market_code,"
            f"contract_market_name,market_and_exchange_names,open_interest_all,{long_field},{short_field}"
        ),
        "$where": f"cftc_contract_market_code in({quoted_codes})",
        "$order": "report_date_as_yyyy_mm_dd DESC",
    })
    url = f"{CFTC_PUBLIC_DOMAIN}/{dataset['id']}.json?{params}"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    # Explicit certifi context: urllib's default trusts the OS root store, which on a
    # fresh Windows install is empty enough to fail every CFTC call. See net_tls.
    with urllib.request.urlopen(req, timeout=30, context=https_context()) as resp:
        rows = json.loads(resp.read().decode("utf-8", errors="ignore"))

    result = {}
    for row in rows:
        code = (row.get("cftc_contract_market_code") or "").strip()
        iso = _parse_cftc_date(row.get("report_date_as_yyyy_mm_dd"))
        total_oi = _to_int(row.get("open_interest_all"))
        cot_long = _to_int(row.get(long_field))
        cot_short = _to_int(row.get(short_field))
        # A missing Open Interest must not discard otherwise-valid COT positioning;
        # oi may be None (the OI series builder skips None-oi rows). Only the COT
        # long/short are required to form the net signal.
        if not (code and iso) or None in (cot_long, cot_short):
            continue
        cot_net = cot_long - cot_short
        result.setdefault(code, []).append({
            "date": iso,
            "oi": total_oi,
            "cot_net": cot_net,
            "cot_long": cot_long,
            "cot_short": cot_short,
            "cot_label": dataset["label"],
            "cot_report": dataset["name"],
            "market": row.get("contract_market_name") or row.get("market_and_exchange_names") or code,
            # Backward compatibility for the existing chart code and older JSON.
            "comm_net": cot_net,
            "comm_long": cot_long,
            "comm_short": cot_short,
        })

    return _finish_cot_result(result, dataset["name"])


def fetch_cftc_cot_api():
    """
    Loads COT through the official CFTC Public Reporting APIs and deterministically
    assigns the matching report to each market (see CFTC_CATEGORY_PREFERENCE):
      - Disaggregated Futures Only for physical commodities (Producer/Merchant)
      - Legacy Futures Only for financials, FX and rates (Commercial)
      - TFF Futures Only (Leveraged Funds) only as a fallback for missing codes
    """
    wanted = set(_wanted_cftc_codes())
    code_category = _code_to_category()

    # Query each dataset once with one bulk request.
    chunks = {}  # dataset_name -> { code: series }
    for dataset in CFTC_DATASETS:
        try:
            chunks[dataset["name"]] = _fetch_cftc_dataset(dataset, sorted(wanted))
        except Exception as e:
            print(f"   ⚠  CFTC {dataset['name']} failed: {e}")
            chunks[dataset["name"]] = {}

    # Pick the preferred report per code, otherwise fall back in order.
    merged = {}
    for code in wanted:
        for name in _dataset_order_for(code_category.get(code)):
            series = chunks.get(name, {}).get(code)
            if series:
                merged[code] = series
                break

    missing = wanted - set(merged)
    if missing:
        print(f"   ⚠  No CFTC series for: {', '.join(sorted(missing))}")

    # Each per-dataset series was already deduped/sorted/trimmed by _finish_cot_result
    # inside _fetch_cftc_dataset; `merged` only selects whole series, so re-finishing it
    # would just repeat that work. Log the combined count and return as-is.
    print(f"   ✓ CFTC COT (Public Reporting API combined): {len(merged)} markets loaded")
    return merged


def fetch_cftc_cot_legacy_txt():
    """
    Fallback: loads the legacy CFTC disaggregated text file and parses it as CSV.

    NOTE: f_disagg.txt only carries the Producer/Merchant (commercial) cohort for
    *physical* commodities. Financial contracts (Indices/Bonds/Currencies) have no
    Producer/Merchant category here — their commercial side lives in the Legacy
    (Commercial) report — so we SKIP them rather than attribute producer/merchant
    (or empty) numbers to them, which would violate the 'COT reads the commercial
    side' rule. On this fallback path financials simply get no COT until the API
    recovers.
    """
    url = "https://www.cftc.gov/dea/newcot/f_disagg.txt"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30, context=https_context()) as resp:
        text = resp.read().decode("utf-8", errors="ignore")

    code_category = _code_to_category()
    prod_merc_categories = {
        cat for cat, order in CFTC_CATEGORY_PREFERENCE.items()
        if order and order[0] == "Disaggregated Futures Only"
    }

    result = {}
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        code = (row.get("CFTC_Contract_Market_Code") or "").strip()
        # Producer/Merchant only represents the commercial side for physical
        # commodities; never attribute it to a financial contract.
        category = code_category.get(code)
        if category is not None and category not in prod_merc_categories:
            continue
        iso = _parse_cftc_date(row.get("Report_Date_as_MM_DD_YYYY"))
        total_oi = _to_int(row.get("Open_Interest_All"))
        comm_long = _to_int(row.get("Prod_Merc_Positions_Long_All"))
        comm_short = _to_int(row.get("Prod_Merc_Positions_Short_All"))
        if not (code and iso) or None in (comm_long, comm_short):
            continue
        result.setdefault(code, []).append({
            "date": iso,
            "oi": total_oi,
            "cot_net": comm_long - comm_short,
            "cot_long": comm_long,
            "cot_short": comm_short,
            "cot_label": "Producer/Merchant Net",
            "cot_report": "Legacy TXT",
            "market": code,
            "comm_net": comm_long - comm_short,
            "comm_long": comm_long,
            "comm_short": comm_short,
        })

    return _finish_cot_result(result, "Legacy TXT")


_existing_cot_latest = None


def _stored_cot_latest_date(data_dir="ff_data"):
    """Newest COT report date present in the previously stored data (across all markets)."""
    global _existing_cot_latest
    if _existing_cot_latest is None:
        _existing_cot_latest = ""
        try:
            for name in os.listdir(data_dir):
                if not (name.startswith("data_") and name.endswith(".json")):
                    continue
                with open(os.path.join(data_dir, name), encoding="utf-8") as f:
                    payload = json.load(f)
                if isinstance(payload, dict):
                    for v in payload.values():
                        series = v.get("cot_series") or []
                        if series:
                            d = str(series[-1].get("date", ""))[:10]
                            if d > _existing_cot_latest:
                                _existing_cot_latest = d
        except Exception:
            pass
    return _existing_cot_latest or None


def _cot_now_et():
    """Current time in Eastern Time, matching the CFTC publication schedule."""
    if CFTC_ET_TZ:
        return datetime.now(CFTC_ET_TZ)
    # zoneinfo unavailable (pre-3.9 without backport): approximate Eastern as a fixed
    # UTC-5 (EST) instead of naive machine-local time. On a non-ET box the old fallback
    # compared the local wall clock against 15:45 "ET" and could open the release window
    # hours early; UTC-5 is at worst 1h behind real ET during DST, which only ever DELAYS
    # the window — it never fetches before the 15:30 ET publication.
    return (datetime.now(timezone.utc) - timedelta(hours=5)).replace(tzinfo=None)


def _cot_release_dates_for_year(year):
    """Known CFTC COT publication dates for a year.

    CFTC publishes a tentative calendar with holiday delays. If a future year is
    not embedded yet, fall back to normal Fridays so the updater keeps working.
    """
    known = CFTC_KNOWN_RELEASE_DATES.get(year)
    if known:
        return set(known)
    d = date(year, 1, 1)
    d += timedelta(days=(4 - d.weekday()) % 7)  # first Friday
    out = set()
    while d.year == year:
        out.add(d)
        d += timedelta(days=7)
    return out


def _cot_report_date_for_release(release_date):
    """CFTC report rows are dated by the position date, usually Tuesday."""
    return release_date - timedelta(days=(release_date.weekday() - 1) % 7)


def _released_cot_reports(now_et=None):
    """Returns released COT reports up to `now_et` as (release_date, report_date)."""
    now_et = now_et or _cot_now_et()
    released = []
    for year in range(now_et.year - 1, now_et.year + 2):
        for release_date in _cot_release_dates_for_year(year):
            if release_date < now_et.date() or (
                release_date == now_et.date()
                and now_et.time() >= CFTC_COT_RELEASE_TIME_ET
            ):
                released.append((release_date, _cot_report_date_for_release(release_date)))
    released.sort()
    return released


def _latest_released_cot_report(now_et=None):
    released = _released_cot_reports(now_et)
    return released[-1] if released else (None, None)


def _next_cot_release(now_et=None):
    now_et = now_et or _cot_now_et()
    candidates = []
    for year in range(now_et.year - 1, now_et.year + 2):
        for release_date in _cot_release_dates_for_year(year):
            if release_date > now_et.date() or (
                release_date == now_et.date()
                and now_et.time() < CFTC_COT_RELEASE_TIME_ET
            ):
                candidates.append(release_date)
    return min(candidates) if candidates else None


def _cot_refresh_status(data_dir="ff_data"):
    """COT changes once per week, after the CFTC release window.

    The stored rows are Tuesday-dated report data; the release calendar is
    Friday 15:30 ET with occasional holiday delays. The updater therefore
    compares stored Tuesday report dates with the latest release that is already
    available in ET, instead of treating every refresh day as a new COT day.
    """
    stored = _stored_cot_latest_date(data_dir)
    now_et = _cot_now_et()
    release_date, report_date = _latest_released_cot_report(now_et)
    next_release = _next_cot_release(now_et)

    if not stored:
        return {
            "should_refresh": True,
            "stored": None,
            "release_date": release_date,
            "report_date": report_date,
            "next_release": next_release,
            "reason": "no stored CFTC COT data found",
        }

    try:
        stored_d = date.fromisoformat(stored)
    except ValueError:
        return {
            "should_refresh": True,
            "stored": stored,
            "release_date": release_date,
            "report_date": report_date,
            "next_release": next_release,
            "reason": "stored CFTC date is invalid",
        }

    if not report_date:
        return {
            "should_refresh": False,
            "stored": stored,
            "release_date": release_date,
            "report_date": report_date,
            "next_release": next_release,
            "reason": "no CFTC release window has opened yet",
        }

    return {
        "should_refresh": stored_d < report_date,
        "stored": stored,
        "release_date": release_date,
        "report_date": report_date,
        "next_release": next_release,
        "reason": "new weekly CFTC report released" if stored_d < report_date else "stored CFTC COT is current",
    }


def _should_refresh_cot(data_dir="ff_data"):
    return _cot_refresh_status(data_dir)["should_refresh"]


def _stored_cot_series_by_code(data_dir="ff_data"):
    """Rebuilds the { cftc_code: cot_series } map from the durable SQLite archive,
    so a skipped weekly fetch reuses the stored COT. The database — not the
    generated JSON — is the source of truth here: reading the JSON would let an
    earlier blank/partial JSON permanently starve markets of COT even though the
    archive still holds the full weekly history (this caused most markets to lose
    their COT panel)."""
    by_code = {}
    # Map each market key to its CFTC code via COMMODITIES (one series per code).
    key_to_code = {k: cfg.get("cftc_code") for k, cfg in COMMODITIES.items()}
    try:
        import eod_store
        db_path = os.path.join(data_dir, "charthorizon.db")
        with eod_store.connect(db_path) as conn:
            for market_key, code in key_to_code.items():
                if not code or code in by_code:
                    continue
                series = eod_store.read_cot(conn, market_key)
                if series:
                    by_code[code] = series
    except Exception:
        pass
    return by_code


def fetch_cftc_cot():
    """
    Loads CFTC COT series for all configured markets.
    Loaded once and cached (used for all markets).

    Returns: { cftc_code: [{date, cot_net, cot_long, cot_short, ...}, ...] }
    """
    global _cftc_cache
    if _cftc_cache is not None:
        return _cftc_cache

    try:
        _cftc_cache = fetch_cftc_cot_api()
        if _cftc_cache:
            return _cftc_cache
    except Exception as e:
        print(f"   ⚠  CFTC Public Reporting API failed: {e}")

    try:
        _cftc_cache = fetch_cftc_cot_legacy_txt()
    except Exception as e:
        print(f"   ⚠  CFTC Legacy-TXT failed: {e}")
        _cftc_cache = {}
    return _cftc_cache
