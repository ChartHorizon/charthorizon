# ── test_first_run_path.py ── The first run is an ordinary locked refresh with a first pass.
# No network, no real subprocess. Run from app/:
#   python3 -m unittest test_first_run_path -v

from __future__ import annotations

import os
import tempfile
import threading
import unittest
from unittest import mock

import start
import yahoo_gateway

# See test_crash_recovery.py: importing start installs the server gateway profile.
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)


class FirstPassFlagTests(unittest.TestCase):
    def _cmd(self, first_pass, frozen):
        with mock.patch.object(start, "FROZEN", frozen), \
                mock.patch.object(start.os.path, "exists", return_value=True), \
                mock.patch.object(start.subprocess, "call", return_value=0) as call:
            start._run_generator_subprocess(first_pass=first_pass)
        return call.call_args[0][0]

    def test_first_pass_flag_reaches_the_generator_command(self):
        for frozen in (False, True):
            with self.subTest(frozen=frozen):
                on = self._cmd(True, frozen)
                off = self._cmd(False, frozen)
                self.assertEqual(on[-1], "--first-pass")
                self.assertNotIn("--first-pass", off)
                if frozen:
                    self.assertEqual(on[-2:], ["--run-generator", "--first-pass"])


class FirstRunLockTests(unittest.TestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def test_first_run_holds_the_refresh_lock(self):
        release = threading.Event()
        started = threading.Event()
        seen = {}

        def fake(first_pass=False):
            seen["first_pass"] = first_pass
            started.set()
            release.wait(10)
            return 0

        try:
            with mock.patch.object(start, "_run_generator_subprocess", side_effect=fake):
                res = start.start_background_refresh("first-run", first_pass=True)
                self.assertTrue(res.get("started"))
                self.assertTrue(started.wait(5))
                self.assertTrue(os.path.exists(start.LOCK_FILE))
                prog = start._read_progress()
                self.assertEqual(prog["state"], "running")
                self.assertEqual(prog["trigger"], "first-run")
                self.assertIsNone(prog["phase"])
                self.assertEqual(prog["fronts_done"], 0)
                self.assertIsNone(prog["fronts_total"])
                self.assertTrue(seen["first_pass"])
                release.set()
                for _ in range(100):
                    if not os.path.exists(start.LOCK_FILE):
                        break
                    threading.Event().wait(0.05)
                self.assertFalse(os.path.exists(start.LOCK_FILE))
                self.assertEqual(start._read_progress()["state"], "done")
        finally:
            release.set()


class FirstRunRetryTests(unittest.TestCase):
    """The first run needs the refresh lock. When another process holds it (a genuine
    refresh, or a live pid that is not one), nothing would generate and loading.html would
    wait for a config.js that never comes, so the start is retried until it succeeds or
    the board exists."""

    ALREADY = {"running": True, "already": True}
    STARTED = {"running": True, "started": True}

    def _run(self, answers, exists):
        waits = []
        with mock.patch.object(start, "start_background_refresh",
                               side_effect=list(answers)) as kick, \
                mock.patch.object(start, "dashboard_exists", side_effect=exists), \
                mock.patch.object(start, "warn"):
            thread = start._start_first_run(retry_seconds=10, wait=waits.append)
            if thread is not None:
                thread.join(5)
                self.assertFalse(thread.is_alive())
        for call in kick.call_args_list:
            self.assertEqual(call, mock.call("first-run", first_pass=True))
        return thread, kick.call_count, waits

    def test_a_start_that_succeeds_spawns_no_retry(self):
        thread, kicks, waits = self._run([self.STARTED], exists=lambda: False)
        self.assertIsNone(thread)
        self.assertEqual((kicks, waits), (1, []))

    def test_retries_every_ten_seconds_until_a_start_succeeds(self):
        thread, kicks, waits = self._run([self.ALREADY, self.ALREADY, self.STARTED],
                                         exists=lambda: False)
        self.assertIsNotNone(thread)
        self.assertEqual((kicks, waits), (3, [10, 10]))

    def test_stops_once_the_other_run_has_written_the_board(self):
        # The other process was a genuine refresh: its config.js lands, the splash redirects.
        answers = iter([False, True])
        thread, kicks, waits = self._run([self.ALREADY], exists=lambda: next(answers))
        self.assertIsNotNone(thread)
        self.assertEqual((kicks, waits), (1, [10]))


if __name__ == "__main__":
    unittest.main()
