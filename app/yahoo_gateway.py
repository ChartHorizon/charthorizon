# ── yahoo_gateway.py ── The one place every yfinance/Yahoo request is rationed.
# Owns the shared browser-impersonating session, a priority-aware token bucket, the
# 429 circuit breaker and the backoff retry. Performs no HTTP itself except the batch
# quote endpoint (see quotes()). Lowest layer: imports nothing from this project, so
# both the server process and the generator subprocess can use it.
#
# Why priorities: the generator's contract scans are ~880 requests per refresh and
# would otherwise starve the chart the user is looking at. They are reserve
# thresholds on ONE bucket, not queues — cheap, and testable with a fake clock.

from __future__ import annotations

import datetime
import os
import random
import threading
import time

PRIORITY_INTERACTIVE = "interactive"   # the chart on screen — never blocked, never retried
PRIORITY_PRELOAD = "preload"           # the boot splash
PRIORITY_BULK = "bulk"                 # the generator's contract scans

QUOTE_ENDPOINT = "https://query1.finance.yahoo.com/v7/finance/quote"
QUOTE_BATCH_SIZE = 50     # 100 tested fine; 50 keeps one failure cheaper

# Fraction of capacity that must REMAIN for a class to be admitted.
_PRIORITY_FLOOR = {
    PRIORITY_INTERACTIVE: 0.0,
    PRIORITY_PRELOAD: 0.25,
    PRIORITY_BULK: 0.5,
}

# How long a class may WAIT for its token before giving up. The floors above decide who
# may drain the bucket; these decide what "no token" means for each of them.
#   interactive (0) — never blocks. A stale on-screen candle beats a blocked request
#                     thread; this is the original non-blocking contract, unchanged.
#   preload         — a boot-splash warm-up: worth a short wait, never a stalled splash.
#   bulk            — the generator. For a batch job "no token" must mean LATER, not
#                     NEVER: a skipped scan is a hole in the market's data that the
#                     local-first merge then has to paper over. Dropping them wholesale
#                     is what let the 2026-08-22 refresh finish in 11 s having fetched
#                     essentially nothing (all 39 markets `fresh_history_missing`).
# The ceiling only bites when the budget is genuinely starved — at the shipped 6 tokens/s
# a normal wait is a fraction of a second.
_PRIORITY_MAX_WAIT = {
    PRIORITY_INTERACTIVE: 0.0,
    PRIORITY_PRELOAD: 5.0,
    PRIORITY_BULK: 30.0,
}
_MIN_WAIT_STEP = 0.02   # floor per wait iteration, so contention can never spin freely

# ── Breaker tuning (moved from live_cache.py so the generator subprocess shares it
# with the server; live_cache.py re-exports both names for its existing callers). ──
LIVE_BREAKER_COOLDOWN_SECONDS = 90.0  # how long the breaker stays open after a 429
LIVE_BREAKER_ERROR_THRESHOLD = 3      # consecutive non-429 errors that also trip it


class RateLimitedError(Exception):
    """Raised by an injected fetch when Yahoo signals 429 / rate limiting."""


