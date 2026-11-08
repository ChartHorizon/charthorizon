# ── test_first_run_path.py ── The first run is an ordinary locked refresh with a first pass.
# No network, no real subprocess. Run from app/:
#   python3 -m unittest test_first_run_path -v

from __future__ import annotations

import contextlib
import io
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
    def _cmd(self, first_pass, frozen, fresh=False):
        with mock.patch.object(start, "FROZEN", frozen), \
                mock.patch.object(start.os.path, "exists", return_value=True), \
                mock.patch.object(start.subprocess, "call", return_value=0) as call:
            start._run_generator_subprocess(first_pass=first_pass, fresh=fresh)
        return call.call_args[0][0]

    def test_fresh_flag_reaches_the_generator_command(self):
        for frozen in (False, True):
            with self.subTest(frozen=frozen):
                self.assertEqual(self._cmd(False, frozen, fresh=True)[-1], "--fresh")
                self.assertNotIn("--fresh", self._cmd(False, frozen))
                if frozen:
                    self.assertEqual(self._cmd(False, frozen, fresh=True)[-2:],
                                     ["--run-generator", "--fresh"])

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
                res = start.start_background_refresh("first-run", first_run=True)
                self.assertTrue(res.get("started"))
                self.assertTrue(started.wait(5))
                self.assertTrue(os.path.exists(start.LOCK_FILE))
                prog = start._read_progress()
                self.assertEqual(prog["state"], "running")
                self.assertEqual(prog["trigger"], "first-run")
                self.assertIsNone(prog["phase"])
                self.assertEqual(prog["fronts_done"], 0)
                self.assertIsNone(prog["fronts_total"])
                # The previous run's first-pass stamp must not read as this run's.
                self.assertIsNone(prog["first_pass_version"])
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

    def test_a_lock_that_cannot_be_written_is_not_reported_as_held(self):
        # A directory where the lock file belongs: nothing holds the lock, yet it cannot be
        # written. That used to answer "already", and the first run then waited for good on
        # a refresh that did not exist.
        os.makedirs(start.LOCK_FILE)
        # The run itself is mocked out, not just the generator: a regression that started
        # the thread would otherwise let it write progress and release the lock relative
        # to whatever cwd it finds — after tearDown, that is the real app/ff_data.
        with mock.patch.object(start, "_run_locked_refresh") as run:
            res = start.start_background_refresh("first-run", first_run=True)
        self.assertEqual(res, {"running": False, "error": "lock-write-failed"})
        run.assert_not_called()
        self.assertIsNone(start._read_progress())

    def test_a_first_run_that_finds_the_board_under_the_lock_does_not_run(self):
        # Another process finished the board between the caller's check and this start.
        # Holding the lock, no refresh is writing, so the board seen now is a finished one:
        # the first run's job is done, and a second refresh straight after it is redundant.
        with mock.patch.object(start, "dashboard_exists", return_value=True), \
                mock.patch.object(start, "_run_locked_refresh") as run:
            res = start.start_background_refresh("first-run", first_run=True)
        self.assertEqual(res, {"running": False, "board": True})
        run.assert_not_called()
        self.assertFalse(os.path.exists(start.LOCK_FILE))
        self.assertIsNone(start._read_progress())

    def test_an_ordinary_refresh_still_runs_over_an_existing_board(self):
        done = threading.Event()
        with mock.patch.object(start, "dashboard_exists", return_value=True), \
                mock.patch.object(start, "_run_generator_subprocess",
                                  side_effect=lambda first_pass=False: done.set() or 0):
            res = start.start_background_refresh("auto")
            self.assertTrue(res.get("started"))
            self.assertTrue(done.wait(5))
            self._wait_unlocked()
        self.assertFalse(os.path.exists(start.LOCK_FILE))

    def _wait_unlocked(self):
        for _ in range(100):
            if not os.path.exists(start.LOCK_FILE):
                break
            threading.Event().wait(0.05)

    def test_every_background_refresh_writes_a_first_pass(self):
        # A background refresh always has a page open on the previous board, so the
        # generator puts the front months on it first and fetches the rest behind them.
        for trigger in ("auto", "manual"):
            with self.subTest(trigger=trigger):
                seen = []
                done = threading.Event()

                def fake(first_pass=False):
                    seen.append(first_pass)
                    done.set()
                    return 0
                with mock.patch.object(start, "dashboard_exists", return_value=True), \
                        mock.patch.object(start, "_run_generator_subprocess",
                                          side_effect=fake):
                    self.assertTrue(start.start_background_refresh(trigger).get("started"))
                    self.assertTrue(done.wait(5))
                    self._wait_unlocked()
                self.assertEqual(seen, [True])

    def test_the_foreground_refresh_writes_no_first_pass(self):
        # --refresh, and the 23:30 job's --refresh --no-serve, finish before any page is
        # open: an early board would be written for nobody.
        os.makedirs("ff_data")
        with open(os.path.join("ff_data", "config.js"), "w", encoding="utf-8") as f:
            f.write("window.__CONFIG__ = {};\n")
        with mock.patch.object(start, "DATA_ROOT", os.getcwd()), \
                mock.patch.object(start, "_run_generator_subprocess", return_value=0) as run, \
                contextlib.redirect_stdout(io.StringIO()):
            start.foreground_refresh()
            start.foreground_refresh(fresh=True)
        self.assertEqual(run.call_args_list, [mock.call(fresh=False), mock.call(fresh=True)])


