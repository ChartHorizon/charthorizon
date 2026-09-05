# ── test_crash_recovery.py ── A refresh killed mid-flight must not wedge the app.
#
# The 1.2.2 Windows build could be left unstartable by one interrupted refresh, along
# three joined paths:
#
#   1. _pid_alive() probed with os.kill(pid, 0). On Windows that is not a probe at all:
#      signal 0 is CTRL_C_EVENT, so CPython routes it into GenerateConsoleCtrlEvent
#      (it SIGNALS a console process group), and every other signal value goes to
#      TerminateProcess. For a foreign pid both fail with OSError, which the old code
#      read as "alive" — so a stale refresh.lock never expired before LOCK_MAX_AGE and
#      the app could not start the refresh that would have repaired it.
#   2. The generator wrote data_<cat>.json / screener.json / config.js through bare
#      open(..., "w"), which truncates on open. A kill mid-write left a half file.
#   3. dashboard_exists() only asked whether config.js EXISTS, so a truncated one
#      counted as "data present" and the app never regenerated it. The frontend then
#      died on window.__CONFIG__.index before any module was defined.
#
# Windows is the platform this breaks on and the one that cannot be exercised here, so
# the pid tests assert the invariant (os.kill is never reached, the probe only asks)
# rather than the symptom. Run from app/:
#   python3 -m unittest test_crash_recovery -v
# No network, no subprocesses.

from __future__ import annotations

import inspect
import json
import re
import os
import socketserver
import tempfile
import unittest
from unittest import mock

import commodity_dashboard as cd
import start
import yahoo_gateway

# Importing start.py installs the SERVER gateway profile as the process-wide singleton,
# and that profile points lock_path at the real ff_data/refresh.lock. Every test module
# is imported before any test runs, so whichever profile is installed last is the one the
# whole suite inherits — and while an actual refresh is in flight, the gateway stands down
# to interactive-only and six unrelated tests in test_history_cache fail with no Yahoo
# call recorded. Hand the singleton back a plain profile so the suite's result never
# depends on whether the dashboard happens to be refreshing next to it.
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)


class _ExplodingKill:
    """Stands in for os.kill and fails the test if anything reaches it."""

    def __init__(self):
        self.calls = []

    def __call__(self, pid, sig):
        self.calls.append((pid, sig))
        raise AssertionError(
            "os.kill(%r, %r) reached on Windows — it signals a process group there, "
            "it does not probe" % (pid, sig)
        )


class _FakeKernel32:
    """Minimal kernel32 stand-in: OpenProcess -> handle or 0 + a last-error code."""

    ACCESS_DENIED = 5
    INVALID_PARAMETER = 87

    def __init__(self, handle, last_error=0):
        self._handle = handle
        self._last_error = last_error
        self.opened = []
        self.closed = []

    def OpenProcess(self, access, inherit, pid):
        self.opened.append((access, inherit, pid))
        return self._handle

    def CloseHandle(self, handle):
        self.closed.append(handle)
        return 1

    def last_error(self):
        return self._last_error


class PidLivenessTests(unittest.TestCase):
    """The lock's liveness probe: it must ASK whether a pid exists, never signal it."""

    def test_windows_never_calls_os_kill(self):
        exploding = _ExplodingKill()
        with mock.patch.object(start.sys, "platform", "win32"), \
             mock.patch.object(start.os, "kill", exploding), \
             mock.patch.object(start, "_pid_alive_windows", return_value=True):
            self.assertTrue(start._pid_alive(4242))
        self.assertEqual(exploding.calls, [])

    def test_windows_probe_reports_a_free_pid_as_dead(self):
        # OpenProcess fails with ERROR_INVALID_PARAMETER: no process owns that pid.
        # The old code turned this into "alive" and wedged the lock for LOCK_MAX_AGE.
        k32 = _FakeKernel32(handle=0, last_error=_FakeKernel32.INVALID_PARAMETER)
        self.assertFalse(start._pid_alive_windows(4242, kernel32=k32))

    def test_windows_probe_reports_a_live_pid_as_alive(self):
        k32 = _FakeKernel32(handle=1234)
        self.assertTrue(start._pid_alive_windows(4242, kernel32=k32))
        self.assertEqual(k32.closed, [1234], "the probe must close the handle it opened")

    def test_windows_probe_reports_a_foreign_pid_as_alive(self):
        # ERROR_ACCESS_DENIED: the process exists, it just is not ours to open.
        k32 = _FakeKernel32(handle=0, last_error=_FakeKernel32.ACCESS_DENIED)
        self.assertTrue(start._pid_alive_windows(4242, kernel32=k32))

    def test_windows_probe_asks_for_read_only_access(self):
        # PROCESS_QUERY_LIMITED_INFORMATION (0x1000) only asks. Anything wider (and
        # PROCESS_ALL_ACCESS in particular) is a right this has no business holding.
        k32 = _FakeKernel32(handle=7)
        start._pid_alive_windows(4242, kernel32=k32)
        access, _inherit, pid = k32.opened[0]
        self.assertEqual(access, 0x1000)
        self.assertEqual(pid, 4242)

    def test_posix_probe_still_works(self):
        self.assertTrue(start._pid_alive(os.getpid()))
        self.assertFalse(start._pid_alive(0))
        self.assertFalse(start._pid_alive(-1))


