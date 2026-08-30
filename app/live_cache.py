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
# Must stay SHORTER than web/live.js's LIVE_QUOTE_INTERVAL_MS (15 s), or the two beat
# against each other: at 20 s a 15 s poll alternated miss/hit/miss/hit, so a genuinely
# new price reached the on-screen candle only every 30 s while half the requests
# returned an identical body and `_liveTickActive`'s `changed` guard skipped the
# repaint. The gap absorbs setTimeout jitter (observed ticks: 15.0-15.3 s). Raising
# this above the poll interval re-breaks the live candle silently — test_live_cache.py's
# LivePollCadenceTest reads both constants and is the only thing guarding the pair.
LIVE_TTL_SECONDS = 10.0               # outbound Yahoo rate per symbol is bounded at 1/TTL
# Burst size must cover the largest single on-screen poll batch: a get_many() fetches
# its symbols sequentially and only the first CAPACITY *cold* ones win a token — the rest
# fall back to last-known (empty until first fetched). 3 was sized for the futures
# priority set {active, front, cont}; the Weekly Outlook polls one symbol per rendered
# 3/3+2/3 chart (front-month contracts since the front-month change), which routinely
# exceeds 3, so charts past the third were starved of a live candle every tick. Sized to
# cover a realistic Weekly-Outlook batch (and the futures forward-curve prewarm). Steady
# state is still bounded by the per-symbol TTL (1 fetch/symbol/TTL); the refill only needs
# to keep that set warm, and the 429 breaker remains the real overload backstop.
LIVE_RATE_CAPACITY = 20.0            # token bucket: burst size (largest on-screen batch)
LIVE_RATE_REFILL_PER_SEC = 2.0       # token bucket: steady-state refill
LIVE_FETCH_TIMEOUT_SECONDS = 8.0      # advisory timeout for the injected fetch_fn (start.py)

# The rate cap, the breaker, the breaker tuning and the 429 signal moved to
# yahoo_gateway.py so the generator subprocess shares them. Re-exported here because
# start.py and test_live_cache.py reach for them through this module.
from yahoo_gateway import (          # noqa: F401  (re-export)
    RateLimitedError,
    _TokenBucket,
    _CircuitBreaker,
    PRIORITY_INTERACTIVE,
    LIVE_BREAKER_COOLDOWN_SECONDS,
    LIVE_BREAKER_ERROR_THRESHOLD,
)


class LiveQuoteCache:
    """Read-through TTL cache with per-BATCH single-flight.

    `fetch_many(symbols, priority=...)` returns {symbol: row} for whatever it could serve
    and raises RateLimitedError on a 429. One instance is shared by all server request
    threads, so the cache dedups across browser tabs as well as across rapid polls.

    The contract used to be `fetch_fn(symbol)` — one Yahoo request per symbol, which is
    what the bucket, the breaker and the whole rationing apparatus were sized around.
    Yahoo's batch quote endpoint serves ~100 symbols in one request, so the expensive
    resource is the REQUEST, not the symbol; single-flight moved to the batch for the
    same reason."""

    # The public quote shape. `open`/`high`/`low` are optional intraday OHLC of the
    # still-forming bar (for a real live candle); `day`/`price` are always present.
    # `state` is Yahoo's marketState ("REGULAR"/"CLOSED"/...), which the frontend uses to
    # stand the live poller down outside exchange hours.
    _QUOTE_FIELDS = ("day", "price", "open", "high", "low", "state")
    _EMPTY = {k: None for k in _QUOTE_FIELDS}

    @classmethod
    def _view(cls, e):
        """Public quote dict from a stored entry (drops the internal `ts`)."""
        return {k: e.get(k) for k in cls._QUOTE_FIELDS}

    def __init__(self, fetch_many, ttl=LIVE_TTL_SECONDS, clock=time.monotonic,
                 bucket=None, breaker=None):
        self._fetch_many = fetch_many
        self._ttl = float(ttl)
        self._clock = clock
        self._entries = {}                # symbol -> {"day","price",...,"ts"}
        self._map_lock = threading.Lock()
        self._batch_lock = threading.Lock()   # single-flight: one upstream batch at a time
        self._bucket = bucket if bucket is not None else _TokenBucket(
            LIVE_RATE_CAPACITY, LIVE_RATE_REFILL_PER_SEC, clock)
        self._breaker = breaker if breaker is not None else _CircuitBreaker(
            LIVE_BREAKER_COOLDOWN_SECONDS, LIVE_BREAKER_ERROR_THRESHOLD, clock)

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

    def get(self, symbol, priority=PRIORITY_INTERACTIVE):
        """One symbol, routed through the batch path so there is ONE fetch code path and
        one place the breaker and the rate cap are consulted."""
        return self.get_many([symbol], priority=priority)[symbol]

    def get_many(self, symbols, priority=PRIORITY_INTERACTIVE):
        """Serve every symbol, issuing at most one upstream batch for the stale ones."""
        symbols = list(dict.fromkeys(symbols))
        out, stale = {}, []
        for s in symbols:
            fresh = self._fresh(s)
            if fresh is not None:
                out[s] = fresh                        # hot path: zero Yahoo calls
            else:
                stale.append(s)
        if not stale:
            return out

        # Single-flight is NON-BLOCKING, deliberately: whoever holds the lock is already
        # asking Yahoo, and at preload priority the gateway may sleep through a 2/6/18 s
        # backoff before it answers. Waiting our turn would park an interactive request
        # thread for up to half a minute behind a warm-up batch — the priority system
        # rations tokens, not this lock. Same rule the bucket already follows: no slot ->
        # serve the last-known value instead of queuing.
        if self._batch_lock.acquire(blocking=False):
            try:
                # Re-check under the lock: another thread's batch may have filled these
                # while we waited, in which case we must not pay for a second request.
                still_stale = [s for s in stale if self._fresh(s) is None]
                if still_stale and self._breaker.allow() and self._bucket.try_take(priority):
                    try:
                        rows = self._fetch_many(still_stale, priority=priority) or {}
                    except RateLimitedError:
                        self._breaker.record_failure(rate_limited=True)
                        rows = {}
                    except Exception:
                        self._breaker.record_failure(rate_limited=False)
                        rows = {}
                    else:
                        # THREE outcomes, not two — collapsing this back into
                        # success/failure is what wedged the breaker once already.
                        # Only a fetch that actually brought rows back counts as a
                        # success: a batch that ran and served nothing says nothing about
                        # Yahoo's health, and closing the breaker on it would let a
                        # silently-failing fetcher hold the breaker shut forever. But an
                        # empty batch is not a failure either — a pure budget decline
                        # returns {} without raising (start.py's _live_fetch_many) — so it
                        # must not count towards tripping the breaker. That leaves the
                        # third case, which needs its own call: if this batch WAS the
                        # half-open probe, dropping it on the floor strands the probe
                        # in flight forever and no live quote is ever fetched again.
                        # record_inconclusive() releases the probe and restarts the
                        # cooldown without touching the error count.
                        if rows:
                            self._breaker.record_success()
                        else:
                            self._breaker.record_inconclusive()
                        for sym, row in rows.items():
                            if row and row.get("price") is not None and row.get("day"):
                                self._store(sym, row)
            finally:
                self._batch_lock.release()
        # Anything the batch could not serve falls back to its last known value, exactly
        # as the per-symbol path did — a stale price beats a blank chart.
        for s in stale:
            fresh = self._fresh(s)
            out[s] = fresh if fresh is not None else self._last_known(s)
        return out

    def cooldown_active(self):
        return self._breaker.is_open()

    def retry_after(self):
        return self._breaker.retry_after()
