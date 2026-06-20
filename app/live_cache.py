# ── live_cache.py ── Server-side, RAM-only request-collapsing layer in front of
# Yahoo for the live-price overlay. A TTL cache + per-symbol single-flight + a global
# token-bucket rate cap + a 429 circuit breaker. Holds the still-forming (unsettled)
# tick in memory ONLY — never written to JSON, SQLite, or any persisted store, so the
# settled-EoD invariant is untouched. Peer of eod_store.py; NOT part of the generator
# DAG. Network-agnostic: the actual Yahoo fetch is injected as `fetch_fn` (start.py),
# which keeps this module fully unit-testable with a fake clock + fake fetcher.

import threading
import time

# ── Tuning (server-side) ──────────────────────────────────────────────────────
LIVE_TTL_SECONDS = 20.0               # outbound Yahoo rate per symbol is bounded at 1/TTL
# Burst size must cover the largest single on-screen poll batch: a get_many() fetches
# its symbols sequentially and only the first CAPACITY *cold* ones win a token — the rest
# fall back to last-known (empty until first fetched). 3 was sized for the futures
# priority set {active, front, cont}; the Weekly Outlook polls one symbol per rendered
# 4/4+3/4 chart (front-month contracts since the front-month change), which routinely
# exceeds 3, so charts past the third were starved of a live candle every tick. Sized to
# cover a realistic Weekly-Outlook batch (and the futures forward-curve prewarm). Steady
# state is still bounded by the per-symbol TTL (1 fetch/symbol/TTL); the refill only needs
# to keep that set warm, and the 429 breaker remains the real overload backstop.
LIVE_RATE_CAPACITY = 20.0            # token bucket: burst size (largest on-screen batch)
LIVE_RATE_REFILL_PER_SEC = 2.0       # token bucket: steady-state refill
LIVE_BREAKER_COOLDOWN_SECONDS = 90.0  # how long the breaker stays open after a 429
LIVE_BREAKER_ERROR_THRESHOLD = 3      # consecutive non-429 errors that also trip it
LIVE_FETCH_TIMEOUT_SECONDS = 8.0      # advisory timeout for the injected fetch_fn (start.py)


class RateLimitedError(Exception):
    """Raised by an injected fetch_fn when Yahoo signals 429 / rate limiting."""


class _TokenBucket:
    """Global outbound-rate cap. try_take() is NON-blocking: no token -> the caller
    serves the last-known value instead of queuing (queuing is what piled up the
    server threads in the first place)."""

    def __init__(self, capacity, refill_per_sec, clock):
        self._capacity = float(capacity)
        self._refill = float(refill_per_sec)
        self._clock = clock
        self._tokens = float(capacity)
        self._last = clock()
        self._lock = threading.Lock()

    def try_take(self):
        with self._lock:
            now = self._clock()
            self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._refill)
            self._last = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False


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


class LiveQuoteCache:
    """Read-through TTL cache with per-symbol single-flight. `fetch_fn(symbol)` returns
    {"day","price"} (or a None-valued row) and raises RateLimitedError on a 429. One
    instance is shared by all server request threads, so the cache dedups across browser
    tabs as well as across rapid polls."""

    # The public quote shape. `open`/`high`/`low` are optional intraday OHLC of the
    # still-forming bar (for a real live candle); `day`/`price` are always present.
    _QUOTE_FIELDS = ("day", "price", "open", "high", "low")
    _EMPTY = {k: None for k in _QUOTE_FIELDS}

    @classmethod
    def _view(cls, e):
        """Public quote dict from a stored entry (drops the internal `ts`)."""
        return {k: e.get(k) for k in cls._QUOTE_FIELDS}

    def __init__(self, fetch_fn, ttl=LIVE_TTL_SECONDS, clock=time.monotonic,
                 bucket=None, breaker=None):
        self._fetch_fn = fetch_fn
        self._ttl = float(ttl)
        self._clock = clock
        self._entries = {}                # symbol -> {"day","price","ts"}
        self._map_lock = threading.Lock()
        self._sym_locks = {}              # symbol -> threading.Lock (single-flight)
        self._bucket = bucket if bucket is not None else _TokenBucket(
            LIVE_RATE_CAPACITY, LIVE_RATE_REFILL_PER_SEC, clock)
        self._breaker = breaker if breaker is not None else _CircuitBreaker(
            LIVE_BREAKER_COOLDOWN_SECONDS, LIVE_BREAKER_ERROR_THRESHOLD, clock)

    def _sym_lock(self, symbol):
        with self._map_lock:
            lk = self._sym_locks.get(symbol)
            if lk is None:
                lk = threading.Lock()
                self._sym_locks[symbol] = lk
            return lk

    def _fresh(self, symbol):
        with self._map_lock:
            e = self._entries.get(symbol)
            if e is not None and (self._clock() - e["ts"]) < self._ttl:
                return self._view(e)
            return None

    def _last_known(self, symbol):
        with self._map_lock:
            e = self._entries.get(symbol)
            if e is not None:
                return self._view(e)
            return dict(self._EMPTY)

    def _store(self, symbol, row):
        with self._map_lock:
            entry = self._view(row)
            entry["ts"] = self._clock()
            self._entries[symbol] = entry

    def get(self, symbol):
        fresh = self._fresh(symbol)
        if fresh is not None:
            return fresh                              # hot path: zero Yahoo calls
        with self._sym_lock(symbol):
            fresh = self._fresh(symbol)               # double-check after acquiring the lock
            if fresh is not None:
                return fresh
            if not self._breaker.allow():
                return self._last_known(symbol)
            if not self._bucket.try_take():
                return self._last_known(symbol)
            try:
                row = self._fetch_fn(symbol)
            except RateLimitedError:
                self._breaker.record_failure(rate_limited=True)
                return self._last_known(symbol)
            except Exception:
                self._breaker.record_failure(rate_limited=False)
                return self._last_known(symbol)
            self._breaker.record_success()
            if row and row.get("price") is not None and row.get("day"):
                self._store(symbol, row)
                return self._view(row)
            return self._last_known(symbol)

    def get_many(self, symbols):
        return {s: self.get(s) for s in symbols}

    def cooldown_active(self):
        return self._breaker.is_open()

    def retry_after(self):
        return self._breaker.retry_after()
