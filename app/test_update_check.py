# ── test_update_check.py ── The "a newer version is out" check (update_check.py).
#
# What is pinned here, and why each one matters:
#   - versions compare as numbers, so 1.3.10 is newer than 1.3.9 and a source checkout
#     that is AHEAD of the website is never told to "update" to an older build;
#   - an installer asks for ITS platform's version: a macOS-only release must not tell a
#     Windows user that a download exists which the page still shows as "Coming soon";
#   - the request carries nothing: no query string, no version, no OS in the User-Agent.
#     That is the condition under which "your data never leaves your machine" still holds;
#   - automatic checking is OFF until the user switches it on (operator decision
#     2026-11-08), off means no request on its own, and an unreadable settings file counts
#     as off too (the safe direction for a privacy switch);
#   - "Check now" asks at once, whatever the switch and the daily rhythm say — and never
#     turns automatic checking back on behind the user's back;
#   - at most one request a day, an hour's pause after a failure, and a failed check
#     keeps the last good answer instead of forgetting it.
# Run from app/:  python3 -m unittest test_update_check -v
# No network: every fetch is injected.

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
import urllib.parse
from unittest import mock

import update_check as uc


_SAME = object()


def _doc(version="1.3.3", macos=_SAME, windows=_SAME, linux=_SAME):
    """A release document; each platform carries the release version unless given."""
    pick = lambda v: version if v is _SAME else v
    return {"version": version,
            "platforms": {"macos": pick(macos), "windows": pick(windows), "linux": pick(linux)}}


class _Fetch:
    """Stands in for fetch_release_doc: counts calls and returns or raises on demand."""

    def __init__(self, result=None, error=None):
        self.result = result if result is not None else _doc()
        self.error = error
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


class VersionCompareTest(unittest.TestCase):
    def test_compares_numerically_not_as_text(self):
        self.assertTrue(uc.is_newer("1.3.10", "1.3.9"))
        self.assertFalse(uc.is_newer("1.3.9", "1.3.10"))

    def test_a_missing_patch_number_is_zero(self):
        self.assertFalse(uc.is_newer("1.2", "1.2.0"))
        self.assertTrue(uc.is_newer("1.3", "1.2.9"))

    def test_equal_is_not_newer(self):
        self.assertFalse(uc.is_newer("1.3.2", "1.3.2"))

    def test_a_checkout_ahead_of_the_website_is_not_told_to_update(self):
        self.assertFalse(uc.is_newer("1.3.2", "1.4.0"))

    def test_garbage_is_never_newer(self):
        for bad in (None, "", "v1.3.3", "1.3.3-beta", "latest", 133, "1..3", "1.3.3.4.5"):
            self.assertFalse(uc.is_newer(bad, "1.3.2"), bad)


class PlatformTest(unittest.TestCase):
    def test_platform_keys(self):
        self.assertEqual(uc.platform_key("darwin"), "macos")
        self.assertEqual(uc.platform_key("win32"), "windows")
        self.assertEqual(uc.platform_key("linux"), "linux")
        self.assertIsNone(uc.platform_key("freebsd13"))

    def test_an_installer_reads_its_own_platform(self):
        doc = _doc(version="1.3.3", macos="1.3.3", windows=None)
        self.assertEqual(uc.latest_for(doc, "macos", frozen=True), "1.3.3")
        self.assertIsNone(uc.latest_for(doc, "windows", frozen=True),
                          "Windows is 'Coming soon' on the page: no update to offer")

    def test_an_installer_on_a_platform_the_page_does_not_list_gets_nothing(self):
        self.assertIsNone(uc.latest_for(_doc(), None, frozen=True))

    def test_a_document_without_platforms_falls_back_to_the_version(self):
        self.assertEqual(uc.latest_for({"version": "1.3.3"}, "windows", frozen=True), "1.3.3")

    def test_a_source_run_reads_the_release_version(self):
        doc = _doc(version="1.3.3", macos=None)
        self.assertEqual(uc.latest_for(doc, "macos", frozen=False), "1.3.3")


class StatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "ff_data", "update_check.json")
        self.now = 1_800_000_000.0
        uc.set_auto(self.path, True)      # most tests here are about the automatic check

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def status(self, fetch, now=None, current="1.3.2", platform="macos", frozen=True, force=False):
        return uc.status(self.path, current, platform, frozen,
                         now=self.now if now is None else now, fetch=fetch, force=force)

    def test_a_newer_release_is_reported(self):
        st = self.status(_Fetch(_doc("1.3.3")))
        self.assertTrue(st["auto"])
        self.assertFalse(st["failed"])
        self.assertEqual(st["current"], "1.3.2")
        self.assertEqual(st["latest"], "1.3.3")
        self.assertTrue(st["newer"])
        self.assertFalse(st["dismissed"])
        self.assertEqual(st["url"], uc.DOWNLOAD_URL)

    def test_the_same_version_is_not_newer(self):
        st = self.status(_Fetch(_doc("1.3.2", "1.3.2", "1.3.2", "1.3.2")))
        self.assertEqual(st["latest"], "1.3.2")
        self.assertFalse(st["newer"])

    def test_asks_at_most_once_a_day(self):
        fetch = _Fetch()
        self.status(fetch)
        self.status(fetch, now=self.now + 3600)
        self.status(fetch, now=self.now + uc.CHECK_INTERVAL_SECONDS - 1)
        self.assertEqual(fetch.calls, 1)
        self.status(fetch, now=self.now + uc.CHECK_INTERVAL_SECONDS)
        self.assertEqual(fetch.calls, 2)

    def test_the_answer_survives_a_restart(self):
        self.status(_Fetch(_doc("1.3.3")))
        fetch = _Fetch(error=AssertionError("must not ask again within the day"))
        st = self.status(fetch, now=self.now + 60)
        self.assertEqual(fetch.calls, 0)
        self.assertEqual(st["latest"], "1.3.3")

    def test_a_failure_waits_an_hour_and_keeps_the_last_good_answer(self):
        self.status(_Fetch(_doc("1.3.3")))
        later = self.now + uc.CHECK_INTERVAL_SECONDS
        failing = _Fetch(error=OSError("offline"))
        st = self.status(failing, now=later)
        self.assertEqual(failing.calls, 1)
        self.assertEqual(st["latest"], "1.3.3", "a failed check must not forget the last answer")
        self.status(failing, now=later + uc.RETRY_AFTER_FAILURE_SECONDS - 1)
        self.assertEqual(failing.calls, 1)
        self.status(failing, now=later + uc.RETRY_AFTER_FAILURE_SECONDS)
        self.assertEqual(failing.calls, 2)

    def test_a_failure_on_the_first_check_reports_nothing(self):
        st = self.status(_Fetch(error=OSError("offline")))
        self.assertIsNone(st["latest"])
        self.assertFalse(st["newer"])
        self.assertTrue(st["failed"], "the page must be able to say the check did not get through")

    def test_a_success_after_a_failure_clears_the_failure(self):
        self.status(_Fetch(error=OSError("offline")))
        st = self.status(_Fetch(_doc("1.3.3")), force=True)
        self.assertFalse(st["failed"])

    def test_a_malformed_answer_counts_as_a_failure(self):
        for bad in ({"version": "soon"}, {"nothing": 1}, ["1.3.3"],
                    {"version": "1.3.3", "platforms": "all"}):
            shutil.rmtree(self.tmp, ignore_errors=True)
            uc.set_auto(self.path, True)
            st = self.status(_Fetch(bad))
            self.assertIsNone(st["latest"], bad)

    def test_switched_off_asks_nothing(self):
        uc.set_auto(self.path, False)
        fetch = _Fetch(error=AssertionError("switched off: no request"))
        st = self.status(fetch)
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(st["auto"])
        self.assertIsNone(st["latest"])
        self.assertFalse(st["newer"])

    def test_switched_off_still_reports_the_last_answer(self):
        # A stored answer can only be OLDER than the real latest release, so it can never
        # announce an update that does not exist — showing it is always safe.
        self.status(_Fetch(_doc("1.3.3")))
        uc.set_auto(self.path, False)
        st = self.status(_Fetch(error=AssertionError("no request")), now=self.now + 7 * 86400)
        self.assertEqual(st["latest"], "1.3.3")
        self.assertTrue(st["newer"])

    def test_check_now_asks_at_once(self):
        fetch = _Fetch(_doc("1.3.3"))
        self.status(fetch)
        st = self.status(fetch, now=self.now + 60, force=True)
        self.assertEqual(fetch.calls, 2, "a click on Check now is a request, not a wish")
        self.assertEqual(st["latest"], "1.3.3")

    def test_check_now_skips_the_hour_after_a_failure(self):
        self.status(_Fetch(error=OSError("offline")))
        fetch = _Fetch(_doc("1.3.3"))
        self.status(fetch, now=self.now + 60, force=True)
        self.assertEqual(fetch.calls, 1)

    def test_check_now_works_with_automatic_checking_off(self):
        uc.set_auto(self.path, False)
        fetch = _Fetch(_doc("1.3.3"))
        st = self.status(fetch, force=True)
        self.assertEqual(fetch.calls, 1)
        self.assertEqual(st["latest"], "1.3.3")
        self.assertFalse(st["auto"], "Check now must not switch automatic checking back on")
        self.assertFalse(self.status(_Fetch(error=AssertionError("still off")),
                                     now=self.now + 2 * 86400)["auto"])

    def test_check_now_over_an_unreadable_file_keeps_automatic_checking_off(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write('{"auto": fal')
        self.status(_Fetch(_doc("1.3.3")), force=True)
        fetch = _Fetch(error=AssertionError("the rewritten file must still say off"))
        st = self.status(fetch, now=self.now + 2 * 86400)
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(st["auto"])
        self.assertEqual(st["latest"], "1.3.3")

    def test_switching_back_on_asks_straight_away(self):
        self.status(_Fetch(_doc("1.3.3")))
        uc.set_auto(self.path, False)
        uc.set_auto(self.path, True)
        fetch = _Fetch(_doc("1.3.4"))
        st = self.status(fetch, now=self.now + 60)
        self.assertEqual(fetch.calls, 1, "turning the check on is a request to check")
        self.assertEqual(st["latest"], "1.3.4")

    def test_an_unreadable_settings_file_counts_as_switched_off(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write('{"auto": fal')                  # truncated mid-write
        fetch = _Fetch(error=AssertionError("unreadable file: do not phone out"))
        st = self.status(fetch)
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(st["auto"])

    def test_a_fresh_installation_does_not_ask_on_its_own(self):
        os.remove(self.path)
        fetch = _Fetch(error=AssertionError("off by default: no request"))
        st = self.status(fetch)
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(st["auto"])
        self.assertIsNone(st["latest"])

    def test_check_now_on_a_fresh_installation_leaves_it_off(self):
        os.remove(self.path)
        self.status(_Fetch(_doc("1.3.3")), force=True)
        fetch = _Fetch(error=AssertionError("Check now is not consent to a daily check"))
        st = self.status(fetch, now=self.now + 2 * 86400)
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(st["auto"])
        self.assertEqual(st["latest"], "1.3.3")

    def test_a_dismissed_version_stays_dismissed(self):
        self.status(_Fetch(_doc("1.3.3")))
        uc.dismiss(self.path, "1.3.3")
        st = self.status(_Fetch(_doc("1.3.3")), now=self.now + 60)
        self.assertTrue(st["newer"], "dismissing hides the notice, not the fact")
        self.assertTrue(st["dismissed"])

    def test_the_next_release_is_shown_again(self):
        self.status(_Fetch(_doc("1.3.3")))
        uc.dismiss(self.path, "1.3.3")
        st = self.status(_Fetch(_doc("1.3.4")), now=self.now + uc.CHECK_INTERVAL_SECONDS)
        self.assertEqual(st["latest"], "1.3.4")
        self.assertFalse(st["dismissed"])

    def test_an_invalid_dismiss_is_refused(self):
        with self.assertRaises(ValueError):
            uc.dismiss(self.path, "<script>")

    def test_a_platform_held_at_coming_soon_gets_no_notice(self):
        st = self.status(_Fetch(_doc("1.3.3", windows=None)), platform="windows")
        self.assertIsNone(st["latest"])
        self.assertFalse(st["newer"])


class RequestCarriesNothingTest(unittest.TestCase):
    """The privacy half: the one request the check makes says nothing about this user."""

    class _Response:
        status = 200

        def __init__(self, body):
            self.body = body

        def read(self, n=-1):
            return self.body if n < 0 else self.body[:n]

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _fetch(self, body):
        seen = {}

        def opener(req, timeout=None, context=None):
            seen["req"] = req
            seen["timeout"] = timeout
            return self._Response(body)

        with mock.patch("urllib.request.urlopen", opener):
            doc = uc.fetch_release_doc()
        return doc, seen

    def test_plain_get_without_query_or_identifying_headers(self):
        doc, seen = self._fetch(json.dumps(_doc("1.3.3")).encode())
        self.assertEqual(doc["version"], "1.3.3")
        req = seen["req"]
        self.assertEqual(req.get_method(), "GET")
        self.assertIsNone(req.data)
        parts = urllib.parse.urlsplit(req.full_url)
        self.assertEqual((parts.scheme, parts.query, parts.fragment), ("https", "", ""))
        self.assertEqual(req.full_url, uc.UPDATE_URL)
        headers = {k.lower(): v for k, v in req.header_items()}
        self.assertEqual(headers.get("user-agent"), "ChartHorizon",
                         "no version, no OS, no Python build in the User-Agent")
        self.assertEqual(set(headers), {"user-agent", "accept"})
        self.assertIsNotNone(seen["timeout"])

    def test_an_oversized_answer_is_refused(self):
        with self.assertRaises(ValueError):
            self._fetch(b" " * (uc.MAX_BYTES + 1))

    def test_a_non_json_answer_raises(self):
        with self.assertRaises(ValueError):
            self._fetch(b"<html>404</html>")


if __name__ == "__main__":
    unittest.main()
