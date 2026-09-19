#!/usr/bin/env python3
"""Offline tests for the risk notice -- one text, four places that must carry it.

RISK-NOTICE.txt (packaging/public/) is the canonical wording: the Windows installer
compiles it in as the wizard page that cannot be walked past unread, the frozen bundle
ships it beside the AGPL text, the public mirror publishes it, and the dashboard shows a
short form of it ONCE, on the first launch of an installation.

"Once per installation" is the part with a moving piece, and it is deliberately NOT
browser state: localStorage would re-ask after every cache clear and on every browser, and
the content bot's headless Chromium starts with an empty profile on every single run -- it
would meet the dialog before every card it shoots. So the acknowledgement is a file in the
writable data root, and the two endpoints below are the only way it is read or written.

No network, no running app. Run from app/:
  python3 -m unittest test_risk_notice -v
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import tempfile
import unittest

import start
import yahoo_gateway

# Importing start.py installs the SERVER gateway profile as the process-wide singleton,
# whose lock_path is the real ff_data/refresh.lock -- and while a refresh is genuinely in
# flight that stands the gateway down and unrelated tests elsewhere fail with no Yahoo call
# recorded. Hand the singleton back a plain profile, as test_crash_recovery does.
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)

APP = os.path.dirname(os.path.abspath(__file__))                   # dashboard/app
DASHBOARD = os.path.abspath(os.path.join(APP, os.pardir))
PACKAGING = os.path.join(DASHBOARD, "packaging")
NOTICE = os.path.join(PACKAGING, "public", "RISK-NOTICE.txt")


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class _Handler(start.DashboardHandler):
    """The request handler with its socket amputated: do_GET/do_POST reach _send_json and
    nothing else, so the routes can be exercised without binding a port."""

    def __init__(self, path):
        self.path = path
        self.sent = []

    def _send_json(self, status, payload):
        self.sent.append((status, payload))


class AckStateTests(unittest.TestCase):
    """The flag file itself. cwd is the writable data root in the running server, so these
    run inside a temporary one."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.dir)
        os.makedirs("ff_data")

    def test_a_fresh_installation_has_not_acknowledged(self):
        payload = start.risk_notice_payload()
        self.assertFalse(payload["accepted"])
        self.assertEqual(payload["version"], start.RISK_NOTICE_VERSION)

    def test_recording_it_makes_it_acknowledged(self):
        start.record_risk_notice_ack()
        self.assertTrue(start.risk_notice_payload()["accepted"])
        stored = json.loads(_read(start.RISK_ACK_FILE))
        self.assertEqual(stored["version"], start.RISK_NOTICE_VERSION)
        self.assertTrue(stored["accepted_at"])

    def test_it_survives_a_missing_ff_data(self):
        # A first launch that has not generated anything yet: the folder is not there.
        shutil.rmtree("ff_data")
        self.assertFalse(start.risk_notice_payload()["accepted"])
        start.record_risk_notice_ack()
        self.assertTrue(start.risk_notice_payload()["accepted"])

    def test_a_truncated_flag_file_is_not_an_acknowledgement(self):
        # Same class of failure the config.js guard exists for: a kill mid-write. Half a
        # file must read as "not asked yet", never as an acceptance, and never raise.
        with open(start.RISK_ACK_FILE, "w", encoding="utf-8") as f:
            f.write('{"version": 1, "accepted')
        self.assertFalse(start.risk_notice_payload()["accepted"])

    def test_an_acknowledgement_of_an_older_notice_does_not_count(self):
        # Bumping RISK_NOTICE_VERSION is how a materially changed notice gets shown again.
        with open(start.RISK_ACK_FILE, "w", encoding="utf-8") as f:
            json.dump({"version": start.RISK_NOTICE_VERSION - 1, "accepted_at": "2026-01-01"}, f)
        self.assertFalse(start.risk_notice_payload()["accepted"])

    def test_a_newer_notice_version_still_counts(self):
        # Downgrading the app must not re-ask for something already acknowledged.
        with open(start.RISK_ACK_FILE, "w", encoding="utf-8") as f:
            json.dump({"version": start.RISK_NOTICE_VERSION + 1, "accepted_at": "2027-01-01"}, f)
        self.assertTrue(start.risk_notice_payload()["accepted"])

    def test_recording_leaves_no_temp_file_behind(self):
        start.record_risk_notice_ack()
        self.assertEqual(glob.glob(os.path.join("ff_data", ".ack_*")), [])

    def test_the_flag_lives_under_ff_data(self):
        # Two reasons, both load-bearing: ff_data/ is gitignored (a dev run must not offer
        # the file as a change), and it is inside DATA_ROOT, which is the only writable
        # place a frozen build has.
        self.assertTrue(start.RISK_ACK_FILE.startswith("ff_data" + os.sep))


