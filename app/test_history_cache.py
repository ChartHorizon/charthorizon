# ── test_history_cache.py ── The run cache must serve a short request from a longer
# cached frame, so the same contract is never fetched from Yahoo twice in one refresh.
# Run from app/:  python3 -m unittest test_history_cache -v
# No network: the client's _ticker is replaced with a recording fake.

from __future__ import annotations

import unittest
from datetime import datetime, timedelta

import pandas as pd

import fetch_yfinance as fy


def _frame(days):
    idx = pd.date_range(end=datetime(2026, 8, 21), periods=days, freq="D")
    return pd.DataFrame(
        {"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": 100},
        index=idx,
    )


class FakeTicker:
    def __init__(self, recorder, days=1830):
        self._rec = recorder
        self._days = days
    def history(self, period, interval="1d"):
        self._rec.append(period)
        return _frame(self._days)


class SupersetCacheTest(unittest.TestCase):
    def setUp(self):
        self.fetched = []
        self.client = fy.YahooFinanceClient()
        self.client._ticker = lambda symbol: FakeTicker(self.fetched)

    def test_a_shorter_period_is_served_from_a_longer_cached_frame(self):
        self.client._history("GCZ26.CMX", period="5y")
        self.assertEqual(self.fetched, ["5y"])
        out = self.client._history("GCZ26.CMX", period="10d")
        self.assertEqual(self.fetched, ["5y"])            # no second Yahoo call
        self.assertEqual(len(out), 11)                    # sliced to exactly the window
                                                            # (freq="D", no gaps: 10-day
                                                            # cutoff -> 11 inclusive rows)

    def test_an_unknown_period_string_falls_through_to_a_real_fetch(self):
        # "1wk" is a valid yfinance period but absent from _PERIOD_DAYS, so
        # _cached_superset must decline (return None) rather than guess, and the
        # exact-key cache path still fetches for real.
        self.client._history("GCZ26.CMX", period="5y")
        self.client._history("GCZ26.CMX", period="1wk")
        self.assertEqual(self.fetched, ["5y", "1wk"])

    def test_an_empty_cached_frame_is_not_treated_as_a_qualifying_superset(self):
        # An empty frame cached under a longer period (e.g. Yahoo genuinely had no
        # data) must not be silently handed back for a shorter request as if it were
        # a valid slice — _cached_superset returns it as-is (still empty), and the
        # caller (_history) does not cache it, so the next request tries again.
        empty = _frame(0)
        self.client._history_cache[("GCZ26.CMX", "5y", "1d")] = empty
        out = self.client._cached_superset("GCZ26.CMX", "10d", "1d")
        self.assertTrue(out.empty)
        self.assertEqual(self.fetched, [])                # no Yahoo call happened at all

    def test_a_longer_period_is_not_served_from_a_shorter_frame(self):
        self.client._history("GCZ26.CMX", period="10d")
        self.client._history("GCZ26.CMX", period="5y")
        self.assertEqual(self.fetched, ["10d", "5y"])     # must go to Yahoo

    def test_a_different_symbol_is_never_reused(self):
        self.client._history("GCZ26.CMX", period="5y")
        self.client._history("SIU26.CMX", period="10d")
        self.assertEqual(self.fetched, ["5y", "10d"])

    def test_a_different_interval_is_never_reused(self):
        self.client._history("GCZ26.CMX", period="5y", interval="1d")
        self.client._history("GCZ26.CMX", period="10d", interval="1h")
        self.assertEqual(self.fetched, ["5y", "10d"])


class QuoteSharesTheScanFetchTest(unittest.TestCase):
    def test_quote_and_chart_history_cost_one_request_together(self):
        fetched = []
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: FakeTicker(fetched)
        client.quote("GCZ26.CMX")                          # runs first, as in the generator
        client.chart_history("GCZ26.CMX", period="5y")
        self.assertEqual(len(fetched), 1,
                         "quote() and chart_history() must share one cache entry")


if __name__ == "__main__":
    unittest.main()
