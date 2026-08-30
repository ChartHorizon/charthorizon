# ── net_tls.py ── One TLS trust store for every urllib call in the app.
#
# WHY THIS EXISTS
#   urllib's default context trusts whatever the operating system's root store
#   holds. On Windows that store starts nearly empty and is filled on demand by
#   Schannel's automatic root update — a mechanism OpenSSL, and therefore Python,
#   never triggers. So on a fresh Windows install every urlopen() to a host whose
#   issuer is not already cached dies with
#       [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
#   while the identical code works on macOS. The 1.2 Windows build hit exactly this
#   on all four CFTC endpoints and on the BIS policy-rate fetch; yfinance was
#   unaffected because requests/curl_cffi ship certifi and pin themselves to it.
#
#   certifi is already in the bundle (a requests dependency, verified present as
#   _internal/certifi/cacert.pem), so pointing urllib at the same bundle costs
#   nothing and makes the trust store identical on all three platforms — which also
#   means a CA problem can no longer be a Windows-only surprise found after release.
#
#   If certifi is somehow missing, fall back to the default context rather than
#   raising: a trust store that works on two platforms beats no HTTPS at all.

from __future__ import annotations

import ssl

try:
    import certifi
except ImportError:  # pragma: no cover — certifi ships with requests
    certifi = None

__all__ = ['https_context']

_context = None


def https_context():
    """Shared SSLContext for `urllib.request.urlopen(..., context=...)`.

    Built once and reused: loading the CA bundle costs a file read and a parse,
    and the refresh path opens dozens of connections.
    """
    global _context
    if _context is None:
        if certifi is not None:
            _context = ssl.create_default_context(cafile=certifi.where())
        else:
            _context = ssl.create_default_context()
    return _context
