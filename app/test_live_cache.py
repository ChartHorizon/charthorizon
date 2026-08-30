# ── test_live_cache.py ── Stdlib-only unit tests for the live-quote cache logic.
# Run from app/:  python3 -m unittest test_live_cache -v
# No network and no real sleeps (except the one threaded single-flight test): a
# FakeClock + a recording fake fetch make every path deterministic.

import pathlib
import re
import unittest

import live_cache as lc


class FakeClock:
    """Callable monotonic-clock double. advance() moves time forward by hand."""
    def __init__(self, t=1000.0):
        self.t = float(t)
    def __call__(self):
        return self.t
    def advance(self, dt):
        self.t += float(dt)


class TokenBucketTest(unittest.TestCase):
    def test_takes_up_to_capacity_then_refuses(self):
        b = lc._TokenBucket(capacity=3, refill_per_sec=1, clock=FakeClock())
        self.assertTrue(b.try_take())
        self.assertTrue(b.try_take())
        self.assertTrue(b.try_take())
        self.assertFalse(b.try_take())          # bucket empty

    def test_refills_over_time(self):
        clk = FakeClock()
        b = lc._TokenBucket(capacity=3, refill_per_sec=1, clock=clk)
        for _ in range(3):
            b.try_take()
        self.assertFalse(b.try_take())
        clk.advance(1.0)                        # one token back
        self.assertTrue(b.try_take())
        self.assertFalse(b.try_take())

    def test_refill_caps_at_capacity(self):
        clk = FakeClock()
        b = lc._TokenBucket(capacity=2, refill_per_sec=1, clock=clk)
        clk.advance(100.0)                      # would overflow without the cap
        self.assertTrue(b.try_take())
        self.assertTrue(b.try_take())
        self.assertFalse(b.try_take())


class CircuitBreakerTest(unittest.TestCase):
    def _br(self, clk):
        return lc._CircuitBreaker(cooldown=90, error_threshold=3, clock=clk)

    def test_starts_closed(self):
        br = self._br(FakeClock())
        self.assertTrue(br.allow())
        self.assertFalse(br.is_open())

    def test_rate_limit_opens_immediately(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=True)
        self.assertTrue(br.is_open())
        self.assertFalse(br.allow())            # blocked during cooldown
        self.assertEqual(br.retry_after(), 90)

    def test_consecutive_errors_open(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=False)
        br.record_failure(rate_limited=False)
        self.assertTrue(br.allow())             # still closed after 2
        br.record_failure(rate_limited=False)
        self.assertFalse(br.allow())            # tripped on the 3rd

    def test_half_open_probe_then_close_on_success(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=True)
        clk.advance(90.0)
        self.assertFalse(br.is_open())          # cooldown elapsed -> probe due
        self.assertTrue(br.allow())             # first probe allowed
        self.assertFalse(br.allow())            # second blocked while probe in flight
        br.record_success()
        self.assertTrue(br.allow())             # closed again

    def test_half_open_probe_failure_reopens(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=True)
        clk.advance(90.0)
        self.assertTrue(br.allow())             # probe
        br.record_failure(rate_limited=False)
        self.assertFalse(br.allow())            # reopened for another cooldown
        self.assertEqual(br.retry_after(), 90)


# The cache's public quote shape (`LiveQuoteCache._QUOTE_FIELDS`): `day`/`price` are
# always present, `open`/`high`/`low` carry the still-forming bar's intraday OHLC so the
# overlay can draw a real live candle. Every get() returns exactly these five keys —
# short rows are padded with None, unknown keys are dropped — which is why the tests
# below compare whole dicts instead of picking fields out.
QUOTE = {"day": "2026-06-10", "price": 100.0, "open": 98.5, "high": 100.75,
         "low": 98.25, "state": "REGULAR"}
EMPTY = {"day": None, "price": None, "open": None, "high": None, "low": None,
         "state": None}