class _TempCwd(unittest.TestCase):
    """Runs each test inside a throwaway cwd — start.py resolves ff_data relatively."""

    def setUp(self):
        self._prev = os.getcwd()
        self._dir = tempfile.mkdtemp(prefix="chtest_")
        os.chdir(self._dir)
        os.makedirs("ff_data", exist_ok=True)

    def tearDown(self):
        os.chdir(self._prev)


class AtomicWriteTests(_TempCwd):
    """A write that dies partway must leave the previous file, not half the new one."""

    def test_a_failed_write_leaves_the_previous_file_intact(self):
        path = os.path.join("ff_data", "data_metals.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write('{"gold": "the good copy"}')

        def explode(fh):
            fh.write('{"gold": "half a')
            raise RuntimeError("killed mid-write")

        with self.assertRaises(RuntimeError):
            cd._write_atomic(path, explode)

        with open(path, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"gold": "the good copy"})

    def test_a_failed_write_leaves_no_temp_file_behind(self):
        path = os.path.join("ff_data", "screener.json")

        def explode(fh):
            raise RuntimeError("killed mid-write")

        with self.assertRaises(RuntimeError):
            cd._write_atomic(path, explode)

        self.assertEqual(os.listdir("ff_data"), [],
                         "the temp file must not outlive the failed write")

    def test_a_successful_write_replaces_the_target(self):
        path = os.path.join("ff_data", "config.js")
        cd._write_atomic(path, lambda fh: fh.write("window.__CONFIG__ = {};\n"))
        with open(path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "window.__CONFIG__ = {};\n")
        self.assertEqual(os.listdir("ff_data"), ["config.js"])

    def test_generate_html_writes_no_file_directly(self):
        # The four payload writes (category JSON, data_quality, screener, config.js)
        # all have to run through the helper. A bare open(..., "w") anywhere in here
        # is the truncation bug coming back.
        src = inspect.getsource(cd.generate_html)
        bare = re.search(r"open\([^)]*[\"']w[\"']", src)
        self.assertIsNone(
            bare,
            "generate_html opens a file for writing directly (%s…) — the payload writes "
            "must go through _write_atomic" % (bare.group(0) if bare else ""),
        )


def _sharing_violation(winerror=32):
    exc = PermissionError(13, "The process cannot access the file")
    exc.winerror = winerror        # PermissionError carries no winerror off Windows
    return exc


class ReplaceRetryTests(_TempCwd):
    """Windows cannot rename over a file another process is reading, and the other
    process is our own web server: boot.js pulls every category file through it while a
    refresh runs. Unretried, that PermissionError killed the refresh partway — some
    category files new, some old, no new config.js. Windows is not exercisable here, so
    these drive the helper with sys.platform and os.replace stood in for."""

    def _run(self, replace, platform="win32"):
        with mock.patch.object(cd.sys, "platform", platform), \
             mock.patch.object(cd.wallclock, "sleep"), \
             mock.patch.object(cd.os, "replace", replace):
            cd._replace_with_retry("tmp", "target")

    def test_a_sharing_violation_is_retried_until_the_reader_lets_go(self):
        calls = []

        def replace(tmp, path):
            calls.append(1)
            if len(calls) < 3:
                raise _sharing_violation()

        self._run(replace)
        self.assertEqual(len(calls), 3)

    def test_it_gives_up_rather_than_spinning_forever(self):
        def replace(tmp, path):
            raise _sharing_violation()

        with self.assertRaises(PermissionError):
            self._run(replace)

    def test_a_real_permission_problem_is_not_retried(self):
        # A read-only folder or a full disk must still fail on the first attempt —
        # retrying those only delays the error by two and a half seconds.
        calls = []

        def replace(tmp, path):
            calls.append(1)
            raise _sharing_violation(winerror=1314)   # ERROR_PRIVILEGE_NOT_HELD

        with self.assertRaises(PermissionError):
            self._run(replace)
        self.assertEqual(len(calls), 1)

    def test_posix_never_retries(self):
        calls = []

        def replace(tmp, path):
            calls.append(1)
            raise PermissionError(13, "denied")

        with self.assertRaises(PermissionError):
            self._run(replace, platform="darwin")
        self.assertEqual(len(calls), 1)


