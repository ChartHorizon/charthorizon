# ── test_seasonal_rolls.py ── Seasonal curves without the native =F roll gaps.
# Yahoo's `=F` continuous switches contract on the same calendar every year, so the jump between
# two contracts lands on the same day-of-year every year and the seasonal average reads it as a
# season (lean hogs: 10x the normal overnight gap on its roll day). The generator marks those bars
# (mark_seasonal_roll_days) and every seasonal curve takes the overnight gap out of them.
# Also covered: a year with a multi-week hole is not a seasonal year, and the yearly seasonal
# refresh gate must survive data_quality.json sitting among the category files.
# Run from app/:  python3 -m unittest test_seasonal_rolls -v
# No network.

from __future__ import annotations

import bisect
import json
import os
import shutil
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

import fetch_yfinance
from calendar_utils import compute_expiry
from market_config import COMMODITIES, CONTRACT_SPECS
from screener import _seasonal_distinct_curves, _seasonal_window_curve, mark_seasonal_roll_days

SUGAR = dict(COMMODITIES["sugar"])     # expires on the last business day before the delivery month


def _business_days(start, end):
    d, out = start, []
    while d <= end:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _sugar_anchors(days):
    """Index of the first bar after each scheduled sugar expiry."""
    rule = CONTRACT_SPECS["sugar"]["expiry_rule"]
    out = []
    for y in range(int(days[0][:4]), int(days[-1][:4]) + 1):
        for m in SUGAR["contract_months"]:
            i = bisect.bisect_right(days, compute_expiry(rule, y, m).isoformat())
            if 0 < i < len(days):
                out.append(i)
    return out


def _series(days, roll_at=(), jump=0.05):
    """OHLC rows with a +/-0.2 % overnight gap every day and a `jump` gap on each index in roll_at."""
    rows, close, roll_at = [], 100.0, set(roll_at)
    for i, d in enumerate(days):
        gap = jump if i in roll_at else (0.002 if i % 2 else -0.002)
        open_ = close * (1 + gap)
        close = open_ * (1.001 if i % 3 else 0.999)
        rows.append({"date": d, "open": open_, "high": max(open_, close), "low": min(open_, close),
                     "close": close, "volume": 1000})
    return rows


def _marked(rows):
    return {i for i, r in enumerate(rows) if r.get("roll")}


class MarkSeasonalRollDaysTest(unittest.TestCase):
    DAYS = _business_days(date(2015, 1, 1), date(2020, 12, 31))

    def test_the_bar_after_each_expiry_is_marked_when_the_gap_spikes_there(self):
        anchors = _sugar_anchors(self.DAYS)
        marked = mark_seasonal_roll_days("sugar", SUGAR, _series(self.DAYS, roll_at=anchors))
        self.assertEqual(_marked(marked), set(anchors))

    def test_a_roll_one_session_before_the_calendar_is_found_there(self):
        # The ICE softs and the Treasury futures roll one session before the scheduled expiry.
        before = [i - 1 for i in _sugar_anchors(self.DAYS)]
        marked = mark_seasonal_roll_days("sugar", SUGAR, _series(self.DAYS, roll_at=before))
        self.assertEqual(_marked(marked), set(before))

    def test_no_gap_spike_marks_nothing(self):
        # Gold, silver, copper, cotton: no roll gap stands out, so the series is left alone.
        self.assertEqual(_marked(mark_seasonal_roll_days("sugar", SUGAR, _series(self.DAYS))), set())

    def test_the_input_rows_are_never_modified(self):
        rows = _series(self.DAYS, roll_at=_sugar_anchors(self.DAYS))
        before = json.dumps(rows)
        mark_seasonal_roll_days("sugar", SUGAR, rows)
        self.assertEqual(json.dumps(rows), before)

    def test_a_stale_mark_from_an_earlier_refresh_is_dropped(self):
        rows = _series(self.DAYS)
        rows[10] = dict(rows[10], roll=True)
        self.assertEqual(_marked(mark_seasonal_roll_days("sugar", SUGAR, rows)), set())

    def test_a_market_without_an_expiry_calendar_is_left_alone(self):
        rows = _series(self.DAYS, roll_at=_sugar_anchors(self.DAYS))
        cfg = {"contract_months": SUGAR["contract_months"]}
        self.assertEqual(_marked(mark_seasonal_roll_days("no_such_market", cfg, rows)), set())


