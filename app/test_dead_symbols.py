# ── test_dead_symbols.py ── The memo of delisted contract symbols. Pure and file-backed;
# no network, no yfinance. Run from app/:  python3 -m unittest test_dead_symbols -v
#
# The two refusal rules are the whole point of this module and each has a scar behind it:
# memoizing a rate-limited symbol would turn a transient outage into permanent missing
# data, and memoizing a not-yet-listed month would cost the calendar spread its deferred
# leg (see _contract_is_pre_active_for_day in fetch_yfinance.py).

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date

import dead_symbols as ds
import fetch_yfinance as fy
import yahoo_gateway as yg

TODAY = date(2026, 8, 22)


class RecordEmptyTest(unittest.TestCase):
    def test_an_expired_contract_that_returned_nothing_is_memoized(self):
        memo = {}
        self.assertTrue(ds.record_empty(memo, "BTCQ25.CME", "2025-08-29", TODAY))
        self.assertTrue(ds.is_dead(memo, "BTCQ25.CME", TODAY))

    def test_a_future_expiry_is_never_memoized(self):
        # Not listed YET is not dead — it trades later, and the calendar spread's
        # deferred leg depends on exactly these months.
        memo = {}
        self.assertFalse(ds.record_empty(memo, "BTCF28.CME", "2028-01-31", TODAY))
        self.assertFalse(ds.is_dead(memo, "BTCF28.CME", TODAY))

    def test_a_missing_or_unparseable_expiry_is_never_memoized(self):
        memo = {}
        self.assertFalse(ds.record_empty(memo, "X.CME", None, TODAY))
        self.assertFalse(ds.record_empty(memo, "Y.CME", "not-a-date", TODAY))
        self.assertEqual(memo, {})

    def test_an_expiry_today_is_not_yet_dead(self):
        memo = {}
        self.assertFalse(ds.record_empty(memo, "Z.CME", "2026-08-22", TODAY))


class ReprobeTest(unittest.TestCase):
    def test_the_memo_expires_so_a_restored_symbol_comes_back(self):
        memo = {}
        ds.record_empty(memo, "BTCQ25.CME", "2025-08-29", TODAY)
        later = date(2026, 9, 20)                 # 29 days on — still dead
        self.assertTrue(ds.is_dead(memo, "BTCQ25.CME", later))
        much_later = date(2026, 9, 22)            # 31 days on — re-probe
        self.assertFalse(ds.is_dead(memo, "BTCQ25.CME", much_later))

    def test_an_entry_exactly_reprobe_days_old_is_reprobed(self):
        # REPROBE_DAYS=30 is a TTL from the day the entry was confirmed: it stays
        # dead for the 30 days after confirmation and re-probes exactly ON day 30,
        # mirroring record_empty's own boundary rule (expiry == today is "not yet
        # past", refused; here age == REPROBE_DAYS is "no longer within the grace
        # window", so it must re-probe rather than stay memoized one day longer).
        memo = {}
        ds.record_empty(memo, "BTCQ25.CME", "2025-08-29", TODAY)
        boundary = date(2026, 9, 21)              # exactly 30 days after TODAY
        self.assertEqual((boundary - TODAY).days, ds.REPROBE_DAYS)
        self.assertFalse(ds.is_dead(memo, "BTCQ25.CME", boundary))
        one_day_short = date(2026, 9, 20)         # exactly 29 days after TODAY
        self.assertTrue(ds.is_dead(memo, "BTCQ25.CME", one_day_short))

    def test_an_unknown_symbol_is_never_dead(self):
        self.assertFalse(ds.is_dead({}, "ANYTHING.CME", TODAY))


