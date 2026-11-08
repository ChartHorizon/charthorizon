"""Offline tests for contract_history_cache: the shared cache file and settle cutoff."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date, datetime
from unittest import mock

import contract_history_cache as chc
import start
import yahoo_gateway

# start installs the server gateway profile on import; hand the singleton a plain one back
# (same reason as test_crash_recovery).
yahoo_gateway.configure(capacity=start.live_cache.LIVE_RATE_CAPACITY,
                        refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC)

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except ImportError:  # pragma: no cover
    from dateutil import tz
    ET = tz.gettz("America/New_York")


def _et(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=ET)


class CutoffTest(unittest.TestCase):
    def test_cutoff_matches_start_on_the_settled_eod_fixtures(self):
        cases = [
            (_et(2026, 9, 11, 17, 27), date(2026, 9, 10)),
            (_et(2026, 9, 11, 17, 30), date(2026, 9, 11)),
            (_et(2026, 9, 12, 10, 0), date(2026, 9, 11)),
            (_et(2026, 9, 7, 18, 0), date(2026, 9, 4)),
            (_et(2026, 9, 8, 9, 0), date(2026, 9, 4)),
        ]
        for now_et, expected in cases:
            self.assertEqual(chc.latest_settled_eod_date(now_et), expected)
            self.assertEqual(start._latest_settled_eod_date(now_et), expected)


class PayloadTest(unittest.TestCase):
    def test_payload_shape_matches_server(self):
        rows = [{"date": "2026-09-11", "close": 1.0}]
        payload = chc.build_payload("ZCZ26.CBT", "5y", rows, date(2026, 9, 11), 1.0)
        self.assertEqual(set(payload), {"symbol", "period", "source", "contract_type",
                                        "history", "settled_through", "fetched_at"})
        self.assertEqual(payload["settled_through"], "2026-09-11")
        self.assertEqual(payload["source"], "yfinance")
        self.assertEqual(payload["contract_type"], "single_expiry_month")

    def test_failed_replace_returns_false_and_leaves_no_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = chc.cache_path("ZCZ26.CBT", "5y", data_dir=tmp)
            ok = chc.write_payload(path, {"history": []},
                                   replace=mock.Mock(side_effect=PermissionError))
            self.assertFalse(ok)
            self.assertEqual(os.listdir(os.path.dirname(path)), [])

    def test_server_reads_what_write_payload_wrote(self):
        symbol = "ZCZ26.CBT"
        now = _et(2026, 9, 11, 18, 0)
        rows = [{"date": "2026-09-11", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 5}]
        payload = chc.build_payload(symbol, "5y", rows, date(2026, 9, 11), now.timestamp())
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                self.assertTrue(chc.write_payload(chc.cache_path(symbol, "5y"), payload))
                with mock.patch.object(start, "_eastern_now", return_value=now), \
                        mock.patch.object(start, "_history_rows",
                                          side_effect=AssertionError("refetched")):
                    self.assertEqual(start.get_contract_history(symbol, "5y"), payload)
            finally:
                os.chdir(old)

    def test_out_of_date_file_goes_to_a_click_but_never_to_preload(self):
        # During a refresh the gateway declines every preload request, so the refetch of an
        # out-of-date file comes back empty. A preload answer is stored on the contract and a
        # later click reuses it without asking; it must be empty, never the old file.
        symbol = "ZCZ26.CBT"
        now = _et(2026, 9, 11, 18, 0)                     # settled session: 2026-09-11
        rows = [{"date": "2026-09-10", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 5}]
        stored = chc.build_payload(symbol, "5y", rows, date(2026, 9, 10),
                                   now.timestamp() - 86400)
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                path = chc.cache_path(symbol, "5y")
                self.assertTrue(chc.write_payload(path, stored))
                with mock.patch.object(start, "_eastern_now", return_value=now), \
                        mock.patch.object(start, "_history_rows", return_value=[]) as rows_:
                    preload = start.get_contract_history(
                        symbol, "5y", priority=yahoo_gateway.PRIORITY_PRELOAD)
                    click = start.get_contract_history(symbol, "5y")
                self.assertEqual(rows_.call_count, 2)     # both tried to refetch
                self.assertEqual(preload["history"], [])
                self.assertEqual(preload["settled_through"], "2026-09-11")
                self.assertEqual(click, stored)           # an older chart beats a blank one
                with open(path, encoding="utf-8") as f:
                    self.assertEqual(json.load(f), stored)  # neither answer touched the file
            finally:
                os.chdir(old)

    def test_prune_removes_only_files_older_than_seven_days(self):
        import time
        now = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            old = chc.cache_path("OLD.CBT", "5y", data_dir=tmp)
            fresh = chc.cache_path("NEW.CBT", "5y", data_dir=tmp)
            os.makedirs(os.path.dirname(old))
            for path, age_days in ((old, 8), (fresh, 6)):
                with open(path, "w") as f:
                    f.write("{}")
                os.utime(path, (now - age_days * 86400, now - age_days * 86400))
            self.assertEqual(chc.prune(now_ts=now, data_dir=tmp), 1)
            self.assertFalse(os.path.exists(old))
            self.assertTrue(os.path.exists(fresh))

    def test_prune_removes_orphaned_temps_older_than_an_hour(self):
        import time
        now = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = os.path.dirname(chc.cache_path("X.CBT", "5y", data_dir=tmp))
            os.makedirs(cache_dir)
            ages = {".ch_old.tmp": 2 * 3600, ".ch_live.tmp": 60, "notes.tmp": 2 * 3600}
            for name, age in ages.items():
                path = os.path.join(cache_dir, name)
                with open(path, "w") as f:
                    f.write("{")
                os.utime(path, (now - age, now - age))
            self.assertEqual(chc.prune(now_ts=now, data_dir=tmp), 1)
            # A writer's own temp is minutes old at most; only the killed writer's goes.
            self.assertEqual(sorted(os.listdir(cache_dir)), [".ch_live.tmp", "notes.tmp"])

    def test_prune_missing_dir_returns_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(chc.prune(data_dir=tmp), 0)

    def test_locked_refresh_keeps_current_cache_files(self):
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                path = chc.cache_path("ZCZ26.CBT", "5y")
                self.assertTrue(chc.write_payload(path, {"history": []}))
                self.assertTrue(start.acquire_refresh_lock("test"))
                with mock.patch.object(start, "_run_generator_subprocess", return_value=0):
                    start._run_locked_refresh()
                self.assertTrue(os.path.exists(path))
            finally:
                os.chdir(old)


FRI, MON = date(2026, 11, 6), date(2026, 11, 9)


def _answer(complete_for=FRI, fetched=None, expiry=None, history=None):
    """A generator-written file: Yahoo's complete answer as of the settle `complete_for`."""
    fetched = fetched or _et(2026, 11, 7, 3, 0)          # Saturday night, NY time
    return chc.build_payload("CLF27.NYM", "5y", history if history is not None else [],
                             complete_for, fetched.timestamp(),
                             complete_for=complete_for, expiry=expiry)


