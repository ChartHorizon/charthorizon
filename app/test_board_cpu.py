"""Offline tests for what generate_html spends its CPU on, and for the answers staying the same.

Once a settle's Yahoo answers are read back from disk (see test_cache_reuse), a refresh is
mostly generate_html: 11.6 s measured on the 2026-11-08 board. Two things in it did the same
work more than once, and one did it the slow way:
  - the nine category files went through json.dump, which never takes the C encoder (only
    json.dumps does): 2.8 s against 0.7 s, byte for byte the same text;
  - every market's seasonal curves were built for the screener and again for the 3/3 log;
  - the seasonal vote measured each curve's yearly range again on each of its 365 days.

No network, no running app: every fixture is built here.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import os
import tempfile
import unittest
from unittest import mock

import commodity_dashboard as cd
import fetch_yfinance as fy
import fx_rates
import screener
from market_config import COMMODITIES
from test_three_three_log import _cot_series, _drop_window_dates, _seasonal_history

KEYS = ["gold", "corn"]


def _entry(key):
    """One market as the gather hands it to generate_html: 20 years of a bearish season, the
    last two of them as the price history, a COT series and a short spread series."""
    seasonal = _seasonal_history()
    history = [dict(r, open=r["close"], high=r["close"], low=r["close"], volume=1000)
               for r in seasonal[-520:]]
    return {
        "config": dict(COMMODITIES[key]),
        "contracts": [],
        "continuous_contract": {"history": history, "seasonal_history": seasonal,
                                "total_volume_series": []},
        "cot_series": _cot_series(history[-1]["date"]),
        "calendar_spread_series": [{"date": r["date"], "spread": -1.5} for r in history[-10:]],
    }


class _BoardBase(unittest.TestCase):
    """Temp cwd, BIS and the progress file patched out, the seasonal-year cache from nothing."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cwd = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, cwd)
        for target, name, value in ((fx_rates, "fetch_fx_rates", lambda: {}),
                                    (fy, "_existing_seasonal_years", None),
                                    (cd, "_write_refresh_progress", lambda **kw: None)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def generate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            cd.generate_html({k: _entry(k) for k in KEYS})


class BoardEncodingTest(_BoardBase):
    def test_no_file_generate_html_writes_goes_through_json_dump(self):
        with mock.patch.object(json, "dump", wraps=json.dump) as dump:
            self.generate()
        self.assertFalse(dump.called, "json.dump never takes the C encoder; write json.dumps")

    def test_the_files_hold_the_text_json_dump_wrote(self):
        self.generate()
        names = [n for n in os.listdir("ff_data") if n.endswith(".json")]
        self.assertTrue({"screener.json", "data_quality.json", "three_three_log.json"} <= set(names))
        for name in names:
            with self.subTest(name=name):
                with open(os.path.join("ff_data", name), encoding="utf-8") as f:
                    text = f.read()
                old = io.StringIO()
                indent = 2 if name == "three_three_log.json" else None
                json.dump(json.loads(text), old, ensure_ascii=False, indent=indent)
                self.assertEqual(text, old.getvalue())


class SeasonalCurvesOnceTest(_BoardBase):
    def test_each_market_s_curves_are_built_once_per_run(self):
        with mock.patch.object(screener, "_seasonal_distinct_curves",
                               wraps=screener._seasonal_distinct_curves) as built:
            self.generate()
        self.assertEqual(built.call_count, len(KEYS))


def _by_cat():
    """Two markets: the bearish season and one with too little history for the vote."""
    bearish = _entry("gold")
    thin = _entry("corn")
    thin["continuous_contract"]["seasonal_history"] = _seasonal_history(years=3)
    return {"Metals": {"gold": {**bearish, "display_name": "Gold"}},
            "Agriculture": {"corn": {**thin, "display_name": "Corn"}}}


class SharedCurvesTest(unittest.TestCase):
    """The curves handed in are the ones each function would have built: same rows, same log."""

    def test_the_screener_rows_do_not_change(self):
        by_cat = _by_cat()
        curves = screener.seasonal_curves_by_market(by_cat)
        self.assertEqual(set(curves), {"gold", "corn"})
        self.assertEqual(screener.build_screener_summary(by_cat, seasonal_curves=curves),
                         screener.build_screener_summary(by_cat))

    def test_the_log_does_not_change_runway_included(self):
        by_cat = _by_cat()
        today = _drop_window_dates()[-1]           # inside the bearish season: a runway
        rows = [{"key": "gold", "score": -3}, {"key": "corn", "score": 0}]
        shared = screener.build_three_three_log(
            by_cat, rows, previous={}, today=today,
            seasonal_curves=screener.seasonal_curves_by_market(by_cat))
        self.assertIn("runway", shared["gold"])
        self.assertEqual(shared, screener.build_three_three_log(by_cat, rows, previous={},
                                                                today=today))

    def test_a_market_missing_from_the_map_builds_its_own(self):
        by_cat = _by_cat()
        self.assertEqual(screener.build_screener_summary(by_cat, seasonal_curves={}),
                         screener.build_screener_summary(by_cat))


def _wave(phase, amp=5.0, drift=0.0):
    return [100 + amp * math.sin(2 * math.pi * (d + phase) / 365) + drift * d / 365
            for d in range(365)]


class GatedSequenceTest(unittest.TestCase):
    """_seasonal_gated_sequence is the per-day vote of _seasonal_aggregate_dir, gated."""

    def _per_day(self, curves):
        raw = [screener._seasonal_aggregate_dir(curves, d) for d in range(365)]
        return screener._seasonal_smear(screener._seasonal_drop_minor_seasons(
            screener._seasonal_confirmed_votes(raw), curves))

    def test_the_sequence_is_the_per_day_vote(self):
        cases = {
            "one bearish season": screener._seasonal_distinct_curves(_seasonal_history()),
            "waves out of step": [_wave(0), _wave(8), _wave(16), _wave(120)],
            "trending into the year end": [_wave(0, drift=8), _wave(5, drift=6),
                                           _wave(9, drift=9), _wave(3, drift=7)],
            "one curve too flat to vote": [_wave(0), _wave(4), _wave(8), _wave(0, amp=0.2)],
        }
        for name, curves in cases.items():
            with self.subTest(name):
                self.assertEqual(len(curves), 4)
                seq = screener._seasonal_gated_sequence(curves)
                self.assertEqual(seq, self._per_day(curves))
                self.assertTrue(any(seq))            # every case has a season to compare


if __name__ == "__main__":
    unittest.main()
