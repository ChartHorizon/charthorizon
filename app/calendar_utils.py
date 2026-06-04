"""Exchange-calendar logic: US market holidays, business days, contract expiry, roll dates.

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
from market_config import CONTRACT_SPECS, MONTH_CODES
from series_utils import _coerce_iso_date

__all__ = [
    '_add_business_days',
    '_business_day_before',
    '_easter',
    '_holiday_cache',
    '_is_business_day',
    '_last_business_day_of_month',
    '_nth_last_business_day_of_month',
    '_nth_weekday',
    '_observed',
    '_prev_month',
    '_us_market_holidays',
    'build_roll_dates',
    'compute_expiry',
]



# ─────────────────────────────────────────────────────────────────────
#  US EXCHANGE HOLIDAYS (CME/NYSE) - without external libraries
# ─────────────────────────────────────────────────────────────────────
#  Fixed US exchange holiday rules. Good Friday is exchange-relevant
#  (equities/many futures closed) and is added via the Easter calculation.
#  The calendar is calculated per year and cached.
# ─────────────────────────────────────────────────────────────────────
_holiday_cache = {}


def _nth_weekday(year, month, weekday, n):
    """nth occurrence of a weekday in a month (weekday: Mon=0...Sun=6). n=-1 -> last."""
    if n > 0:
        d = date(year, month, 1)
        offset = (weekday - d.weekday()) % 7
        return d + timedelta(days=offset + (n - 1) * 7)
    # last occurrence
    if month == 12:
        d = date(year, 12, 31)
    else:
        d = date(year, month + 1, 1) - timedelta(days=1)
    offset = (d.weekday() - weekday) % 7
    return d - timedelta(days=offset)


def _observed(d):
    """If a holiday falls on Sat -> previous Fri, on Sun -> following Mon (US rule)."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def _easter(year):
    """Easter Sunday (Gauss/Anonymous algorithm)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _us_market_holidays(year):
    """Calculates US exchange holidays (CME/NYSE) for one year."""
    if year in _holiday_cache:
        return _holiday_cache[year]
    hols = set()
    hols.add(_observed(date(year, 1, 1)))                 # New Year's Day
    hols.add(_nth_weekday(year, 1, 0, 3))                 # MLK Day (3. Mo Jan)
    hols.add(_nth_weekday(year, 2, 0, 3))                 # Presidents' Day (3. Mo Feb)
    hols.add(_easter(year) - timedelta(days=2))           # Good Friday
    hols.add(_nth_weekday(year, 5, 0, -1))                # Memorial Day (last Mon in May)
    hols.add(_observed(date(year, 6, 19)))                # Juneteenth
    hols.add(_observed(date(year, 7, 4)))                 # Independence Day
    hols.add(_nth_weekday(year, 9, 0, 1))                 # Labor Day (1. Mo Sep)
    hols.add(_nth_weekday(year, 11, 3, 4))                # Thanksgiving (4. Do Nov)
    hols.add(_observed(date(year, 12, 25)))               # Christmas
    _holiday_cache[year] = hols
    return hols


# ─────────────────────────────────────────────────────────────────────
#  VERFALLSDATUM-BERECHNUNG
#  Weekends and US exchange holidays are considered.
#  Shortened trading days such as the day after Thanksgiving count as
#   normal trading days, which matches last-trading-day practice.)
# ─────────────────────────────────────────────────────────────────────
def _is_business_day(d):
    return d.weekday() < 5 and d not in _us_market_holidays(d.year)


def _add_business_days(d, n):
    step = 1 if n >= 0 else -1
    remaining = abs(n)
    cur = d
    while remaining > 0:
        cur = cur + timedelta(days=step)
        if _is_business_day(cur):
            remaining -= 1
    return cur


def _last_business_day_of_month(year, month):
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    d = nxt - timedelta(days=1)
    while not _is_business_day(d):
        d -= timedelta(days=1)
    return d


def _nth_last_business_day_of_month(year, month, n):
    return _add_business_days(_last_business_day_of_month(year, month), -(n - 1))


def _business_day_before(d):
    cur = d - timedelta(days=1)
    while not _is_business_day(cur):
        cur -= timedelta(days=1)
    return cur


def _prev_month(year, month, k=1):
    m, y = month - k, year
    while m <= 0:
        m += 12
        y -= 1
    return y, m


def compute_expiry(rule, year, month):
    """Calculates the concrete last trading date of a contract (year/month = delivery month)."""
    if not rule:
        return None
    kind = rule.get("kind")
    p = rule.get("params", {})
    if kind == "nth_last_bd_of_delivery":
        return _nth_last_business_day_of_month(year, month, p.get("n", 3))
    if kind == "nth_bd_of_delivery":
        # nth business day from the start of the month, for example Lean Hogs.
        d = date(year, month, 1)
        if not _is_business_day(d):
            d = _add_business_days(d, 1)
        return _add_business_days(d, p.get("n", 1) - 1)
    if kind == "nth_weekday_of_delivery":
        # nth weekday occurrence, for example the third Friday for index expiry.
        wd = _nth_weekday(year, month, p.get("weekday", 4), p.get("n", 3))
        # if it is a holiday: previous business day
        while not _is_business_day(wd):
            wd = _business_day_before(wd)
        return wd
    if kind == "bd_before_third_wednesday":
        # n business days before the third Wednesday (FX futures, USDX)
        third_wed = _nth_weekday(year, month, 2, 3)  # Mittwoch = 2
        return _add_business_days(third_wed, -p.get("n", 2))
    if kind == "bd_before_25th_prev_month":
        py, pm = _prev_month(year, month, 1)
        return _add_business_days(date(py, pm, 25), -p.get("n", 3))
    if kind == "bd_before_1st_of_delivery":
        return _add_business_days(date(year, month, 1), -p.get("n", 3))
    if kind == "bd_before_15th_of_delivery":
        return _business_day_before(date(year, month, 15))
    if kind == "last_bd_of_prev_month":
        py, pm = _prev_month(year, month, p.get("k", 1))
        return _last_business_day_of_month(py, pm)
    if kind == "bd_before_last_notice":
        lnd = _nth_last_business_day_of_month(year, month, p.get("bd_before_eom", 7))
        return _business_day_before(lnd)
    return None


def build_roll_dates(key, cfg, history, forward_days=60):
    """Scheduled front-month roll/expiry dates for the native continuous chart.

    Deterministic from the exchange calendar (``contract_months`` + ``expiry_rule``
    via ``compute_expiry``) — NOT detected from Yahoo's opaque continuous. A marker
    therefore sits at the contract's last trading day and may differ by a few days
    from where the native ``=F`` line actually rolled (Yahoo's roll point is unknown).
    Only markets that carry an ``expiry_rule`` get markers; the rest return empty.

    Returns ``[{"date": "YYYY-MM-DD", "code": "M26"}, ...]`` spanning the supplied
    history plus a small forward buffer (so the next upcoming roll near the right edge
    still shows), sorted ascending.
    """
    rule = CONTRACT_SPECS.get(key, {}).get("expiry_rule")
    months = cfg.get("contract_months") or []
    if not rule or not months:
        return []
    days = []
    for row in history or []:
        d = _coerce_iso_date(row.get("date"))
        if d:
            days.append(d)
    if not days:
        return []
    d0, d1 = min(days), max(days) + timedelta(days=forward_days)
    months = sorted(set(months))
    out = []
    for year in range(d0.year, d1.year + 1):
        for m in months:
            exp = compute_expiry(rule, year, m)
            if exp and d0 <= exp <= d1:
                out.append({"date": exp.isoformat(), "code": f"{MONTH_CODES[m]}{year % 100:02d}"})
    out.sort(key=lambda r: r["date"])
    return out