class FirstRunErrorStatusTests(unittest.TestCase):
    """A first run whose start keeps failing tells the splash so, instead of a spinner."""

    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def test_a_failing_first_run_reads_as_error(self):
        with mock.patch.object(start, "_first_run_error", "lock-write-failed"):
            status = start.refresh_status_payload()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"], "lock-write-failed")
        self.assertFalse(status["running"])

    def test_a_live_refresh_is_never_overlaid(self):
        self.assertTrue(start.acquire_refresh_lock("first-run"))
        try:
            start._write_progress(state="running")
            with mock.patch.object(start, "_first_run_error", "spawn-failed"):
                status = start.refresh_status_payload()
        finally:
            start.release_refresh_lock()
        self.assertEqual(status["state"], "running")
        self.assertTrue(status["running"])

    def test_no_first_run_error_leaves_the_status_alone(self):
        with mock.patch.object(start, "_first_run_error", None):
            self.assertEqual(start.refresh_status_payload()["state"], "idle")


class FirstRunRetryTests(unittest.TestCase):
    """The first run needs the refresh lock. When another process holds it (a genuine
    refresh, or a live pid that is not one), nothing would generate and loading.html would
    wait for a config.js that never comes, so the start is retried until it succeeds or
    the board exists."""

    ALREADY = {"running": True, "already": True}
    STARTED = {"running": True, "started": True}
    BOARD = {"running": False, "board": True}
    SPAWN_FAILED = {"running": False, "error": "spawn-failed"}
    LOCK_FAILED = {"running": False, "error": "lock-write-failed"}

    def _run(self, answers, exists, seen=None):
        waits = []

        def wait(seconds):
            waits.append(seconds)
            if seen is not None:
                seen.append(start._first_run_error)

        with mock.patch.object(start, "start_background_refresh",
                               side_effect=list(answers)) as kick, \
                mock.patch.object(start, "dashboard_exists", side_effect=exists), \
                mock.patch.object(start, "_first_run_error", None), \
                mock.patch.object(start, "warn"):
            thread = start._start_first_run(retry_seconds=10, wait=wait)
            if thread is not None:
                thread.join(5)
                self.assertFalse(thread.is_alive())
            self.final_error = start._first_run_error
        for call in kick.call_args_list:
            self.assertEqual(call, mock.call("first-run", first_run=True))
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

    def test_a_failed_spawn_is_retried_too(self):
        # Only "already" used to start the retry: a spawn-failed first start left the splash
        # waiting for a config.js nothing would write.
        thread, kicks, waits = self._run([self.SPAWN_FAILED, self.STARTED],
                                         exists=lambda: False)
        self.assertIsNotNone(thread)
        self.assertEqual((kicks, waits), (2, [10]))

    def test_a_failed_lock_write_is_retried(self):
        thread, kicks, waits = self._run([self.ALREADY, self.LOCK_FAILED, self.STARTED],
                                         exists=lambda: False)
        self.assertEqual((kicks, waits), (3, [10, 10]))

    def test_a_board_found_under_the_lock_ends_the_first_run(self):
        thread, kicks, waits = self._run([self.BOARD], exists=lambda: False)
        self.assertIsNone(thread)
        self.assertEqual((kicks, waits), (1, []))

    def test_a_retry_that_finds_the_board_under_the_lock_stops(self):
        # The other run finished between this loop's check and its start: the start itself
        # sees the board (it checks under the lock) and nothing redundant is spawned.
        thread, kicks, waits = self._run([self.ALREADY, self.BOARD], exists=lambda: False)
        self.assertEqual((kicks, waits), (2, [10]))

    def test_a_start_that_keeps_failing_reaches_the_splash_and_clears_on_success(self):
        seen = []
        answers = [self.SPAWN_FAILED] * start.FIRST_RUN_ERROR_AFTER + [self.STARTED]
        thread, kicks, waits = self._run(answers, exists=lambda: False, seen=seen)
        self.assertEqual(kicks, start.FIRST_RUN_ERROR_AFTER + 1)
        # Seen at each wait, i.e. after 1, 2, … failed starts.
        expected = [None] * (start.FIRST_RUN_ERROR_AFTER - 1) + ["spawn-failed"]
        self.assertEqual(seen, expected)
        self.assertIsNone(self.final_error)

    def test_a_held_lock_is_not_a_failure(self):
        # Waiting on a genuine refresh elsewhere is the normal case and must never read as
        # an error, and it resets the count of failed starts in a row.
        seen = []
        n = start.FIRST_RUN_ERROR_AFTER
        answers = ([self.SPAWN_FAILED] * (n - 1) + [self.ALREADY]
                   + [self.SPAWN_FAILED] * (n - 1) + [self.STARTED])
        self._run(answers, exists=lambda: False, seen=seen)
        self.assertEqual(set(seen), {None})