class RecordingFetch:
    """fetch_many double: returns a canned row per symbol and records each BATCH.
    mode switches behavior: 'ok' | 'ratelimit' (raise RateLimitedError) |
    'error' (raise RuntimeError) | 'empty' (serve nothing)."""
    def __init__(self, row=None):
        self.row = dict(row) if row is not None else dict(QUOTE)
        self.batches = []
        self.mode = "ok"

    @property
    def calls(self):
        """Flat symbol list, so the pre-batch assertions still read naturally."""
        return [s for batch in self.batches for s in batch]

    def __call__(self, symbols, priority=None):
        symbols = list(symbols)
        self.batches.append(symbols)
        if self.mode == "ratelimit":
            raise lc.RateLimitedError("429 Too Many Requests")
        if self.mode == "error":
            raise RuntimeError("boom")
        if self.mode == "empty":
            return {}
        return {s: dict(self.row) for s in symbols}


class LiveQuoteCacheTest(unittest.TestCase):
    def _cache(self, fetch, clk, bucket=None):
        # Unlimited bucket by default so these tests isolate the TTL/breaker behavior.
        bucket = bucket if bucket is not None else lc._TokenBucket(1000, 1000, clk)
        breaker = lc._CircuitBreaker(90, 3, clk)
        return lc.LiveQuoteCache(fetch, ttl=20.0, clock=clk, bucket=bucket, breaker=breaker)

    def test_cold_triggers_one_fetch(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"), QUOTE)
        self.assertEqual(fetch.calls, ["CL=F"])

    def test_short_row_is_padded_to_the_quote_shape(self):
        # A fetcher that reports no intraday OHLC (or an older two-field row) must still
        # produce the full quote shape, so callers can read q["open"] or q["state"]
        # without a guard.
        clk = FakeClock(); fetch = RecordingFetch({"day": "2026-06-10", "price": 100.0})
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"),
                         {"day": "2026-06-10", "price": 100.0, "open": None,
                          "high": None, "low": None, "state": None})

    def test_unknown_fetch_keys_are_dropped(self):
        # The quote is a fixed contract, not a passthrough: whatever else a fetch_fn
        # carries (here the entry's internal `ts` twin) must not reach the client.
        clk = FakeClock()
        fetch = RecordingFetch(dict(QUOTE, volume=12345, ts=999.0))
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"), QUOTE)

    def test_within_ttl_served_from_cache(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F")
        clk.advance(19.0)
        self.assertEqual(c.get("CL=F"), QUOTE)           # cached view keeps the OHLC
        self.assertEqual(fetch.calls, ["CL=F"])          # only one fetch within the TTL

    def test_after_ttl_refetches(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F")
        clk.advance(21.0)
        c.get("CL=F")
        self.assertEqual(fetch.calls, ["CL=F", "CL=F"])

    def test_rate_limit_serves_last_known_and_opens_breaker(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F")                                    # warm
        clk.advance(21.0)
        fetch.mode = "ratelimit"
        out = c.get("CL=F")
        self.assertEqual(out, QUOTE)                     # last-known, OHLC included
        self.assertTrue(c.cooldown_active())
        self.assertGreater(c.retry_after(), 0)

    def test_cold_rate_limit_returns_empty(self):
        clk = FakeClock(); fetch = RecordingFetch(); fetch.mode = "ratelimit"
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"), EMPTY)

    def test_no_fetch_while_breaker_open(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F"); clk.advance(21.0)
        fetch.mode = "ratelimit"
        c.get("CL=F")                                    # opens the breaker
        n = len(fetch.calls)
        clk.advance(21.0)                                # cache stale, but breaker still open
        c.get("CL=F")
        self.assertEqual(len(fetch.calls), n)            # no fetch while open

    def test_no_token_serves_last_known(self):
        clk = FakeClock(); fetch = RecordingFetch()
        bucket = lc._TokenBucket(1, 0, clk)              # capacity 1, NO refill
        c = self._cache(fetch, clk, bucket=bucket)
        c.get("CL=F")                                    # consumes the only token, warms cache
        clk.advance(21.0)                                # cache stale; bucket never refills
        out = c.get("CL=F")
        self.assertEqual(out, QUOTE)                     # last-known, no fetch
        self.assertEqual(len(fetch.calls), 1)

    def test_empty_row_serves_last_known(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F"); clk.advance(21.0)
        fetch.mode = "empty"
        self.assertEqual(c.get("CL=F"), QUOTE)

    def test_get_many(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        out = c.get_many(["CL=F", "GC=F"])
        self.assertEqual(set(out.keys()), {"CL=F", "GC=F"})

    def test_single_flight_one_fetch_under_concurrency(self):
        import threading as _th, time as _time
        clk = FakeClock()
        gate = _th.Event()
        started = _th.Semaphore(0)
        calls, calls_lock = [], _th.Lock()
        row = dict(QUOTE)
        def slow_fetch(symbols, priority=None):
            with calls_lock:
                calls.append(list(symbols))
            started.release()
            gate.wait(2.0)                               # hold the batch lock
            return {s: dict(row) for s in symbols}
        c = self._cache(slow_fetch, clk)
        results, res_lock = [], _th.Lock()
        def worker():
            r = c.get("CL=F")
            with res_lock:
                results.append(r)
        threads = [_th.Thread(target=worker) for _ in range(5)]
        for t in threads:
            t.start()
        started.acquire(timeout=2.0)                     # first fetch is now in flight
        _time.sleep(0.05)                                # the other 4 meet a held lock
        gate.set()                                       # release the in-flight fetch
        for t in threads:
            t.join(2.0)
        self.assertEqual(len(calls), 1)                  # single-flight: one BATCH for five callers
        self.assertEqual(len(results), 5)
        # The four that lost the lock do NOT queue behind the in-flight batch (see
        # test_a_held_batch_lock_never_blocks_a_caller): on a cold cache they serve blank.
        self.assertIn(QUOTE, results)

    def test_a_held_batch_lock_never_blocks_a_caller(self):
        """I2: single-flight is non-blocking. A preload batch can sit in the gateway's
        2/6/18 s backoff; an interactive caller must serve last-known and return, not
        park a request thread behind it on a process-wide lock."""
        import threading as _th
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F")                                    # warm, so there IS a last-known
        clk.advance(21.0)                                # ...and it is now stale
        fetch.batches.clear()

        c._batch_lock.acquire()                          # stand in for a batch in flight
        try:
            done = _th.Event()
            out = {}
            def worker():
                out["q"] = c.get("CL=F")
                done.set()
            _th.Thread(target=worker).start()
            self.assertTrue(done.wait(1.0), "get() blocked on the batch lock")
        finally:
            c._batch_lock.release()
        self.assertEqual(out["q"], QUOTE)                # last-known, served immediately
        self.assertEqual(fetch.batches, [])              # and no second request

    def test_a_batch_that_serves_nothing_does_not_reset_the_breaker(self):
        """I3: record_success() is gated on rows actually coming back. An empty batch
        says nothing about Yahoo's health, and closing the breaker on one let a
        silently-failing fetcher hold the breaker shut forever."""
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c._breaker.record_failure(rate_limited=False)
        c._breaker.record_failure(rate_limited=False)    # 2 of 3 towards tripping
        fetch.mode = "empty"
        c.get_many(["CL=F"])
        self.assertEqual(c._breaker._errors, 2)          # not reset by the empty batch
        fetch.mode = "ok"
        clk.advance(21.0)
        c.get_many(["CL=F"])
        self.assertEqual(c._breaker._errors, 0)          # a batch WITH rows still closes it

    def test_an_empty_half_open_probe_does_not_wedge_the_breaker(self):
        """The other half of I3. Gating record_success() on rows left a third outcome
        unhandled: a half-open PROBE that returns empty without raising (what a pure
        budget decline does). Nothing then called record_success() or record_failure(),
        so the breaker sat in half_open with the probe in flight forever — allow() said
        no to every later fetch, while is_open() (state must be "open") said there was
        no cooldown, so /api/live-quote never answered 429 and the frontend polled
        nulls for good. The assertion that matters is the last one: it recovers."""
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)

        fetch.mode = "ratelimit"
        c.get_many(["CL=F"])
        self.assertTrue(c.cooldown_active())             # open, cooling down
        self.assertEqual(c.retry_after(), 90)

        clk.advance(90.0)                                # cooldown elapsed -> probe due
        fetch.mode = "empty"                             # ...and the probe serves nothing
        fetch.batches.clear()
        self.assertEqual(c.get_many(["CL=F"])["CL=F"], EMPTY)
        self.assertEqual(fetch.batches, [["CL=F"]])      # the probe really did run
        self.assertNotEqual(c._breaker._state, "half_open")   # not stranded
        self.assertFalse(c._breaker._probe_in_flight)
        self.assertTrue(c.cooldown_active())             # and it tells the truth again
        self.assertEqual(c.retry_after(), 90)            # cooldown restarted from here
        self.assertEqual(c._breaker._errors, 0)          # empty is not an error either

        clk.advance(89.0)                                # still inside the new cooldown
        fetch.mode = "ok"
        fetch.batches.clear()
        c.get_many(["CL=F"])
        self.assertEqual(fetch.batches, [])              # breaker still holding it shut

        clk.advance(1.0)                                 # cooldown elapsed again
        self.assertEqual(c.get_many(["CL=F"])["CL=F"], QUOTE)   # a real quote, at last
        self.assertEqual(fetch.batches, [["CL=F"]])      # the fetcher was actually reached
        self.assertFalse(c.cooldown_active())
        self.assertEqual(c._breaker._state, "closed")


class BatchTest(unittest.TestCase):
    """The batch contract itself: one request for the stale symbols, never for the fresh."""

    def _cache(self, fetch, clk):
        return lc.LiveQuoteCache(fetch, ttl=20.0, clock=clk,
                                 bucket=lc._TokenBucket(1000, 1000, clk),
                                 breaker=lc._CircuitBreaker(90, 3, clk))

    def test_get_many_issues_one_batch(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get_many(["CL=F", "GC=F", "SI=F"])
        self.assertEqual(len(fetch.batches), 1)
        self.assertEqual(fetch.batches[0], ["CL=F", "GC=F", "SI=F"])

    def test_only_the_stale_symbols_go_into_the_batch(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get_many(["CL=F", "GC=F"])
        clk.advance(5.0)                                  # still inside the TTL
        fetch.batches.clear()
        c.get_many(["CL=F", "GC=F", "SI=F"])
        self.assertEqual(fetch.batches, [["SI=F"]])

    def test_an_all_fresh_batch_issues_no_request(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get_many(["CL=F"])
        fetch.batches.clear()
        c.get_many(["CL=F"])
        self.assertEqual(fetch.batches, [])

    def test_a_duplicate_symbol_is_requested_once(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        out = c.get_many(["CL=F", "CL=F"])
        self.assertEqual(fetch.batches, [["CL=F"]])
        self.assertEqual(out["CL=F"], QUOTE)

    def test_a_symbol_missing_from_the_response_serves_last_known(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get_many(["CL=F"])
        clk.advance(21.0)
        fetch.mode = "empty"                              # batch comes back with nothing
        self.assertEqual(c.get("CL=F"), QUOTE)            # last known, not blank

    def test_a_rate_limited_batch_opens_the_breaker_and_serves_last_known(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get_many(["CL=F"])
        clk.advance(21.0)
        fetch.mode = "ratelimit"
        self.assertEqual(c.get_many(["CL=F"])["CL=F"], QUOTE)
        self.assertTrue(c.cooldown_active())

    def test_a_cold_symbol_the_batch_cannot_serve_is_blank_not_missing(self):
        clk = FakeClock(); fetch = RecordingFetch()
        fetch.mode = "empty"
        c = self._cache(fetch, clk)
        out = c.get_many(["CL=F"])
        self.assertEqual(out["CL=F"], EMPTY)               # present and blank, never a KeyError

    def test_state_is_carried_through(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F")["state"], "REGULAR")

    def test_priority_reaches_the_fetcher(self):
        clk = FakeClock(); seen = []
        def fetch(symbols, priority=None):
            seen.append(priority)
            return {s: dict(QUOTE) for s in symbols}
        c = self._cache(fetch, clk)
        c.get_many(["CL=F"], priority=lc.PRIORITY_INTERACTIVE)
        self.assertEqual(seen, [lc.PRIORITY_INTERACTIVE])


class LiveFetchManyTest(unittest.TestCase):
    """start.py's injected fetcher (`_live_fetch_many`) — the layer between this cache
    and the gateway. Covers I1 (the continuous per-symbol fallback must go THROUGH the
    budget) and the caller half of I3 (a rate-limited batch must surface as an exception,
    which is the only thing that arms the client cooldown).

    No network: the gateway is replaced with one whose HTTP is an injected fetcher, and
    the per-symbol chart path (`start._live_quote_row`) is stubbed out."""

    @classmethod
    def setUpClass(cls):
        try:
            import start
        except Exception as exc:                        # pragma: no cover
            raise unittest.SkipTest("start.py not importable here: %s" % exc)
        cls.start = start
        import yahoo_gateway
        cls.yg = yahoo_gateway
        cls._saved_gateway = yahoo_gateway._instance    # start.py configures one on import

    @classmethod
    def tearDownClass(cls):
        cls.yg._instance = cls._saved_gateway

    def setUp(self):
        self._saved_quote_row = self.start._live_quote_row
        self.per_symbol = []
        def probe(symbol, session=None):
            self.per_symbol.append(symbol)
            return {"day": "2026-08-21", "price": 1.0, "open": None, "high": None,
                    "low": None}
        self.start._live_quote_row = probe

    def tearDown(self):
        self.start._live_quote_row = self._saved_quote_row
        self.yg._instance = self._saved_gateway

    def _gateway(self, capacity=100, raw=None, fail=False):
        def fetch_json(url, params):
            if fail:
                raise self.yg.RateLimitedError("429 Too Many Requests")
            return raw if raw is not None else {"quoteResponse": {"result": []}}
        return self.yg.configure(capacity=capacity, refill_per_sec=capacity,
                                 clock=FakeClock(), sleep_fn=lambda s: None,
                                 rng=lambda: 0.5, json_fetcher=fetch_json)

    def test_a_rate_limited_batch_raises_instead_of_returning_empty(self):
        self._gateway(fail=True)
        with self.assertRaises(lc.RateLimitedError):
            self.start._live_fetch_many(["GCZ26.CMX"])

    def test_an_open_gateway_breaker_reaches_the_client_as_well(self):
        gw = self._gateway()
        gw._breaker.record_failure(rate_limited=True)   # gateway already in cooldown
        with self.assertRaises(lc.RateLimitedError):
            self.start._live_fetch_many(["GCZ26.CMX"])

    def test_a_batch_the_budget_refused_is_not_a_rate_limit(self):
        # capacity=0: the bucket refuses, the breaker never trips. That is a "come back
        # later", not a 429 — it must NOT arm the client cooldown, and it must not fan
        # out to one request per symbol either.
        self._gateway(capacity=0)
        self.assertEqual(self.start._live_fetch_many(["GCZ26.CMX"]), {})
        self.assertEqual(self.per_symbol, [])

    def test_a_continuous_symbol_is_rationed_by_the_gateway(self):
        # =F never batches, so it always takes the per-symbol chart path. Unwrapped, one
        # /api/live-quote of 96 continuous symbols could fire 96 unrationed requests.
        self._gateway(capacity=0)
        self.assertEqual(self.start._live_fetch_many(["GC=F"]), {})
        self.assertEqual(self.per_symbol, [])           # refused before the fetch ran

    def test_a_continuous_symbol_is_still_served_when_the_budget_allows(self):
        self._gateway()
        out = self.start._live_fetch_many(["GC=F"])
        self.assertEqual(self.per_symbol, ["GC=F"])
        self.assertEqual(out["GC=F"]["price"], 1.0)
        self.assertIsNone(out["GC=F"]["state"])         # padded to the quote shape

    def test_a_batch_that_ran_and_omitted_a_symbol_still_falls_back(self):
        raw = {"quoteResponse": {"result": [
            {"symbol": "GCZ26.CMX", "regularMarketPrice": 4680.6,
             "regularMarketTime": 1787345998, "gmtOffSetMilliseconds": -14400000,
             "marketState": "CLOSED"}]}}
        self._gateway(raw=raw)
        out = self.start._live_fetch_many(["GCZ26.CMX", "ZCZ26.CBT"])
        self.assertEqual(self.per_symbol, ["ZCZ26.CBT"])  # the one the batch omitted
        self.assertEqual(set(out), {"GCZ26.CMX", "ZCZ26.CBT"})


class LivePollCadenceTest(unittest.TestCase):
    """The server TTL and the browser's on-screen poll interval are two halves of ONE
    cadence, and they live in different languages — LIVE_TTL_SECONDS here,
    LIVE_QUOTE_INTERVAL_MS in web/live.js. Nothing else in the codebase reads both, so
    nothing else notices when they stop agreeing.

    They must not merely differ: the TTL has to be SHORTER than the poll interval, with
    room for timer jitter. When it is longer the two beat against each other — a 15 s
    poll against a 20 s TTL alternates miss/hit/miss/hit, so a genuinely new price
    reaches the chart only every 30 s and half the requests return a byte-identical
    body. `_liveTickActive`'s `changed` guard then correctly declines to repaint, and
    the live candle visibly freezes for a full poll cycle. Measured on a live gold
    front-month on 2026-08-28: prices stepped in exact 20.4 s stairs under a 5 s poll —
    the TTL, not the market."""

    JITTER_BUDGET_SECONDS = 3.0    # observed browser ticks ran 15.0-15.3 s; leave headroom

    def _client_interval_seconds(self):
        js = pathlib.Path(__file__).resolve().parent / "web" / "live.js"
        m = re.search(r"LIVE_QUOTE_INTERVAL_MS\s*=\s*(\d+)", js.read_text(encoding="utf-8"))
        self.assertIsNotNone(
            m, "LIVE_QUOTE_INTERVAL_MS vanished from web/live.js — this test is the only "
               "thing tying the browser's poll rate to the server's TTL; re-point it.")
        return int(m.group(1)) / 1000.0

    def test_ttl_is_shorter_than_the_on_screen_poll_interval(self):
        interval = self._client_interval_seconds()
        self.assertLessEqual(
            lc.LIVE_TTL_SECONDS, interval - self.JITTER_BUDGET_SECONDS,
            "LIVE_TTL_SECONDS (%s) must stay at least %ss below the browser's %ss poll "
            "or every other on-screen tick is served a stale, identical quote and the "
            "live candle updates at half the advertised rate."
            % (lc.LIVE_TTL_SECONDS, self.JITTER_BUDGET_SECONDS, interval))

    def test_every_on_screen_poll_reaches_yahoo(self):
        # The behavioural half: drive the REAL module TTL at the REAL client cadence and
        # require a fetch per poll. An arithmetic check alone would pass a TTL that is
        # shorter but still swallows a tick.
        interval = self._client_interval_seconds()
        clk = FakeClock(); fetch = RecordingFetch()
        c = lc.LiveQuoteCache(fetch, clock=clk,
                              bucket=lc._TokenBucket(1000, 1000, clk),
                              breaker=lc._CircuitBreaker(90, 3, clk))
        polls = 6
        c.get("CL=F")
        for _ in range(polls - 1):
            clk.advance(interval)
            c.get("CL=F")
        self.assertEqual(len(fetch.calls), polls,
                         "%d of %d on-screen polls were served from cache instead of "
                         "refetching" % (polls - len(fetch.calls), polls))

    def test_a_tick_arriving_early_still_refetches(self):
        # setTimeout is not a metronome and a re-armed tick can land marginally early;
        # the jitter budget above is what keeps such a tick from being swallowed.
        interval = self._client_interval_seconds()
        clk = FakeClock(); fetch = RecordingFetch()
        c = lc.LiveQuoteCache(fetch, clock=clk,
                              bucket=lc._TokenBucket(1000, 1000, clk),
                              breaker=lc._CircuitBreaker(90, 3, clk))
        c.get("CL=F")
        clk.advance(interval - self.JITTER_BUDGET_SECONDS)
        c.get("CL=F")
        self.assertEqual(len(fetch.calls), 2)


if __name__ == "__main__":
    unittest.main()