class _TokenBucket:
    """Global outbound-rate cap. try_take() is NON-blocking: no token -> the caller
    serves the last-known value instead of queuing (queuing is what piled up the
    server threads in the first place).

    `priority` gates how far down the bucket a class may drain it, so a bulk scan
    can never take the last token out from under an on-screen chart."""

    def __init__(self, capacity, refill_per_sec, clock):
        self._capacity = float(capacity)
        self._refill = float(refill_per_sec)
        self._clock = clock
        self._tokens = float(capacity)
        self._last = clock()
        self._lock = threading.Lock()

    def try_take(self, priority=PRIORITY_INTERACTIVE):
        floor = _PRIORITY_FLOOR.get(priority, 0.0) * self._capacity
        with self._lock:
            now = self._clock()
            self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._refill)
            self._last = now
            # Interactive (floor 0) is unrestricted: it may drain the last token, same
            # as the original unconditional check. Any priority with a floor must leave
            # STRICTLY more than that floor behind, so a bulk/preload take can never be
            # the one that brings the bucket down to (or through) its reserve line.
            ok = self._tokens >= 1.0 if floor <= 0.0 else self._tokens > floor + 1.0
            if ok:
                self._tokens -= 1.0
                return True
            return False

    def seconds_until_token(self, priority=PRIORITY_INTERACTIVE):
        """How long until try_take(priority) could succeed, or None if it never can
        (a bucket that does not refill, or a floor this class can never clear). Lets a
        caller that is allowed to wait sleep exactly as long as the refill needs
        instead of polling."""
        if self._refill <= 0.0:
            return None
        floor = _PRIORITY_FLOOR.get(priority, 0.0) * self._capacity
        # try_take's admission line, mirrored: >= 1 token for interactive, strictly more
        # than floor + 1 for a floored class (hence the nudge past the boundary).
        required = 1.0 if floor <= 0.0 else floor + 1.0 + 1e-9
        if required > self._capacity:
            return None
        with self._lock:
            now = self._clock()
            self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._refill)
            self._last = now
            deficit = required - self._tokens
        return max(0.0, deficit) / self._refill


class _CircuitBreaker:
    """Trips on a 429 (immediately) or on N consecutive non-429 errors. While OPEN, no
    fetch is allowed for a cooldown; afterwards a single half-open probe decides
    close-vs-reopen. Turns 'Yahoo locked us out' into a brief, self-healing
    degradation instead of a dashboard-wide death."""

    def __init__(self, cooldown, error_threshold, clock):
        self._cooldown = float(cooldown)
        self._threshold = int(error_threshold)
        self._clock = clock
        self._lock = threading.Lock()
        self._state = "closed"            # "closed" | "open" | "half_open"
        self._errors = 0
        self._opened_at = 0.0
        self._probe_in_flight = False

    def allow(self):
        """True if a fetch may proceed now (also performs the open->half_open
        transition once the cooldown has elapsed)."""
        with self._lock:
            if self._state == "closed":
                return True
            if self._state == "open":
                if self._clock() - self._opened_at >= self._cooldown:
                    self._state = "half_open"
                    self._probe_in_flight = True
                    return True
                return False
            # half_open: allow only one probe at a time
            if not self._probe_in_flight:
                self._probe_in_flight = True
                return True
            return False

    def record_success(self):
        with self._lock:
            self._state = "closed"
            self._errors = 0
            self._probe_in_flight = False

    def record_failure(self, rate_limited):
        with self._lock:
            self._probe_in_flight = False
            if self._state == "half_open":      # a failed probe reopens
                self._state = "open"
                self._opened_at = self._clock()
                return
            if rate_limited:                    # a 429 trips immediately
                self._state = "open"
                self._opened_at = self._clock()
                self._errors = 0
                return
            self._errors += 1                   # generic errors accumulate
            if self._errors >= self._threshold:
                self._state = "open"
                self._opened_at = self._clock()
                self._errors = 0

    def record_inconclusive(self):
        """A fetch that neither succeeded nor failed: it ran and brought nothing back.

        Third outcome, not a boolean: an empty result is no evidence Yahoo is healthy
        (so it must not close the breaker or clear the error count) and no evidence it
        is sick (so it must not count towards tripping one). What it MUST do is release
        the probe — otherwise a half-open probe that came back empty leaves
        `_probe_in_flight` True for the life of the process, allow() refuses every
        later fetch, and because is_open() requires state "open" the cooldown reports
        as inactive, so nothing ever tells the frontend to stand down. Half-open
        therefore falls back to open with the cooldown restarted; closed is untouched."""
        with self._lock:
            self._probe_in_flight = False
            if self._state == "half_open":
                self._state = "open"
                self._opened_at = self._clock()

    def is_open(self):
        """True while in cooldown (no probe due yet). Used to signal the frontend."""
        with self._lock:
            return self._state == "open" and (self._clock() - self._opened_at) < self._cooldown

    def retry_after(self):
        with self._lock:
            if self._state != "open":
                return 0
            remaining = self._cooldown - (self._clock() - self._opened_at)
            return max(0, int(remaining + 0.999))


