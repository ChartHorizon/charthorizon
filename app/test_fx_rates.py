"""Offline tests for the BIS policy-rate parser/builder. No network."""
from __future__ import annotations

import pytest

import fx_rates

# A tiny dataonly-shaped fixture: all eight areas, a few daily obs each. US and AU
# change value mid-window (exercises last_change_date); the rest hold.
FIXTURE_CSV = """FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE
D,US,2026-05-30,3.875
D,US,2026-05-31,3.875
D,US,2026-06-01,3.625
D,US,2026-06-02,3.625
D,XM,2026-06-01,2.0
D,XM,2026-06-02,2.0
D,GB,2026-06-01,3.75
D,GB,2026-06-02,3.75
D,JP,2026-06-01,0.75
D,JP,2026-06-02,0.75
D,CH,2026-06-01,0
D,CH,2026-06-02,0
D,AU,2026-05-05,4.10
D,AU,2026-05-06,4.35
D,AU,2026-05-28,4.35
D,CA,2026-06-01,2.25
D,NZ,2026-05-29,2.25
"""


def test_parse_groups_and_sorts():
    series = fx_rates.parse_bis_csv(FIXTURE_CSV)
    assert set(series) == {"US", "XM", "GB", "JP", "CH", "AU", "CA", "NZ"}
    assert series["US"] == [
        ("2026-05-30", 3.875), ("2026-05-31", 3.875),
        ("2026-06-01", 3.625), ("2026-06-02", 3.625),
    ]


def test_parse_skips_non_numeric():
    series = fx_rates.parse_bis_csv("FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nD,US,2026-06-01,NaN\nD,US,2026-06-02,3.5\n")
    assert series["US"] == [("2026-06-02", 3.5)]


def test_last_change_date_on_move():
    series = fx_rates.parse_bis_csv(FIXTURE_CSV)
    assert fx_rates.last_change_date(series["US"]) == "2026-06-01"
    assert fx_rates.last_change_date(series["AU"]) == "2026-05-06"


def test_last_change_date_when_never_changed():
    obs = [("2026-06-01", 2.25), ("2026-06-02", 2.25)]
    assert fx_rates.last_change_date(obs) == "2026-06-01"  # falls back to earliest


def test_build_rates_all_eight_with_provenance():
    rates = fx_rates.build_rates(fx_rates.parse_bis_csv(FIXTURE_CSV))
    assert set(rates) == set(fx_rates.CURRENCY_TO_AREA)
    # latest value + computed last-change date
    assert rates["USD"]["rate"] == 3.625
    assert rates["USD"]["asOf"] == "2026-06-01"
    # USD uses the target-band display; others are plain
    assert rates["USD"]["display"] == "3.50-3.75%"
    assert rates["EUR"]["display"] == "2.00%"
    # EUR adopts the BIS deposit-facility semantics
    assert rates["EUR"]["rate"] == 2.0
    assert rates["EUR"]["label"] == "Deposit Facility Rate"
    assert rates["EUR"]["centralBank"] == "European Central Bank"


def test_build_rates_raises_when_currency_missing():
    series = fx_rates.parse_bis_csv(FIXTURE_CSV)
    del series["JP"]
    with pytest.raises(ValueError):
        fx_rates.build_rates(series)


def test_fetch_returns_none_on_network_error(monkeypatch):
    def boom(*a, **k):
        raise OSError("no network in tests")
    monkeypatch.setattr(fx_rates.urllib.request, "urlopen", boom)
    assert fx_rates.fetch_fx_rates() is None
