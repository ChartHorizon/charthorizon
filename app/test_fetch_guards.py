# ── test_fetch_guards.py ── The three chart_history() callers OUTSIDE the dead-symbol
# scan (main chart, seasonal history, total-volume) must degrade sanely on a gateway
# decline instead of raising. Without their guards, an uncaught RateLimitedError would
# propagate through _gather_one_market() and ThreadPoolExecutor.map() and abort the
# ENTIRE threaded refresh, not just skip one contract — these are the crash path.
# Run from app/:  python3 -m unittest test_fetch_guards -v
# No network: the gateway is deliberately exhausted (capacity=0) via
# yahoo_gateway.configure(), same fixture as test_dead_symbols.py's decline tests.

from __future__ import annotations

import unittest

import fetch_yfinance as fy
import yahoo_gateway as yg


class _UnreachableTicker:
    """If the gateway budget logic is correct, history() is never called on a
    decline (try_take refuses before fn() runs) -- so calling it here is a test
    bug, not a network access, hence the hard failure."""
    def history(self, period=None, interval=None):
        raise AssertionError("ticker.history() must never be reached on a gateway decline")


@unittest.skipIf(fy.yf is None, "yfinance not importable in this environment")
class GuardedCallSitesDoNotCrashOnDeclineTest(unittest.TestCase):
    def setUp(self):
        self._saved_instance = yg._instance
        yg.configure(capacity=0, refill_per_sec=0)   # every take() is refused outright
        # fetch_chart_history/fetch_seasonal_price_history always go through the
        # module-level thread-local _yf_client singleton, not a fresh client, so the
        # ticker override has to land on the real per-thread client instance.
        self._client = fy._yf_client._client()
        self._saved_ticker = self._client._ticker
        self._client._ticker = lambda symbol: _UnreachableTicker()

    def tearDown(self):
        self._client._ticker = self._saved_ticker
        yg._instance = self._saved_instance

    def test_fetch_chart_history_returns_empty_on_a_decline(self):
        # Main per-market chart fetch: runs for every market on every refresh.
        self.assertEqual(fy.fetch_chart_history("GCZ26.CMX", period="5y"), [])

    def test_fetch_price_chart_history_degrades_the_same_way(self):
        cfg = {"yf_continuous": "GCZ26.CMX"}
        symbol, history = fy.fetch_price_chart_history(cfg)
        self.assertEqual(symbol, "GCZ26.CMX")
        self.assertEqual(history, [])

    def test_fetch_seasonal_price_history_returns_the_fallback_on_a_decline(self):
        cfg = {"yf_continuous": "GCZ26.CMX"}
        fallback = [{"date": "2020-01-01", "close": 1.0}] * 300
        self.assertEqual(fy.fetch_seasonal_price_history(cfg, fallback), fallback)

    def test_fetch_seasonal_price_history_returns_empty_with_no_fallback(self):
        cfg = {"yf_continuous": "GCZ26.CMX"}
        self.assertEqual(fy.fetch_seasonal_price_history(cfg, None), [])

    def test_total_volume_series_skips_a_declined_contract_and_returns_empty(self):
        cfg = {
            "yf_root": "GC", "yf_exchange": "CMX",
            "contract_months": [2, 4, 6, 8, 10, 12],
            "chart_format": "single_contract",
        }
        self.assertEqual(fy.fetch_yfinance_total_volume_series(cfg), [])


if __name__ == "__main__":
    unittest.main()