# A refresh lock older than this is a leftover from a crashed run, not a live refresh.
# Same value and same reasoning as start.py's LOCK_MAX_AGE — duplicated rather than
# imported because this module is the lowest layer and must not import start.py.
LOCK_MAX_AGE_SECONDS = 1800.0

RETRY_DELAYS = (2.0, 6.0, 18.0)   # seconds before retry 1/2/3 after a failure
RETRY_JITTER = 0.25               # each delay is scaled by 1 ± this


def _is_rate_limit_error(exc):
    """Best-effort 429 detection across yfinance/curl_cffi versions (the dedicated
    YFRateLimitError isn't present in every build). Moved here from start.py so both
    the server and the generator subprocess share one definition."""
    if "ratelimit" in type(exc).__name__.lower():
        return True
    text = str(exc).lower()
    return "429" in text or "too many requests" in text or "rate limit" in text


def is_batchable(symbol):
    """False for Yahoo's continuous symbols, which the batch endpoint prices
    DIFFERENTLY from the chart series the dashboard draws.

    Measured 2026-08-22: single contracts match their chart series 14/14 at 0.00 %,
    but 14 of 16 `=F` symbols disagree by up to 9.44 % (KC=F quote 324.9 vs chart
    358.75). GC=F chart returns GCQ26 (nearest expiry) while GC=F quote returns
    GCZ26 — two definitions of "continuous" on two endpoints. Splicing the quote onto
    the continuous chart would draw a jump that is not in the market. The two symbols
    that agreed did so only because their front contract currently equals their
    continuous value; that is coincidence."""
    return bool(symbol) and not symbol.endswith("=F")


def _quote_day(row):
    """Exchange-local date of the quote. Verified to match the chart path's
    hist.index[-1].strftime("%Y-%m-%d")."""
    t = row.get("regularMarketTime")
    if not isinstance(t, (int, float)):
        return None
    offset = (row.get("gmtOffSetMilliseconds") or 0) / 1000.0
    return datetime.datetime.utcfromtimestamp(t + offset).strftime("%Y-%m-%d")


def _num(v):
    return round(float(v), 4) if isinstance(v, (int, float)) else None


