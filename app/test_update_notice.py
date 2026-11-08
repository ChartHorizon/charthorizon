#!/usr/bin/env python3
"""Offline tests for the "a newer version is out" notice: the two server routes and the
rules the page has to keep. The check itself (what is asked, how often, what is compared)
is test_update_check.py; this file is about where it is wired in.

No network, no running app. Run from app/:
  python3 -m unittest test_update_notice -v
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

import start
import update_check
import yahoo_gateway

# Importing start.py installs the SERVER gateway profile as the process-wide singleton,
# whose lock_path is the real ff_data/refresh.lock. Hand it back a plain profile, as
# test_crash_recovery does (see the test-isolation rule in dashboard/CLAUDE.md).
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)

APP = os.path.dirname(os.path.abspath(__file__))


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class _Handler(start.DashboardHandler):
    """The request handler with its socket amputated (as in test_risk_notice)."""

    def __init__(self, path, body=b""):
        self.path = path
        self.headers = {"Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)
        self.sent = []

    def _send_json(self, status, payload):
        self.sent.append((status, payload))


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.dir)                 # cwd is the writable data root in the server
        self.fetches = 0

        def fake_fetch(timeout=None):
            self.fetches += 1
            return {"version": "9.9.9",
                    "platforms": {"macos": "9.9.9", "windows": "9.9.9", "linux": "9.9.9"}}

        patcher = mock.patch.object(update_check, "fetch_release_doc", fake_fetch)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self):
        h = _Handler("/api/update-check")
        h.do_GET()
        return h.sent[-1]

    def post(self, body):
        h = _Handler("/api/update-check", json.dumps(body).encode() if not isinstance(body, bytes) else body)
        h.do_POST()
        return h.sent[-1]

    def test_a_fresh_installation_asks_nothing_on_its_own(self):
        status, payload = self.get()
        self.assertEqual(status, 200)
        self.assertFalse(payload["auto"])
        self.assertEqual(self.fetches, 0)

    def test_get_reports_the_running_version_against_the_release(self):
        self.post({"auto": True})
        status, payload = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(payload["current"], start.app_version.APP_VERSION)
        self.assertEqual(payload["latest"], "9.9.9")
        self.assertTrue(payload["newer"])
        self.assertEqual(self.fetches, 1)

    def test_the_state_lives_under_ff_data(self):
        self.post({"check": True})
        self.assertTrue(os.path.isfile(os.path.join("ff_data", "update_check.json")))
        self.assertEqual(start.UPDATE_CHECK_FILE, os.path.join("ff_data", "update_check.json"))

    def test_switching_off_stops_the_request(self):
        status, payload = self.post({"auto": False})
        self.assertEqual(status, 200)
        self.assertFalse(payload["auto"])
        self.get()
        self.assertEqual(self.fetches, 0)

    def test_check_now_asks_even_when_switched_off(self):
        self.post({"auto": False})
        status, payload = self.post({"check": True})
        self.assertEqual(status, 200)
        self.assertEqual(self.fetches, 1)
        self.assertEqual(payload["latest"], "9.9.9")
        self.assertFalse(payload["auto"])

    def test_dismissing_a_version(self):
        self.post({"check": True})
        status, payload = self.post({"dismiss": "9.9.9"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["dismissed"])

    def test_a_bad_body_is_a_400(self):
        for body in (b"not json", {"auto": "yes"}, {"check": 1}, {"dismiss": "<b>"}, {}, [1]):
            status, _ = self.post(body)
            self.assertEqual(status, 400, body)

    def test_a_failed_write_is_a_500(self):
        with mock.patch.object(update_check, "_save", side_effect=OSError("read-only")):
            status, _ = self.post({"auto": False})
        self.assertEqual(status, 500)


class PageRulesTests(unittest.TestCase):
    """The browser half. These read the source, as test_risk_notice does for its dialog."""

    def test_the_notice_never_runs_in_card_mode(self):
        # The content bot shoots its PNGs through this page: a banner there would be on
        # every card, and the bot's server would phone out on every run.
        src = _read(os.path.join(APP, "web", "update.js"))
        body = src[src.index("async function ensureUpdateNotice"):]
        self.assertRegex(body[:400], r"if \(_isCardMode\(\)\) return;")

    def test_boot_only_asks_on_the_normal_dashboard_branch(self):
        boot = _read(os.path.join(APP, "web", "boot.js"))
        self.assertIn("ensureUpdateNotice()", boot)
        self.assertLess(boot.index("ensureRiskNotice()"), boot.index("ensureUpdateNotice()"))

    def test_the_page_loads_it_before_boot(self):
        html = _read(os.path.join(APP, "index.html"))
        scripts = re.findall(r'<script src="web/([a-z]+)\.js', html)
        self.assertIn("update", scripts)
        self.assertLess(scripts.index("update"), scripts.index("boot"))

    def test_the_page_never_asks_the_website_itself(self):
        # Only the local server talks to chart-horizon.com, and only through
        # update_check.fetch_release_doc — one request, one place to audit.
        for name in ("update.js", "settings.js"):
            self.assertNotIn("version.json", _read(os.path.join(APP, "web", name)), name)


if __name__ == "__main__":
    unittest.main()