class CompleteAnswerTest(unittest.TestCase):
    """is_complete_answer: may the generator take this file instead of asking Yahoo?"""

    def test_an_answer_fetched_after_its_session_serves_the_same_settle(self):
        self.assertTrue(chc.is_complete_answer(_answer(), FRI))

    def test_an_answer_asked_on_the_session_day_itself_is_asked_again(self):
        # 23:45 CET on Friday is 17:45 ET: a just-settled bar Yahoo may still correct.
        evening = _answer(fetched=_et(2026, 11, 6, 17, 45))
        self.assertFalse(chc.is_complete_answer(evening, FRI))

    def test_a_new_settle_is_always_asked_for(self):
        self.assertFalse(chc.is_complete_answer(_answer(), MON))

    def test_a_server_file_is_never_taken(self):
        server = chc.build_payload("CLF27.NYM", "5y", [], FRI, _et(2026, 11, 7, 3, 0).timestamp())
        self.assertNotIn("complete_for", server)
        self.assertFalse(chc.is_complete_answer(server, FRI))

    def test_an_expired_contract_keeps_its_answer_across_settles(self):
        expired = _answer(expiry="2026-10-20")
        self.assertTrue(chc.is_complete_answer(expired, MON))
        self.assertTrue(chc.is_complete_answer(expired, date(2026, 12, 18)))

    def test_a_contract_expired_only_days_before_is_asked_again(self):
        # Within EXPIRED_SETTLE_DAYS of its last trading day Yahoo may still be correcting it.
        just_expired = _answer(expiry="2026-11-02")
        self.assertFalse(chc.is_complete_answer(just_expired, MON))
        self.assertTrue(chc.is_complete_answer(just_expired, FRI))   # its own settle still is

    def test_a_contract_still_trading_is_not_expired(self):
        self.assertFalse(chc.is_complete_answer(_answer(expiry="2026-12-18"), MON))

    def test_malformed_files_are_asked_again(self):
        good = _answer()
        broken = [None, [], "x",
                  dict(good, history=None),
                  dict(good, complete_for="not a date"),
                  dict(good, fetched_at=None),
                  dict(good, fetched_at="soon")]
        for payload in broken:
            with self.subTest(payload=payload):
                self.assertFalse(chc.is_complete_answer(payload, FRI))

    def test_a_short_answer_carries_no_server_stamp(self):
        # Rows that stop before the settle: the server must refetch it at once (null stamp),
        # the generator may still take it as Yahoo's whole answer for that settle.
        rows = [{"date": "2026-11-04", "close": 1.0}]
        short = chc.build_payload("CLF28.NYM", "5y", rows, None, _et(2026, 11, 7, 3, 0).timestamp(),
                                  complete_for=FRI)
        self.assertIsNone(short["settled_through"])
        self.assertTrue(chc.is_complete_answer(short, FRI))
        self.assertFalse(start._contract_history_is_current(
            short, FRI, _et(2026, 11, 7, 3, 1).timestamp()))

    def test_payload_names_its_contract_type(self):
        cont = chc.build_payload("CL=F", "20y", [], FRI, 1.0, contract_type="continuous_front_month")
        self.assertEqual(cont["contract_type"], "continuous_front_month")


class KeepTest(unittest.TestCase):
    def test_keep_refreshes_the_mtime_prune_reads(self):
        import time
        now = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            path = chc.cache_path("OLD.CBT", "5y", data_dir=tmp)
            os.makedirs(os.path.dirname(path))
            with open(path, "w") as f:
                f.write("{}")
            os.utime(path, (now - 8 * 86400, now - 8 * 86400))
            chc.keep(path)
            self.assertEqual(chc.prune(now_ts=now, data_dir=tmp), 0)
            self.assertTrue(os.path.exists(path))

    def test_keep_never_raises(self):
        chc.keep("/nonexistent/dir/file.json")


if __name__ == "__main__":
    unittest.main()