class MainBranchTests(unittest.TestCase):
    """Which start path main() takes, for every combination of flags and data on disk.

    Each case names what must happen AND what must not: a warm start that also took the
    first-run path would put a second refresh on the lock, and a first run that kicked the
    "auto" refresh instead would open index.html on an empty data folder."""

    ACTIONS = ("foreground_refresh", "generate_dashboard", "_start_first_run",
               "start_background_refresh", "serve")

    def _main(self, argv, board, frozen=False, unsafe=False):
        mocks = {}
        with contextlib.ExitStack() as stack:
            for name in self.ACTIONS + ("check_python", "ensure_packages",
                                        "_relocate_from_unsafe_location"):
                mocks[name] = stack.enter_context(mock.patch.object(start, name))
            stack.enter_context(mock.patch.object(start, "dashboard_exists",
                                                  return_value=board))
            stack.enter_context(mock.patch.object(start, "_running_from_unsafe_location",
                                                  return_value=unsafe))
            stack.enter_context(mock.patch.object(start, "FROZEN", frozen))
            stack.enter_context(mock.patch.object(start, "HTML_FILE", "index.html"))
            stack.enter_context(mock.patch.object(start.os, "chdir"))
            stack.enter_context(mock.patch.object(start.sys, "argv", ["start.py"] + argv))
            run_gen = stack.enter_context(mock.patch("commodity_dashboard.run_generator"))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            start.main()
            html = start.HTML_FILE
        called = {name for name in self.ACTIONS if mocks[name].called}
        return called, mocks, html, run_gen, mocks["check_python"].called

    def test_warm_start_serves_and_kicks_the_auto_refresh(self):
        called, m, html, _, _ = self._main([], board=True)
        self.assertEqual(called, {"start_background_refresh", "serve"})
        m["start_background_refresh"].assert_called_once_with("auto")
        m["serve"].assert_called_once_with(open_browser=True)
        self.assertEqual(html, "index.html")

    def test_no_browser_only_keeps_the_browser_shut(self):
        called, m, _, _, _ = self._main(["--no-browser"], board=True)
        self.assertEqual(called, {"start_background_refresh", "serve"})
        m["serve"].assert_called_once_with(open_browser=False)

    def test_first_run_opens_the_splash_and_starts_the_first_run(self):
        called, m, html, _, _ = self._main([], board=False)
        self.assertEqual(called, {"_start_first_run", "serve"})
        self.assertEqual(html, "loading.html")

    def test_data_only_first_run_generates_in_the_foreground(self):
        called, _, html, _, _ = self._main(["--no-serve"], board=False)
        self.assertEqual(called, {"generate_dashboard"})
        self.assertEqual(html, "index.html")

    def test_data_only_with_a_board_does_nothing(self):
        # No --refresh: the existing files are used as they are, nothing is fetched.
        called, _, _, _, _ = self._main(["--no-serve"], board=True)
        self.assertEqual(called, set())

    def test_refresh_serves_without_a_second_refresh(self):
        for board in (True, False):
            with self.subTest(board=board):
                called, _, html, _, _ = self._main(["--refresh"], board=board)
                self.assertEqual(called, {"foreground_refresh", "serve"})
                self.assertEqual(html, "index.html")

    def test_the_nightly_job_refreshes_and_stops(self):
        # ops/daily-update.sh runs exactly this. It reads back what an earlier run kept for
        # the same settle, like every refresh; only --force-refresh asks for all of it again.
        called, m, _, _, _ = self._main(["--refresh", "--no-serve"], board=True)
        self.assertEqual(called, {"foreground_refresh"})
        m["foreground_refresh"].assert_called_once_with(fresh=False)

    def test_force_refresh_asks_yahoo_for_everything_again(self):
        for argv in (["--refresh", "--force-refresh", "--no-serve"],
                     ["--force-refresh", "--no-serve"]):
            with self.subTest(argv=argv):
                called, m, _, _, _ = self._main(argv, board=True)
                self.assertEqual(called, {"foreground_refresh"})
                m["foreground_refresh"].assert_called_once_with(fresh=True)

    def test_force_refresh_then_serves_without_a_second_refresh(self):
        called, _, html, _, _ = self._main(["--force-refresh"], board=True)
        self.assertEqual(called, {"foreground_refresh", "serve"})
        self.assertEqual(html, "index.html")

    def test_run_generator_is_the_frozen_generator_and_nothing_else(self):
        for argv, first_pass, fresh in ((["--run-generator"], False, False),
                                        (["--run-generator", "--first-pass"], True, False),
                                        (["--run-generator", "--fresh"], False, True)):
            with self.subTest(argv=argv):
                called, _, _, run_gen, checked = self._main(argv, board=False, frozen=True)
                run_gen.assert_called_once_with(first_pass, fresh=fresh)
                self.assertEqual(called, set())
                self.assertFalse(checked)

    def test_a_translocated_mac_launch_only_offers_to_move(self):
        with mock.patch.object(start.sys, "platform", "darwin"):
            called, m, _, _, checked = self._main([], board=True, frozen=True, unsafe=True)
        self.assertEqual(called, set())
        m["_relocate_from_unsafe_location"].assert_called_once_with()
        self.assertFalse(checked)


if __name__ == "__main__":
    unittest.main()
