# ── test_seasonal_seasons.py ── Only long, distinct seasons count.
# The seasonal signal is one day-of-year sequence built from the four seasonal curves (screener.py),
# shared by the screener, the Weekly Outlook, the 3/3 log and the content bot. Pinned here:
#   - a season shorter than SEASONAL_MIN_SEASON_DAYS, or whose curves move less than
#     SEASONAL_MIN_SEASON_SHARE of their range, is removed whole and leaves no stub behind;
#   - a season that passes is exactly what it was without the gate, and one that a removed
#     opposite season had been cutting into gets those days back;
#   - a curve is read across Dec 31 as continuing from December, so a market's yearly drift is
#     never voted as a December season (cocoa's 5Y curve "fell" 73 points in 21 days that way).
# Run from app/:  python3 -m unittest test_seasonal_seasons -v
# No network.

from __future__ import annotations

import unittest
from datetime import date, timedelta

from screener import (
    SEASONAL_MIN_SEASON_DAYS,
    SEASONAL_MIN_SEASON_SHARE,
    _seasonal_aggregate_dir,
    _seasonal_confirmed_votes,
    _seasonal_curve_direction,
    _seasonal_distinct_curves,
    _seasonal_drop_minor_seasons,
    _seasonal_gated_sequence,
    _seasonal_runs,
    _seasonal_smear,
)

N = 365


def _curves(*ramps):
    """Four identical 365-day curves, flat at 100 except for linear ramps (start, days, points)."""
    steps = [0.0] * N
    for start, days, points in ramps:
        for i in range(start, start + days):
            steps[i] += points / days
    curve, level = [], 100.0
    for step in steps:
        curve.append(level)
        level += step
    return [list(curve) for _ in range(4)]


def _ungated(curves):
    """The sequence as it was before the season gate: flicker filter and smear only."""
    raw = [_seasonal_aggregate_dir(curves, d) for d in range(N)]
    return _seasonal_smear(_seasonal_confirmed_votes(raw))


def _quiet_new_year_rows(years=20, first_year=2005):
    """Daily bars of a market that rises 30 % from late January to December every year and drifts
    down by a fraction of a point either side of the new year: a trend with no December season."""
    rows, price = [], 100.0
    for y in range(first_year, first_year + years):
        d, last = date(y, 1, 1), price
        while d.year == y:
            if d.weekday() < 5:
                doy = min((d - date(y, 1, 1)).days, 364)
                if doy <= 20:
                    level = 100 - 0.2 * doy / 20
                elif doy <= 334:
                    level = 99.8 + 30.2 * (doy - 20) / 314
                else:
                    level = 130 - 0.3 * (doy - 334) / 30
                last = price * level / 100
                rows.append({"date": d.isoformat(), "open": last, "close": last})
            d += timedelta(days=1)
        price = last
    return rows


class SeasonGateTests(unittest.TestCase):

    def test_a_long_distinct_season_passes_untouched(self):
        curves = _curves((100, 30, 10))
        before = _ungated(curves)
        runs = _seasonal_runs(before)
        self.assertEqual(len(runs), 1)
        self.assertGreaterEqual(runs[0][1], SEASONAL_MIN_SEASON_DAYS)
        self.assertEqual(_seasonal_gated_sequence(curves), before)

    def test_a_short_season_is_removed_whole(self):
        curves = _curves((100, 14, 10))
        runs = _seasonal_runs(_ungated(curves))
        self.assertEqual(len(runs), 1)                          # the vote did see it ...
        self.assertLess(runs[0][1], SEASONAL_MIN_SEASON_DAYS)
        self.assertEqual(_seasonal_gated_sequence(curves), [0] * N)   # ... and it does not count

    def test_a_long_faint_season_is_removed(self):
        # 3 points on a curve whose range is 23: a wiggle beside the 20-point season.
        self.assertLess(3 / 23, SEASONAL_MIN_SEASON_SHARE)
        curves = _curves((50, 30, 20), (200, 40, 3))
        before = _seasonal_runs(_ungated(curves))
        self.assertEqual(len(before), 2)
        self.assertTrue(all(length >= SEASONAL_MIN_SEASON_DAYS for _, length, _ in before))
        self.assertEqual(_seasonal_runs(_seasonal_gated_sequence(curves)), [before[0]])

    def test_a_removed_season_leaves_no_stub_and_stops_cutting_its_neighbour(self):
        conf = [0] * N
        for d in range(100, 105):
            conf[d] = -1                                        # 5 bearish votes: no season
        for d in range(106, 131):
            conf[d] = 1                                         # 25 bullish votes right behind
        curves = _curves((106, 45, 10))
        before = _seasonal_smear(conf)
        self.assertEqual(before[106:108], [0, 0])               # the bearish tail cancelled them
        after = _seasonal_smear(_seasonal_drop_minor_seasons(conf, curves))
        self.assertNotIn(-1, after)
        self.assertEqual(_seasonal_runs(after), [(106, 28, 1)])


class YearEndTests(unittest.TestCase):

    def setUp(self):
        self.curves = _seasonal_distinct_curves(_quiet_new_year_rows())
        self.assertEqual(len(self.curves), 4)

    def test_the_curve_is_not_smoothed_into_the_other_end_of_the_year(self):
        for c in self.curves:
            self.assertLess(abs(c[364] - c[361]), 0.5)          # was dragged toward January's 100
            self.assertLess(abs(c[0] - c[3]), 0.5)              # and January toward December

    def test_a_trend_is_not_voted_as_a_december_season(self):
        for c in self.curves:
            for doy in range(330, N):
                self.assertNotEqual(_seasonal_curve_direction(c, doy), -1, doy)
        self.assertNotIn(-1, _seasonal_gated_sequence(self.curves))


if __name__ == "__main__":
    unittest.main()
