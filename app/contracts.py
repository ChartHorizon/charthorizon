"""Contract-chain construction: yfinance contract symbols and candidate months.

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
    CONTRACT_SPECS,
    MONTH_CODES,
    MONTH_NAMES,
    YF_CONTRACT_LOOKAHEAD,
    YF_TOTAL_VOLUME_FORWARD_MONTHS,
    YF_TOTAL_VOLUME_LOOKBACK_MONTHS,
    YF_TOTAL_VOLUME_MAX_CONTRACTS,
)
from calendar_utils import compute_expiry

__all__ = [
    'build_contract_candidates',
    'build_contract_list',
    'build_contract_symbol',
    'build_total_volume_contract_candidates',
    'build_yf_symbol',
    'next_contract_months',
]



# ─────────────────────────────────────────────────────────────────────
#  SYMBOL ENGINE
# ─────────────────────────────────────────────────────────────────────
def next_contract_months(valid_months, count=6, start=None):
    """
    Calculates the next `count` valid contract months from today.
    Uses only actually tradable delivery months (valid_months)
    and handles year boundaries correctly.

    Returns: list of (year, month) tuples.
    """
    if start is None:
        start = date.today()

    results = []
    # Start with the current month and scan at most 60 months ahead
    cursor = date(start.year, start.month, 1)
    months_checked = 0

    while len(results) < count and months_checked < 60:
        if cursor.month in valid_months:
            # Front month: include it unless it has already expired.
            # Simplification: include the current month.
            results.append((cursor.year, cursor.month))
        cursor += relativedelta(months=1)
        months_checked += 1

    return results


def build_yf_symbol(root, exchange, year, month):
    """
    Builds the Yahoo Finance futures symbol.
    Format:  {ROOT}{MONTHCODE}{YY}.{EXCHANGE}
    Example: GC + Q + 26 + .CMX  ->  GCQ26.CMX
    """
    code = MONTH_CODES[month]
    yy = str(year)[-2:]
    return f"{root}{code}{yy}.{exchange}"


def build_contract_list(cfg, count=6):
    """Builds the contract list with Yahoo symbol, short symbol and computed expiry date.

    Already expired contracts (last trading day before today) are skipped
    so the futures curve never shows a dead front month with stale prices.
    More months than needed are generated so `count` real contracts remain
    after filtering.
    """
    spec = CONTRACT_SPECS.get(cfg.get("_key", ""), {})
    rule = spec.get("expiry_rule")
    today = date.today()
    raw_months = next_contract_months(cfg["contract_months"], count=count + 12)
    contracts = []
    for (yr, mo) in raw_months:
        exp = compute_expiry(rule, yr, mo) if rule else None
        # Skip only when the expiry is known and lies in the past.
        if exp is not None and exp < today:
            continue
        contract_symbol = build_contract_symbol(cfg["yf_root"], yr, mo)
        contracts.append({
            "yf_symbol": build_yf_symbol(cfg["yf_root"], cfg["yf_exchange"], yr, mo),
            "contract_symbol": contract_symbol,
            "label": f"{MONTH_NAMES[mo]} {yr}",
            "month_code": MONTH_CODES[mo],
            "year": yr,
            "month": mo,
            "delivery_month": f"{yr}-{mo:02d}",
            "delivery_month_label": f"{MONTH_NAMES[mo]} {yr}",
            "contract_type": "single_expiry_month",
            "expiry_month": exp.strftime("%Y-%m") if exp else None,
            "expiry": exp.isoformat() if exp else None,
        })
        if len(contracts) >= count:
            break
    return contracts


def build_contract_candidates(cfg, count=YF_CONTRACT_LOOKAHEAD):
    """
    Generates more contract candidates than the dashboard displays.
    Yahoo often drops expired or illiquid contracts; the candidate list lets
    us pick the first contracts that are actually available.
    """
    return build_contract_list(cfg, count=count)


def build_total_volume_contract_candidates(
    cfg,
    lookback_months=YF_TOTAL_VOLUME_LOOKBACK_MONTHS,
    forward_months=YF_TOTAL_VOLUME_FORWARD_MONTHS,
    max_contracts=YF_TOTAL_VOLUME_MAX_CONTRACTS,
):
    """
    Generates the contract universe used for historical total-volume bars.

    The visible futures curve only needs current/future expiries, but a 12M
    volume chart needs contracts that were active months ago. Summing only the
    current/future contracts makes older dates look almost empty because those
    contracts were far deferred at the time.
    """
    spec = CONTRACT_SPECS.get(cfg.get("_key", ""), {})
    rule = spec.get("expiry_rule")
    valid_months = cfg.get("contract_months") or []
    if not cfg.get("yf_root") or not cfg.get("yf_exchange") or not valid_months:
        return []

    start = date.today() - relativedelta(months=lookback_months)
    end = date.today() + relativedelta(months=forward_months)
    cursor = date(start.year, start.month, 1)
    contracts = []

    while cursor <= end and len(contracts) < max_contracts:
        if cursor.month in valid_months:
            exp = compute_expiry(rule, cursor.year, cursor.month) if rule else None
            contract_symbol = build_contract_symbol(cfg["yf_root"], cursor.year, cursor.month)
            chain_index = len(contracts)
            contracts.append({
                "yf_symbol": build_yf_symbol(cfg["yf_root"], cfg["yf_exchange"], cursor.year, cursor.month),
                "contract_symbol": contract_symbol,
                "chain_index": chain_index,
                "label": f"{MONTH_NAMES[cursor.month]} {cursor.year}",
                "month_code": MONTH_CODES[cursor.month],
                "year": cursor.year,
                "month": cursor.month,
                "delivery_month": f"{cursor.year}-{cursor.month:02d}",
                "delivery_month_label": f"{MONTH_NAMES[cursor.month]} {cursor.year}",
                "contract_type": "single_expiry_month",
                "expiry_month": exp.strftime("%Y-%m") if exp else None,
                "expiry": exp.isoformat() if exp else None,
            })
        cursor += relativedelta(months=1)

    return contracts


def build_contract_symbol(root, year, month):
    """
    Builds the short futures contract symbol without the Yahoo exchange suffix.
    Format:  {ROOT}{MONTHCODE}{YY}
    Example: GC + Q + 26  ->  GCQ26
    """
    code = MONTH_CODES[month]
    yy = str(year)[-2:]
    return f"{root}{code}{yy}"
