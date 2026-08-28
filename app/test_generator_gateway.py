# ── test_generator_gateway.py ── Covers three review findings on the budget branch:
#   * YahooFinanceClient._history must not cache a gateway-declined None (Task 4), and
#   * neither must quote() cache one in _quote_cache (C2), and
#   * quote() must reject a contract whose newest bar is stale (C1) — the delisted
#     filter the "10d" -> "5y" quote period silently removed.
# Run from app/:  python3 -m unittest test_generator_gateway -v
# No network: the gateway is replaced with a deliberately exhausted one via
# yahoo_gateway.configure(), and _ticker is faked so no real yfinance/HTTP call is
# ever reachable.

from __future__ import annotations

import unittest
from datetime import date, timedelta

import market_config
import yahoo_gateway as yg
from fetch_yfinance import YahooFinanceClient

try:
    import pandas as pd
except ImportError:                     # pragma: no cover - pandas ships with yfinance
    pd = None


class FakeTicker:
    """Records whether ticker.history() was actually invoked."""
    def __init__(self, result="fetched"):
        self.result = result
        self.calls = 0

    def history(self, period=None, interval=None):
        self.calls += 1
        return self.result


class HistoryCacheDoesNotMemoiseDeclinedCallsTest(unittest.TestCase):
    def setUp(self):
        # yahoo_gateway.gateway() is a process-wide singleton (yahoo_gateway._instance).
        # Save it so other tests / the rest of the process see the real one again.
        self._saved_instance = yg._instance

    def tearDown(self):
        yg._instance = self._saved_instance

    def test_declined_call_returns_none_and_is_not_cached(self):
        # capacity=0 -> try_take() always refuses -> call() returns default (None)
        # on the very first attempt, without ever invoking fn().
        yg.configure(capacity=0, refill_per_sec=0)

        client = YahooFinanceClient()
        fake = FakeTicker(result="should never be reached")
        client._ticker = lambda symbol: fake  # bypass yf entirely

        cache_key = ("GC=F", "1y", "1d")
        result = client._history("GC=F", "1y")

        self.assertIsNone(result)
        self.assertEqual(fake.calls, 0)  # bucket refused before fn() ever ran
        self.assertNotIn(cache_key, client._history_cache)

    def test_after_recovery_the_next_call_actually_fetches(self):
        # Same client, same cache_key: prove the miss above was NOT poisoned into
        # the cache, so once the budget is healthy the next call goes through and
        # its real result IS cached.
        yg.configure(capacity=0, refill_per_sec=0)

        client = YahooFinanceClient()
        fake = FakeTicker(result="recovered-history")
        client._ticker = lambda symbol: fake

        cache_key = ("GC=F", "1y", "1d")
        declined = client._history("GC=F", "1y")
        self.assertIsNone(declined)
        self.assertNotIn(cache_key, client._history_cache)

        # Budget recovers: a fresh, healthy gateway.
        yg.configure(capacity=10, refill_per_sec=10)

        recovered = client._history("GC=F", "1y")
        self.assertEqual(recovered, "recovered-history")
        self.assertEqual(fake.calls, 1)
        self.assertEqual(client._history_cache[cache_key], "recovered-history")

    def test_an_empty_but_real_result_is_still_cached(self):
        # Guard against over-correcting: ticker.history() can legitimately return an
        # empty-but-not-None result (an empty DataFrame in production); that must
        # still be cached, same as today. "" is falsy but not None, so it stands in
        # for an empty DataFrame without pulling in a pandas dependency for this test.
        yg.configure(capacity=10, refill_per_sec=10)

        client = YahooFinanceClient()
        fake = FakeTicker(result="")
        client._ticker = lambda symbol: fake

        cache_key = ("GC=F", "1y", "1d")
        result = client._history("GC=F", "1y")

        self.assertEqual(result, "")
        self.assertIn(cache_key, client._history_cache)
        self.assertEqual(client._history_cache[cache_key], "")


def _frame(days_ago_last=1, bars=30):
    """A synthetic OHLCV frame whose last bar is `days_ago_last` days old. Uniform
    volume, so _drop_unsettled_tail's low-volume rule never fires and the only thing
    under test is the date."""
    end = date.today() - timedelta(days=days_ago_last)
    idx = pd.DatetimeIndex([end - timedelta(days=n) for n in range(bars - 1, -1, -1)])
    return pd.DataFrame({
        "Open": [100.0 + i for i in range(bars)],
        "High": [101.0 + i for i in range(bars)],
        "Low": [99.0 + i for i in range(bars)],
        "Close": [100.5 + i for i in range(bars)],
        "Volume": [50000] * bars,
    }, index=idx)


class _RaisingTicker:
    """history() always fails with the given exception (no network involved)."""
    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    def history(self, period=None, interval=None):
        self.calls += 1
        raise self.exc


