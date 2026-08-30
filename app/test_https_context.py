# ── test_https_context.py ── Every urllib call in the app must carry an explicit,
# certifi-backed SSLContext.
#
# The 1.2 Windows build failed all four CFTC endpoints and the BIS policy-rate fetch
# with [SSL: CERTIFICATE_VERIFY_FAILED] "unable to get local issuer certificate":
# urllib's default context trusts the OS root store, and Windows fills that store
# through Schannel's automatic root update, which OpenSSL never triggers. macOS and
# Linux were fine, so the one platform this breaks on is the one that cannot be
# exercised here — hence a test on the invariant (a context is passed) rather than on
# the symptom (a handshake succeeds).
# Run from app/:  python3 -m unittest test_https_context -v
# No network: urlopen is replaced by a recorder.

from __future__ import annotations

import contextlib
import ssl
import unittest
from unittest import mock

import fetch_cftc
import fx_rates
import net_tls


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Recorder:
    """Stands in for urllib.request.urlopen and remembers the context it was given."""

    NEVER_CALLED = object()

    def __init__(self, payload):
        self.payload = payload
        self.context = self.NEVER_CALLED

    def __call__(self, req, timeout=None, context=None):
        self.context = context
        return _FakeResponse(self.payload)


class UrlopenCallsCarryCertifiContextTest(unittest.TestCase):
    def _assert_shared_context(self, recorder):
        self.assertIsNot(recorder.context, _Recorder.NEVER_CALLED, "urlopen was never reached")
        self.assertIsNotNone(
            recorder.context,
            "urlopen ran without an explicit SSLContext — on Windows that trusts only the "
            "OS root store and fails with CERTIFICATE_VERIFY_FAILED",
        )
        self.assertIs(recorder.context, net_tls.https_context())

    def test_cftc_api_dataset(self):
        recorder = _Recorder(b"[]")
        with mock.patch("urllib.request.urlopen", recorder):
            fetch_cftc._fetch_cftc_dataset(fetch_cftc.CFTC_DATASETS[0], ["001602"])
        self._assert_shared_context(recorder)

    def test_cftc_legacy_txt_fallback(self):
        recorder = _Recorder(b"")
        # An empty body is not parseable; the assertion is about the request, not the
        # parse that follows it, so let a downstream failure pass through.
        with mock.patch("urllib.request.urlopen", recorder), contextlib.suppress(Exception):
            fetch_cftc.fetch_cftc_cot_legacy_txt()
        self._assert_shared_context(recorder)

    def test_bis_policy_rates(self):
        recorder = _Recorder(b"")
        with mock.patch("urllib.request.urlopen", recorder):
            fx_rates.fetch_fx_rates()   # swallows its own failures and returns None
        self._assert_shared_context(recorder)


class HttpsContextTest(unittest.TestCase):
    def test_loads_a_real_trust_store(self):
        self.assertGreater(
            net_tls.https_context().cert_store_stats()["x509"], 0,
            "the shared context carries no CA certificates at all",
        )

    def test_still_verifies(self):
        context = net_tls.https_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname, "hostname checking must stay on")

    def test_is_reused(self):
        self.assertIs(net_tls.https_context(), net_tls.https_context())


if __name__ == "__main__":
    unittest.main()