class YahooGateway:
    """Budget + retry in front of Yahoo. `call()` wraps ANY callable — yfinance keeps
    doing the actual fetching, this decides whether and when it may."""

    def __init__(self, capacity, refill_per_sec, clock=time.monotonic,
                 sleep_fn=time.sleep, rng=random.random, lock_path=None,
                 session_factory=None, json_fetcher=None,
                 lock_max_age=LOCK_MAX_AGE_SECONDS):
        self._clock = clock
        self._lock_max_age = float(lock_max_age)
        self._sleep = sleep_fn
        self._rng = rng
        self._lock_path = lock_path
        self._session_factory = session_factory
        self._json_fetcher = json_fetcher
        self._session = None
        self._session_lock = threading.Lock()
        self._bucket = _TokenBucket(capacity, refill_per_sec, clock)
        self._breaker = _CircuitBreaker(
            LIVE_BREAKER_COOLDOWN_SECONDS, LIVE_BREAKER_ERROR_THRESHOLD, clock)

    def _delay(self, base):
        return round(base * (1.0 + (self._rng() * 2.0 - 1.0) * RETRY_JITTER), 6)

    def session(self):
        """The shared browser-impersonating session. Cookie/crumb reuse plus a Chrome
        fingerprint is what cuts Yahoo 429s at the source — the live path has had this
        since day one; the generator never did. None means 'no session available',
        which every caller must treat as 'use a bare Ticker'."""
        if self._session is not None:
            return self._session
        with self._session_lock:
            if self._session is None and self._session_factory is not None:
                try:
                    self._session = self._session_factory()
                except Exception:
                    self._session = None
        return self._session

    def _refresh_running(self):
        """A board refresh holds ff_data/refresh.lock. The generator subprocess cannot
        share our bucket, so while it runs we stand down to interactive only rather
        than invent an IPC protocol for a once-a-night event.

        Existence alone is not enough: a refresh killed mid-run (crash, power loss)
        leaves the file behind, and a bare exists() would then disable preload and bulk
        for good. The mtime has to be recent too — the age half of start.py's
        `_lock_is_active` (its pid check needs the file's JSON, which is start.py's
        format to own, not this layer's). Wall clock deliberately: it is compared against
        a filesystem mtime, so self._clock (monotonic, or a test's fake) cannot be used."""
        if not self._lock_path:
            return False
        try:
            age = time.time() - os.path.getmtime(self._lock_path)
        except OSError:
            return False                       # gone between the check and the stat
        return age <= self._lock_max_age

    def _acquire(self, priority):
        """Take a token, waiting for one if this class is allowed to (_PRIORITY_MAX_WAIT).

        Deliberately counts the wait it ASKED for rather than reading the clock: the
        offline tests drive this with a frozen FakeClock and a sleep double that records
        instead of sleeping, and a clock-based deadline would never expire under them.
        Every iteration costs at least _MIN_WAIT_STEP, so contention between the refresh
        workers cannot turn this into a spin."""
        if self._bucket.try_take(priority):
            return True
        budget = _PRIORITY_MAX_WAIT.get(priority, 0.0)
        waited = 0.0
        while waited < budget:
            wait = self._bucket.seconds_until_token(priority)
            if wait is None:            # no refill / unreachable floor — waiting is futile
                return False
            wait = max(wait, _MIN_WAIT_STEP)
            if waited + wait > budget:
                return False            # the token is further away than we may wait
            self._sleep(wait)
            waited += wait
            if self._bucket.try_take(priority):
                return True
        return False

    def call(self, fn, priority=PRIORITY_INTERACTIVE, default=None):
        """Run `fn` under the budget. Returns `default` if the budget or the breaker
        refuses outright; once retries are exhausted, raises RateLimitedError for a
        rate-limited failure (even if `fn` raised some OTHER exception type that merely
        *looked* rate-limited to `_is_rate_limit_error` — this is the ONE place that
        classification is normalised, so every caller can catch one type regardless of
        which yfinance exception class actually carried the 429) and re-raises the
        original exception unchanged for anything else.
        PRIORITY_INTERACTIVE never retries — a stale on-screen candle beats a blocked
        request thread."""
        retries = () if priority == PRIORITY_INTERACTIVE else RETRY_DELAYS
        if priority != PRIORITY_INTERACTIVE and self._refresh_running():
            return default
        if not self._breaker.allow():
            return default
        last_exc, rate_limited = None, False
        for attempt in range(len(retries) + 1):
            # The breaker is consulted ONCE, above. Re-checking it inside the loop would
            # make the backoff dead code: a 429 opens the breaker immediately, so attempt
            # 2 would always be refused. For a recoverable 429 the backoff sleep IS the
            # cooldown; the breaker is for failures we could not recover from.
            if not self._acquire(priority):
                if last_exc is None:
                    return default
                break
            try:
                out = fn()
            except RateLimitedError as e:
                last_exc, rate_limited = e, True
            except Exception as e:                      # noqa: BLE001 — policy is uniform
                last_exc, rate_limited = e, _is_rate_limit_error(e)
            else:
                self._breaker.record_success()
                return out
            if attempt < len(retries):
                self._sleep(self._delay(retries[attempt]))
        # Every attempt spent. NOW the breaker hears about it, so one caller's exhausted
        # retries stand the others down instead of each rediscovering the outage.
        self._breaker.record_failure(rate_limited=rate_limited)
        if rate_limited and not isinstance(last_exc, RateLimitedError):
            # `fn` raised yfinance's own exception class (or curl_cffi's, or whatever)
            # and `_is_rate_limit_error` recognised its message/type as a 429. Without
            # this, only an INJECTED RateLimitedError would ever surface as one — every
            # real yfinance rate-limit exception would instead reach a caller's generic
            # `except Exception`, indistinguishable from a genuinely empty result. That
            # is exactly the failure the dead-symbol memo (dead_symbols.py) exists to
            # avoid, so the normalisation happens once, here, for every caller at once.
            raise RateLimitedError(str(last_exc)) from last_exc
        raise last_exc

    def cooldown_active(self):
        return self._breaker.is_open()

    def retry_after(self):
        return self._breaker.retry_after()

    def _fetch_json(self, url, params):
        if self._json_fetcher is not None:
            return self._json_fetcher(url, params)
        from yfinance import data as ydata          # imported late: tests never need it
        try:
            return ydata.YfData().get_raw_json(url=url, params=params)
        except Exception as e:
            if _is_rate_limit_error(e):
                raise RateLimitedError(str(e))
            raise

    def quotes(self, symbols, priority=PRIORITY_INTERACTIVE, status=None):
        """One request for many SINGLE-CONTRACT symbols. Returns only the symbols that
        came back with a usable price; anything missing (a continuous symbol, a failed
        batch, a row without a price) is simply absent, and the caller falls back to the
        per-symbol chart path.

        `status` is an optional out-dict, because the returned map cannot tell the two
        empties apart: "the batch ran and nothing was usable" and "the batch never ran"
        both come back as {}. Callers that treat a failure as a failure (the live cache's
        breaker) need the difference; the rest can keep ignoring it, because quotes()
        still never raises. Keys, all always set:
          ran          — at least one chunk got a response back
          declined     — at least one chunk was refused (budget/breaker) or failed
          rate_limited — at least one chunk failed with a normalised 429
        """
        if status is not None:
            status.update({"ran": False, "declined": False, "rate_limited": False})
        wanted = [s for s in dict.fromkeys(symbols or []) if is_batchable(s)]
        out = {}
        for i in range(0, len(wanted), QUOTE_BATCH_SIZE):
            chunk = wanted[i:i + QUOTE_BATCH_SIZE]
            params = {"symbols": ",".join(chunk)}
            try:
                raw = self.call(lambda: self._fetch_json(QUOTE_ENDPOINT, params),
                                priority=priority, default=None)
            except RateLimitedError:
                raw = None                          # degrade; never break the overlay
                if status is not None:
                    status["rate_limited"] = True
            except Exception:
                raw = None
            if status is not None:
                # `default` (None) is what call() returns when the budget or the breaker
                # refused outright, so None here covers both refusals and failures.
                status["declined" if raw is None else "ran"] = True
            for row in ((raw or {}).get("quoteResponse") or {}).get("result") or []:
                symbol = row.get("symbol")
                price = _num(row.get("regularMarketPrice"))
                day = _quote_day(row)
                if not symbol or price is None or not day:
                    continue
                out[symbol] = {
                    "day": day, "price": price,
                    "open": _num(row.get("regularMarketOpen")),
                    "high": _num(row.get("regularMarketDayHigh")),
                    "low": _num(row.get("regularMarketDayLow")),
                    "state": row.get("marketState"),
                }
        return out


_instance = None
_instance_lock = threading.Lock()


def gateway():
    """The process-wide gateway. Falls back to conservative defaults if configure()
    was never called (e.g. a test or a script importing fetch_yfinance directly)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = YahooGateway(capacity=20, refill_per_sec=2.0)
    return _instance


def configure(**kwargs):
    """Install the process-wide gateway. Call ONCE, before first use: start.py for
    the server profile, commodity_dashboard.py for the generator profile."""
    global _instance
    with _instance_lock:
        _instance = YahooGateway(**kwargs)
    return _instance