class QuoteCacheDoesNotMemoiseDeclinedCallsTest(unittest.TestCase):
    """C2: `hist is None` means the GATEWAY declined, not "Yahoo had no data". Caching
    BLANK for it froze a contract out of the whole run — the breaker stays open for 90 s
    after an exhausted retry, so every contract first quoted in that window was
    permanently `available: False` and dropped from the selection pass."""

    def setUp(self):
        self._saved_instance = yg._instance

    def tearDown(self):
        yg._instance = self._saved_instance

    @unittest.skipIf(pd is None, "pandas not importable in this environment")
    def test_a_declined_quote_is_not_cached_and_recovers(self):
        yg.configure(capacity=0, refill_per_sec=0)      # every take() refused
        client = YahooFinanceClient()
        fake = FakeTicker(result=_frame())
        client._ticker = lambda symbol: fake

        declined = client.quote("GCZ26.CMX")
        self.assertFalse(declined["available"])
        self.assertEqual(fake.calls, 0)                  # refused before fn() ran
        self.assertNotIn("GCZ26.CMX", client._quote_cache)

        yg.configure(capacity=10, refill_per_sec=10)     # budget recovers
        recovered = client.quote("GCZ26.CMX")
        self.assertTrue(recovered["available"])
        self.assertEqual(fake.calls, 1)
        self.assertIn("GCZ26.CMX", client._quote_cache)

    @unittest.skipIf(pd is None, "pandas not importable in this environment")
    def test_a_rate_limited_quote_is_not_cached_either(self):
        # sleep_fn is stubbed out so the gateway's 2/6/18 s backoff costs no wall clock.
        yg.configure(capacity=10, refill_per_sec=10, sleep_fn=lambda s: None,
                     rng=lambda: 0.5)
        client = YahooFinanceClient()
        client._ticker = lambda symbol: _RaisingTicker(yg.RateLimitedError("429"))

        out = client.quote("GCZ26.CMX", quiet=True)
        self.assertFalse(out["available"])
        self.assertNotIn("GCZ26.CMX", client._quote_cache)

        yg.configure(capacity=10, refill_per_sec=10)
        fake = FakeTicker(result=_frame())
        client._ticker = lambda symbol: fake
        self.assertTrue(client.quote("GCZ26.CMX")["available"])

    @unittest.skipIf(pd is None, "pandas not importable in this environment")
    def test_a_plain_error_is_still_cached(self):
        # Guard against over-correcting: a non-rate-limit failure is an answer about the
        # symbol (a parse crash, a malformed frame) and stays memoised, as before.
        yg.configure(capacity=10, refill_per_sec=10, sleep_fn=lambda s: None,
                     rng=lambda: 0.5)
        client = YahooFinanceClient()
        client._ticker = lambda symbol: _RaisingTicker(ValueError("malformed"))

        out = client.quote("GCZ26.CMX", quiet=True)
        self.assertFalse(out["available"])
        self.assertIn("GCZ26.CMX", client._quote_cache)


@unittest.skipIf(pd is None, "pandas not importable in this environment")
class QuoteRejectsStaleContractsTest(unittest.TestCase):
    """C1: with YF_QUOTE_PERIOD at "5y", a delisted contract returns its whole history
    instead of an empty frame, and used to be quoted (and badged FRONT) off a print
    months old."""

    def setUp(self):
        self._saved_instance = yg._instance
        yg.configure(capacity=10, refill_per_sec=10)
        self.client = YahooFinanceClient()

    def tearDown(self):
        yg._instance = self._saved_instance

    def _quote(self, days_ago_last):
        self.client._ticker = lambda symbol: FakeTicker(
            result=_frame(days_ago_last=days_ago_last))
        return self.client.quote("GCZ26.CMX", quiet=True)

    def test_a_dark_contract_is_blank_and_unavailable(self):
        out = self._quote(days_ago_last=60)
        self.assertFalse(out["available"])
        self.assertIsNone(out["last"])
        self.assertEqual(self.client._quote_cache["GCZ26.CMX"]["available"], False)

    def test_a_contract_at_the_staleness_limit_still_quotes(self):
        out = self._quote(days_ago_last=market_config.YF_QUOTE_MAX_STALE_DAYS)
        self.assertTrue(out["available"])

    def test_a_contract_one_day_past_the_limit_does_not(self):
        out = self._quote(days_ago_last=market_config.YF_QUOTE_MAX_STALE_DAYS + 1)
        self.assertFalse(out["available"])

    def test_a_live_contract_quotes_normally(self):
        out = self._quote(days_ago_last=1)
        self.assertTrue(out["available"])
        self.assertIsNotNone(out["last"])


if __name__ == "__main__":
    unittest.main()