class StaleTempSweepTests(_TempCwd):
    """A TerminateProcess runs no handler, so _write_atomic's own cleanup never gets to
    unlink its temp — and the category payloads are 6-14 MB each."""

    def _temp(self, name, age_seconds):
        path = os.path.join("ff_data", name)
        with open(path, "w", encoding="utf-8") as f:
            f.write("x")
        stamp = os.path.getmtime(path) - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_an_orphaned_temp_is_collected(self):
        self._temp(".tmp_abc.part", age_seconds=7200)
        cd._sweep_stale_temp_files("ff_data")
        self.assertEqual(os.listdir("ff_data"), [])

    def test_a_temp_a_live_writer_may_still_hold_is_left_alone(self):
        self._temp(".tmp_live.part", age_seconds=5)
        cd._sweep_stale_temp_files("ff_data")
        self.assertEqual(os.listdir("ff_data"), [".tmp_live.part"])

    def test_it_touches_nothing_else(self):
        for name in ("config.js", "data_metals.json", "notes.part", ".tmp_keep.json"):
            self._temp(name, age_seconds=7200)
        cd._sweep_stale_temp_files("ff_data")
        self.assertEqual(sorted(os.listdir("ff_data")),
                         [".tmp_keep.json", "config.js", "data_metals.json", "notes.part"])

    def test_a_missing_data_dir_is_not_an_error(self):
        cd._sweep_stale_temp_files(os.path.join("ff_data", "nope"))


class DashboardExistsTests(_TempCwd):
    """config.js is generated data; a truncated one must count as MISSING, so the
    next launch regenerates it instead of serving a page that cannot boot."""

    GOOD = 'window.__CONFIG__ = {"index": {}, "dataDir": "ff_data"};\n'

    def _write_config(self, text):
        with open(os.path.join("ff_data", "config.js"), "w", encoding="utf-8") as f:
            f.write(text)
        with open(os.path.join("ff_data", "data_metals.json"), "w", encoding="utf-8") as f:
            f.write("{}")

    def test_a_complete_config_counts_as_present(self):
        self._write_config(self.GOOD)
        self.assertTrue(start.dashboard_exists())

    def test_an_empty_config_counts_as_missing(self):
        self._write_config("")
        self.assertFalse(start.dashboard_exists())

    def test_a_truncated_config_counts_as_missing(self):
        self._write_config(self.GOOD[: len(self.GOOD) // 2])
        self.assertFalse(start.dashboard_exists())

    def test_an_absent_config_counts_as_missing(self):
        self.assertFalse(start.dashboard_exists())


class _RecordingHandler(start.DashboardHandler):
    """A handler with no socket under it: only _send_json is stubbed, so do_GET's own
    control flow (what it sends, and how often) is what the tests below observe."""

    def __init__(self, path, write_fails=False):
        self.path = path
        self.sent = []
        self._write_fails = write_fails

    def _send_json(self, status, payload):
        self.sent.append(status)
        if self._write_fails:
            raise BrokenPipeError(32, "Broken pipe")


class ClientDisconnectTests(unittest.TestCase):
    """A client that walks away mid-response must not look like a crash.

    Reported from a running session on 2026-09-03: a contract-history response was reset
    by the browser mid-body and the console filled with two chained tracebacks. The write
    failure landed in the `except Exception` that exists for a FAILED FETCH, so the
    handler answered a dead socket with a 500 — which raised again, out of do_GET, into
    socketserver's traceback-printing handle_error.
    """

    def test_a_failed_fetch_still_answers_500(self):
        h = _RecordingHandler("/api/contract-history?symbol=GCZ26.CMX&period=5y")
        with mock.patch.object(start, "get_contract_history",
                               side_effect=RuntimeError("yahoo said no")):
            h.do_GET()
        self.assertEqual(h.sent, [500])

    def test_a_dead_socket_is_not_answered_with_a_second_write(self):
        h = _RecordingHandler("/api/contract-history?symbol=GCZ26.CMX&period=5y",
                              write_fails=True)
        with mock.patch.object(start, "get_contract_history", return_value={"history": []}):
            with self.assertRaises(BrokenPipeError):
                h.do_GET()
        self.assertEqual(h.sent, [200])   # the 500 chaser onto the dead socket is gone

    def test_the_disconnect_errors_are_recognised(self):
        for exc in (BrokenPipeError(), ConnectionResetError(), ConnectionAbortedError()):
            self.assertTrue(start._is_client_disconnect(exc), exc)

    def test_a_real_fault_is_not_mistaken_for_a_disconnect(self):
        # OSError is the shared base — matching on it would swallow a full disk or a
        # permission problem just as quietly.
        for exc in (OSError(28, "No space left on device"), ValueError("bug"),
                    TimeoutError()):
            self.assertFalse(start._is_client_disconnect(exc), exc)

    def test_handle_error_stays_silent_only_for_a_disconnect(self):
        srv = start.LocalServer.__new__(start.LocalServer)   # no bind, no socket
        reported = []
        with mock.patch.object(socketserver.BaseServer, "handle_error",
                               lambda self, req, addr: reported.append(addr)):
            try:
                raise ConnectionResetError(54, "Connection reset by peer")
            except ConnectionResetError:
                srv.handle_error(None, ("127.0.0.1", 1))
            self.assertEqual(reported, [])
            try:
                raise ValueError("a real bug")
            except ValueError:
                srv.handle_error(None, ("127.0.0.1", 2))
            self.assertEqual(reported, [("127.0.0.1", 2)])


if __name__ == "__main__":
    unittest.main()