class PersistenceTest(unittest.TestCase):
    def test_round_trip(self):
        path = os.path.join(tempfile.mkdtemp(), "yf_dead_symbols.json")
        memo = {}
        ds.record_empty(memo, "BTCQ25.CME", "2025-08-29", TODAY)
        ds.save(path, memo)
        self.assertEqual(ds.load(path), memo)

    def test_a_missing_file_loads_as_empty(self):
        path = os.path.join(tempfile.mkdtemp(), "nope.json")
        self.assertEqual(ds.load(path), {})

    def test_a_corrupt_file_loads_as_empty_rather_than_raising(self):
        path = os.path.join(tempfile.mkdtemp(), "bad.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertEqual(ds.load(path), {})

    def test_save_is_atomic_and_leaves_no_temp_files(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "yf_dead_symbols.json")
        ds.save(path, {"A.CME": {"confirmed": "2026-08-22"}})
        self.assertEqual(os.listdir(d), ["yf_dead_symbols.json"])


class ScanSkipTest(unittest.TestCase):
    """The scan must skip a memoized symbol without issuing a request, and must record
    a fresh one only when the request came back successful-and-empty."""

    def setUp(self):
        import fetch_yfinance as fy
        self.fy = fy
        self._saved = dict(fy._dead_memo)
        fy._dead_memo.clear()

    def tearDown(self):
        self.fy._dead_memo.clear()
        self.fy._dead_memo.update(self._saved)

    def test_a_memoized_symbol_is_not_requested(self):
        ds.record_empty(self.fy._dead_memo, "BTCQ25.CME", "2025-08-29", TODAY)
        self.assertTrue(self.fy._skip_dead_contract(
            {"yf_symbol": "BTCQ25.CME", "expiry": "2025-08-29"}, TODAY))

    def test_a_live_symbol_is_requested(self):
        self.assertFalse(self.fy._skip_dead_contract(
            {"yf_symbol": "BTCZ26.CME", "expiry": "2026-12-31"}, TODAY))

    def test_an_empty_result_on_an_expired_contract_is_recorded(self):
        self.fy._note_contract_result(
            {"yf_symbol": "BTCQ25.CME", "expiry": "2025-08-29"}, rows=[], today=TODAY)
        self.assertTrue(ds.is_dead(self.fy._dead_memo, "BTCQ25.CME", TODAY))

    def test_a_non_empty_result_clears_any_stale_entry(self):
        ds.record_empty(self.fy._dead_memo, "BTCQ25.CME", "2025-08-29", TODAY)
        self.fy._note_contract_result(
            {"yf_symbol": "BTCQ25.CME", "expiry": "2025-08-29"},
            rows=[{"date": "2025-08-01"}], today=TODAY)
        self.assertFalse(ds.is_dead(self.fy._dead_memo, "BTCQ25.CME", TODAY))


class _UnreachableTicker:
    """Stands in for yf.Ticker: if the gateway budget/breaker logic is correct, its
    history() is never called on a decline (try_take refuses before fn() runs), so
    calling it here is a test bug, not a network access — hence the hard failure
    rather than any HTTP-shaped fake."""
    def history(self, period=None, interval=None):
        raise AssertionError("ticker.history() must never be reached on a gateway decline")


def _mirror_scan_loop(client, fy_module, contract, today):
    """Reproduces the exact shape of the scan loop in
    fetch_yfinance_liquid_continuous_history: skip check, chart_history with
    raise_errors=True, a wide `except Exception` (a real 429 normalises to
    RateLimitedError at the gateway now, but ANY other transient error must be
    caught the same way), and _note_contract_result gated on the breaker being
    closed. Returns `rows` (None on failure) so callers can assert on it."""
    if fy_module._skip_dead_contract(contract, today):
        return None
    try:
        rows = client.chart_history(contract["yf_symbol"], period="5y",
                                     quiet=True, raise_errors=True)
    except Exception:
        return None
    if not yg.gateway().cooldown_active():
        fy_module._note_contract_result(contract, rows, today=today)
    return rows


@unittest.skipIf(fy.yf is None, "yfinance not importable in this environment")
class DeclineIsNotAPurgedContractTest(unittest.TestCase):
    """The single most important rule in this task: a gateway DECLINE (token bucket
    exhausted or circuit breaker open) is ordinary steady-state throttling, not Yahoo
    saying anything about the contract, and must never be memoized as purged. Both a
    decline and a real empty contract look like "no rows" to a caller that only checks
    truthiness — chart_history's `hist is None` vs `hist.empty` split (and the
    RateLimitedError re-raise) is what keeps them apart. This test drives that split
    with an actually-exhausted gateway rather than a mock, so a future refactor that
    re-collapses the two paths fails here first."""

    def setUp(self):
        self.fy = fy
        self._saved_memo = dict(fy._dead_memo)
        fy._dead_memo.clear()
        self._saved_instance = yg._instance
        yg.configure(capacity=0, refill_per_sec=0)   # every take() is refused outright

    def tearDown(self):
        fy._dead_memo.clear()
        fy._dead_memo.update(self._saved_memo)
        yg._instance = self._saved_instance

    def test_a_declined_fetch_raises_instead_of_returning_empty(self):
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: _UnreachableTicker()
        with self.assertRaises(yg.RateLimitedError):
            client.chart_history("BTCQ25.CME", period="5y", quiet=True)

    def test_a_declined_contract_is_never_memoized(self):
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: _UnreachableTicker()
        contract = {"yf_symbol": "BTCQ25.CME", "expiry": "2025-08-29"}
        rows = _mirror_scan_loop(client, fy, contract, TODAY)
        self.assertIsNone(rows)
        self.assertNotIn("BTCQ25.CME", fy._dead_memo)
        self.assertFalse(ds.is_dead(fy._dead_memo, "BTCQ25.CME", TODAY))


class _BrokenTicker:
    """A ticker whose history() blows up with an ordinary transient error — a DNS
    blip or a connection reset, NOT anything rate-limit-shaped."""
    def history(self, period=None, interval=None):
        raise RuntimeError("Connection reset by peer")


@unittest.skipIf(fy.yf is None, "yfinance not importable in this environment")
class TransientErrorIsNotMemoizedTest(unittest.TestCase):
    """The general case behind the rate-limit-specific one above: a plain transient
    error (DNS blip, connection reset, a parse crash) on an EXPIRED contract must not
    be memoized as purged either — only a request that genuinely SUCCEEDED with zero
    rows may write to the memo. `raise_errors=True` is what lets the scan loop tell
    "the fetch failed" apart from "the fetch succeeded and found nothing"; the other
    three chart_history() callers keep the old raise_errors=False default and still
    just swallow this into `[]`, which this test also pins so the two behaviours
    don't drift apart."""

    def setUp(self):
        self.fy = fy
        self._saved_memo = dict(fy._dead_memo)
        fy._dead_memo.clear()
        self._saved_instance = yg._instance
        # Ample budget: the failure must come from the fetch itself, not the gateway
        # declining, and must not be left able to pollute the shared singleton for
        # later tests (a fresh instance is installed either way). sleep_fn is a no-op
        # so the retry backoff (up to 2+6+18s) doesn't actually slow the test down.
        yg.configure(capacity=20, refill_per_sec=20, sleep_fn=lambda seconds: None)

    def tearDown(self):
        fy._dead_memo.clear()
        fy._dead_memo.update(self._saved_memo)
        yg._instance = self._saved_instance

    def test_raise_errors_false_still_swallows_it_as_before(self):
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: _BrokenTicker()
        self.assertEqual(client.chart_history("BTCQ25.CME", quiet=True), [])

    def test_raise_errors_true_lets_the_scan_loop_see_the_failure(self):
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: _BrokenTicker()
        with self.assertRaises(RuntimeError):
            client.chart_history("BTCQ25.CME", quiet=True, raise_errors=True)

    def test_a_transient_error_on_an_expired_contract_is_never_memoized(self):
        client = fy.YahooFinanceClient()
        client._ticker = lambda symbol: _BrokenTicker()
        contract = {"yf_symbol": "BTCQ25.CME", "expiry": "2025-08-29"}
        rows = _mirror_scan_loop(client, fy, contract, TODAY)
        self.assertIsNone(rows)
        self.assertNotIn("BTCQ25.CME", fy._dead_memo)
        self.assertFalse(ds.is_dead(fy._dead_memo, "BTCQ25.CME", TODAY))


if __name__ == "__main__":
    unittest.main()