class RollAdjustedCurvesTest(unittest.TestCase):
    @staticmethod
    def _years_with_a_july_step(mark):
        """22 flat years whose price opens 20 % higher on the first session of July, every year."""
        days = _business_days(date(2004, 1, 1), date(2025, 12, 31))
        rows, close = [], 100.0
        for i, d in enumerate(days):
            step = d[5:] >= "07-01" and days[i - 1][5:] < "07-01" if i else False
            open_ = close * (1.2 if step else 1.0)
            close = open_
            row = {"date": d, "open": open_, "high": open_, "low": open_, "close": close}
            if step and mark:
                row["roll"] = True
            rows.append(row)
        return rows

    def test_a_marked_roll_gap_does_not_step_the_curve(self):
        curves = _seasonal_distinct_curves(self._years_with_a_july_step(mark=True))
        self.assertEqual(len(curves), 4)
        for curve in curves:
            self.assertLess(max(curve) - min(curve), 0.01)

    def test_the_same_gap_unmarked_is_exactly_the_artefact_being_removed(self):
        for curve in _seasonal_distinct_curves(self._years_with_a_july_step(mark=False)):
            self.assertGreater(max(curve) - min(curve), 15)


class GappyYearsTest(unittest.TestCase):
    DAYS = _business_days(date(2019, 1, 1), date(2024, 12, 31))

    def test_a_year_with_a_multi_week_hole_is_not_a_seasonal_year(self):
        # Platinum 2006-2007: 63-day holes, flat-filled into a season that never traded.
        rows = [(d, 100.0 + i * 0.01) for i, d in enumerate(self.DAYS)
                if not ("2021-03-01" <= d <= "2021-04-15")]
        self.assertEqual(_seasonal_window_curve(rows, 6, 2024)[1], 5)

    def test_a_closure_of_a_week_or_so_does_not(self):
        rows = [(d, 100.0 + i * 0.01) for i, d in enumerate(self.DAYS)
                if not ("2020-09-11" <= d <= "2020-09-18")]
        self.assertEqual(_seasonal_window_curve(rows, 6, 2024)[1], 6)


class SeasonalRefreshGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        fetch_yfinance._existing_seasonal_years = None

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        fetch_yfinance._existing_seasonal_years = None

    def _write(self, name, payload):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def test_data_quality_json_does_not_hide_the_markets_listed_after_it(self):
        # data_quality.json matches data_*.json and carries plain strings at its top level. The
        # loop raised on the first one and skipped every file listed after it, so those markets
        # pulled their whole seasonal history again on every refresh.
        year = date.today().year
        self._write("data_quality.json", {"generated_at": f"{year}-09-11T22:17:05", "policy": "x", "markets": {}})
        for name, key in (("data_energy.json", "wti_crude"), ("data_softs.json", "sugar")):
            self._write(name, {key: {"continuous_contract": {
                "seasonal_history": [{"date": f"{year}-06-01", "close": 1.0}]}}})
        order = ["data_quality.json", "data_energy.json", "data_softs.json"]
        with mock.patch.object(fetch_yfinance.os, "listdir", return_value=order):
            for key in ("wti_crude", "sugar"):
                self.assertEqual(fetch_yfinance._cached_seasonal_last_year(key, self.dir), year)
                self.assertFalse(fetch_yfinance._should_refresh_seasonal(key, self.dir))


if __name__ == "__main__":
    unittest.main()
