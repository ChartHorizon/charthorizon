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


if __name__ == "__main__":
    unittest.main()
