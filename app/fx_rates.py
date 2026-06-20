"""Central-bank policy rates for the FX strength score, fetched from the BIS.

The eight major policy rates that feed `forex.js` (FX strength score + the /fx/
"Interest rates" table) used to be a hand-edited constant. This module fetches
them once per refresh from the BIS "Central bank policy rates" dataset
(WS_CBPOL) — one free, keyless SDMX call for all eight — so the rate *values*
and their last-change dates stay current automatically.

What comes from BIS (volatile): the rate and the date of the last actual change.
What stays a static presentation map here (never changes, so not the maintenance
burden): each central bank's display name and the instrument label.

The fetch runs only in the refresh path; `parse_bis_csv` / `build_rates` are
pure and offline-testable. On any failure `fetch_fx_rates()` returns None and the
caller falls back to the previous values, so a BIS outage never breaks a refresh.

See docs/specs/2026-06-10-fx-interest-rates-auto-update-design.md.
"""
from __future__ import annotations

import csv
import io
import math
import urllib.request
from datetime import date

# Currency → BIS REF_AREA (ISO country / XM = euro area).
CURRENCY_TO_AREA = {
    "USD": "US", "GBP": "GB", "EUR": "XM", "JPY": "JP",
    "CHF": "CH", "AUD": "AU", "CAD": "CA", "NZD": "NZ",
}
AREA_TO_CURRENCY = {v: k for k, v in CURRENCY_TO_AREA.items()}

# Presentation only — names and instrument labels don't change, so they are not
# what caused the manual-edit burden. `display` is the formatting style:
#   "band"  → a ±0.125 target band around the BIS midpoint (the Fed target range)
#   "plain" → the rate as a single percentage
PRESENTATION = {
    "USD": {"centralBank": "Federal Reserve", "label": "Fed Funds Target Midpoint", "display": "band"},
    "EUR": {"centralBank": "European Central Bank", "label": "Deposit Facility Rate", "display": "plain"},
    "GBP": {"centralBank": "Bank of England", "label": "Bank Rate", "display": "plain"},
    "JPY": {"centralBank": "Bank of Japan", "label": "Overnight Call Rate", "display": "plain"},
    "CHF": {"centralBank": "Swiss National Bank", "label": "Policy Rate", "display": "plain"},
    "AUD": {"centralBank": "Reserve Bank of Australia", "label": "Cash Rate Target", "display": "plain"},
    "CAD": {"centralBank": "Bank of Canada", "label": "Overnight Target", "display": "plain"},
    "NZD": {"centralBank": "Reserve Bank of New Zealand", "label": "Official Cash Rate", "display": "plain"},
}

_BIS_BASE = "https://stats.bis.org/api/v1/data/BIS,WS_CBPOL,1.0"
# Daily series, all eight areas in one call, attributes stripped (`detail=dataonly`
# keeps the payload ~200 KB instead of ~4.5 MB). A multi-year window guarantees the
# last *change* is captured even for a bank that has held its rate for a long time.
_LOOKBACK_YEARS = 5
_USER_AGENT = "Mozilla/5.0 (ChartHorizon FX rates refresh)"


def _bis_url(today: date | None = None) -> str:
    today = today or date.today()
    areas = "+".join(CURRENCY_TO_AREA[c] for c in CURRENCY_TO_AREA)
    start = f"{today.year - _LOOKBACK_YEARS}-01-01"
    return f"{_BIS_BASE}/D.{areas}?startPeriod={start}&detail=dataonly&format=csv"


def parse_bis_csv(text: str) -> dict[str, list[tuple[str, float]]]:
    """BIS dataonly CSV → {REF_AREA: [(date, value), ...]} sorted ascending by date.

    Rows with a non-numeric OBS_VALUE (gaps) are skipped.
    """
    series: dict[str, list[tuple[str, float]]] = {}
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        area = (row.get("REF_AREA") or "").strip()
        period = (row.get("TIME_PERIOD") or "").strip()
        raw = (row.get("OBS_VALUE") or "").strip()
        if not area or not period:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        if not math.isfinite(value):  # BIS gaps come through as NaN
            continue
        series.setdefault(area, []).append((period, value))
    for obs in series.values():
        obs.sort(key=lambda dv: dv[0])
    return series


def last_change_date(obs: list[tuple[str, float]]) -> str:
    """Most recent date on which the value differed from the prior observation.

    This is "the last rate decision that moved the rate", which is what the /fx/
    table's "As of" column means — not today's daily reading. Falls back to the
    earliest available date if the value never changed within the window.
    """
    if not obs:
        return ""
    for i in range(len(obs) - 1, 0, -1):
        if obs[i][1] != obs[i - 1][1]:
            return obs[i][0]
    return obs[0][0]


def _format_display(currency: str, rate: float) -> str:
    if PRESENTATION[currency]["display"] == "band":
        return f"{rate - 0.125:.2f}-{rate + 0.125:.2f}%"
    return f"{rate:.2f}%"


def build_rates(series: dict[str, list[tuple[str, float]]]) -> dict[str, dict]:
    """Parsed BIS series → the forex.js FX_INTEREST_RATES shape, all eight required.

    Raises ValueError if any currency is missing, so the caller falls back to the
    previous values rather than scoring against an incomplete basket (the score
    normalises across whatever currencies are present).
    """
    rates: dict[str, dict] = {}
    for currency, area in CURRENCY_TO_AREA.items():
        obs = series.get(area)
        if not obs:
            raise ValueError(f"BIS response missing currency {currency} (area {area})")
        _, value = obs[-1]
        pres = PRESENTATION[currency]
        rates[currency] = {
            "rate": value,
            "display": _format_display(currency, value),
            "centralBank": pres["centralBank"],
            "label": pres["label"],
            "asOf": last_change_date(obs),
        }
    return rates


def fetch_fx_rates(timeout: float = 30.0, today: date | None = None) -> dict | None:
    """Fetch + build the eight policy rates from BIS. Returns None on any failure."""
    url = _bis_url(today)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
        rates = build_rates(parse_bis_csv(text))
        print(f"   · FX policy rates: fetched {len(rates)} from BIS")
        return rates
    except Exception as exc:  # network, HTTP, decode, parse, missing currency
        print(f"   · FX policy rates: BIS fetch failed ({exc}); keeping previous values")
        return None