class EndpointTests(unittest.TestCase):
    """The two routes the dialog talks to."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.dir)
        os.makedirs("ff_data")

    def test_get_reports_the_state(self):
        h = _Handler("/api/risk-notice")
        h.do_GET()
        self.assertEqual(h.sent[0][0], 200)
        self.assertFalse(h.sent[0][1]["accepted"])

    def test_post_records_and_reports_back(self):
        h = _Handler("/api/risk-notice-ack")
        h.do_POST()
        status, payload = h.sent[0]
        self.assertEqual(status, 200)
        self.assertTrue(payload["accepted"])
        self.assertTrue(start.risk_notice_payload()["accepted"])

    def test_a_failed_write_is_reported_as_a_failure(self):
        # A 200 that did not store anything would tell the page it never has to ask again,
        # in a session where nothing was written. Being asked twice beats being asked never.
        os.chmod("ff_data", 0o500)
        self.addCleanup(os.chmod, "ff_data", 0o700)
        h = _Handler("/api/risk-notice-ack")
        h.do_POST()
        self.assertEqual(h.sent[0][0], 500)
        self.assertFalse(start.risk_notice_payload()["accepted"])

    def test_an_unknown_post_is_still_a_404(self):
        h = _Handler("/api/nope")
        h.do_POST()
        self.assertEqual(h.sent[0][0], 404)


class NoticeTextTests(unittest.TestCase):
    """The canonical file. Inno Setup reads a BOM-less .txt as the ANSI code page."""

    def setUp(self):
        self.text = _read(NOTICE)

    def test_it_is_pure_ascii(self):
        # A UTF-8 dash would reach the wizard as mojibake in the middle of a legal
        # sentence -- the same trap build_win.ps1 carries an ASCII-only rule for.
        offenders = [(i + 1, line) for i, line in enumerate(self.text.splitlines())
                     if any(ord(c) > 0x7E for c in line)]
        self.assertEqual(offenders, [])

    def test_it_is_hard_wrapped_for_the_wizard(self):
        too_long = [(i + 1, len(line)) for i, line in enumerate(self.text.splitlines())
                    if len(line) > 78]
        self.assertEqual(too_long, [], "the licence page does not reflow generously")

    def test_it_says_the_four_things_it_exists_to_say(self):
        low = self.text.lower()
        for phrase in ("educational", "substantial risk of loss",
                       "do not\nguarantee, future results", "no liability",
                       '"as is"', "agpl"):
            self.assertIn(phrase, low, phrase)


class ItReachesTheUserTests(unittest.TestCase):
    """Every consumer of that one file. Each of these is a place it has silently NOT been
    shown before, so each is worth a line of its own."""

    def test_the_installer_puts_it_on_a_page_that_must_be_accepted(self):
        iss = _read(os.path.join(PACKAGING, "windows", "charthorizon.iss"))
        self.assertIn("LicenseFile=..\\public\\RISK-NOTICE.txt", iss)
        self.assertIn("LicenseAccepted=", iss, "the accept wording must say NOTICE, not agreement")

    def test_the_installer_drops_it_and_the_licence_next_to_the_exe(self):
        iss = _read(os.path.join(PACKAGING, "windows", "charthorizon.iss"))
        self.assertIn('Source: "..\\public\\RISK-NOTICE.txt"; DestDir: "{app}"', iss)
        self.assertIn('DestName: "LICENSE.txt"', iss)

    def test_the_bundle_carries_both_on_every_os(self):
        spec = _read(os.path.join(PACKAGING, "charthorizon.spec"))
        self.assertIn('"LICENSE"), "."', spec)
        self.assertIn('"RISK-NOTICE.txt"), "."', spec)

    def test_the_public_mirror_publishes_it(self):
        # The .md documents under packaging/public/ are excluded from the mirror and
        # injected at its root by name, so one that is not named there would leave
        # README.md's relative link dead. tools/ itself stays private, so this file is not
        # in the mirror at all — and these tests are shipped with it, so they must pass
        # there too rather than fail on something that repo is not supposed to have.
        script = os.path.join(DASHBOARD, "tools", "publish-dashboard.sh")
        if not os.path.exists(script):
            self.skipTest("tools/ is private; this is the mirror, not the monorepo")
        self.assertIn("RISK-NOTICE.txt", _read(script))

    def test_the_readme_carries_the_short_form(self):
        # packaging/public/README.md in the monorepo, README.md at the root of the mirror.
        for path in (os.path.join(PACKAGING, "public", "README.md"),
                     os.path.join(DASHBOARD, "README.md")):
            if os.path.exists(path):
                readme = _read(path)
                break
        else:
            self.fail("no README to check")
        self.assertIn("## Risk notice", readme)
        self.assertIn("RISK-NOTICE.txt", readme)

    def test_the_first_start_dialog_never_runs_in_card_mode(self):
        # The bot's PNGs are shot through the same page. A dialog over them is a ruined
        # card, and its Chromium profile is empty on every run, so it would be EVERY card.
        js = _read(os.path.join(APP, "web", "disclaimer.js"))
        self.assertIn("card", js.lower())
        self.assertRegex(js, r"_isCardMode\(\)")

    def test_the_page_loads_the_dialog_before_boot(self):
        html = _read(os.path.join(APP, "index.html"))
        self.assertIn("web/disclaimer.js", html)
        self.assertLess(html.index("web/disclaimer.js"), html.index("web/boot.js"),
                        "boot.js runs on load and calls into it; it must be defined by then")


if __name__ == "__main__":
    unittest.main()
