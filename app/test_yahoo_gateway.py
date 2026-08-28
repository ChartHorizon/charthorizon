# ── test_yahoo_gateway.py ── Stdlib-only unit tests for the shared Yahoo gateway.
# Run from app/:  python3 -m unittest test_yahoo_gateway -v
# No network and no real sleeps: a FakeClock, a fake sleep and a recording fake
# call make every path deterministic.

import time
import unittest

import yahoo_gateway as yg


class FakeClock:
    """Callable monotonic-clock double. advance() moves time forward by hand."""
    def __init__(self, t=1000.0):
        self.t = float(t)
    def __call__(self):
        return self.t
    def advance(self, dt):
        self.t += float(dt)


class PriorityBucketTest(unittest.TestCase):
    def test_interactive_may_drain_the_bucket(self):
        b = yg._TokenBucket(capacity=10, refill_per_sec=0, clock=FakeClock())
        taken = 0
        while b.try_take(yg.PRIORITY_INTERACTIVE):
            taken += 1
        self.assertEqual(taken, 10)

    def test_bulk_stops_at_the_half_full_floor(self):
        # bulk floor is 0.5 -> it may take only while >= 1 + 0.5*capacity remain,
        # so a full bucket of 10 yields 4 bulk tokens (10,9,8,7 -> stops at 6).
        b = yg._TokenBucket(capacity=10, refill_per_sec=0, clock=FakeClock())
        taken = 0
        while b.try_take(yg.PRIORITY_BULK):
            taken += 1
        self.assertEqual(taken, 4)

    def test_preload_floor_sits_between_the_two(self):
        b = yg._TokenBucket(capacity=10, refill_per_sec=0, clock=FakeClock())
        taken = 0
        while b.try_take(yg.PRIORITY_PRELOAD):
            taken += 1
        self.assertEqual(taken, 7)          # stops once fewer than 1+2.5 remain

    def test_interactive_still_served_after_bulk_is_locked_out(self):
        b = yg._TokenBucket(capacity=10, refill_per_sec=0, clock=FakeClock())
        while b.try_take(yg.PRIORITY_BULK):
            pass
        self.assertFalse(b.try_take(yg.PRIORITY_BULK))
        self.assertTrue(b.try_take(yg.PRIORITY_INTERACTIVE))

    def test_default_priority_is_interactive(self):
        b = yg._TokenBucket(capacity=2, refill_per_sec=0, clock=FakeClock())
        self.assertTrue(b.try_take())
        self.assertTrue(b.try_take())
        self.assertFalse(b.try_take())


class BreakerMoveTest(unittest.TestCase):
    def test_breaker_lives_here_now(self):
        clk = FakeClock()
        br = yg._CircuitBreaker(cooldown=90, error_threshold=3, clock=clk)
        br.record_failure(rate_limited=True)
        self.assertTrue(br.is_open())
        self.assertEqual(br.retry_after(), 90)


class BreakerInconclusiveTest(unittest.TestCase):
    """The third outcome: a fetch that ran and brought nothing back. Neither a success
    (it must not close the breaker or clear the error count) nor a failure (it must not
    count towards tripping one) — but it MUST release a half-open probe."""

    def _br(self, clk):
        return yg._CircuitBreaker(cooldown=90, error_threshold=3, clock=clk)

    def test_an_inconclusive_probe_reopens_with_the_cooldown_restarted(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=True)
        clk.advance(90.0)
        self.assertTrue(br.allow())                 # half-open probe issued
        self.assertEqual(br._state, "half_open")
        clk.advance(5.0)
        br.record_inconclusive()                    # the probe came back empty
        self.assertEqual(br._state, "open")
        self.assertFalse(br._probe_in_flight)
        self.assertTrue(br.is_open())               # the frontend can be told again
        self.assertEqual(br.retry_after(), 90)      # full cooldown, restarted now
        self.assertFalse(br.allow())                # and it is honoured
        clk.advance(90.0)
        self.assertTrue(br.allow())                 # recovery is still possible

    def test_inconclusive_is_a_no_op_while_closed(self):
        clk = FakeClock(); br = self._br(clk)
        br.record_failure(rate_limited=False)
        br.record_failure(rate_limited=False)       # 2 of 3 towards tripping
        br.record_inconclusive()
        self.assertEqual(br._state, "closed")
        self.assertEqual(br._errors, 2)             # neither reset nor advanced
        self.assertFalse(br.is_open())
        self.assertEqual(br.retry_after(), 0)
        self.assertTrue(br.allow())


class ReExportTest(unittest.TestCase):
    def test_live_cache_still_exposes_the_primitives(self):
        # start.py and test_live_cache.py reach for these through live_cache.
        import live_cache as lc
        self.assertIs(lc._TokenBucket, yg._TokenBucket)
        self.assertIs(lc._CircuitBreaker, yg._CircuitBreaker)
        self.assertIs(lc.RateLimitedError, yg.RateLimitedError)


class RecordingCall:
    """Callable double. modes: 'ok' | 'ratelimit' | 'error' | 'ratelimit_then_ok' |
    'generic_ratelimit' (a NON-RateLimitedError exception whose message still reads as
    a 429 — this is what yfinance's own exception classes actually look like)."""
    def __init__(self, value="payload"):
        self.value = value
        self.calls = 0
        self.mode = "ok"
    def __call__(self):
        self.calls += 1
        if self.mode == "ratelimit":
            raise yg.RateLimitedError("429 Too Many Requests")
        if self.mode == "error":
            raise RuntimeError("boom")
        if self.mode == "ratelimit_then_ok" and self.calls == 1:
            raise yg.RateLimitedError("429 Too Many Requests")
        if self.mode == "generic_ratelimit":
            raise RuntimeError("429 Too Many Requests")
        return self.value


class GatewayCallTest(unittest.TestCase):
    def _gw(self, clk=None, capacity=100, refill=100):
        clk = clk or FakeClock()
        self.slept = []
        return yg.YahooGateway(
            capacity=capacity, refill_per_sec=refill, clock=clk,
            sleep_fn=self.slept.append, rng=lambda: 0.5,   # 0.5 -> zero jitter
        )

    def test_success_passes_the_value_through(self):
        gw = self._gw(); fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK), "payload")
        self.assertEqual(fn.calls, 1)
        self.assertEqual(self.slept, [])

    def test_rate_limit_retries_with_the_documented_backoff(self):
        gw = self._gw(); fn = RecordingCall(); fn.mode = "ratelimit"
        with self.assertRaises(yg.RateLimitedError):
            gw.call(fn, priority=yg.PRIORITY_BULK)
        self.assertEqual(fn.calls, 4)                 # 1 attempt + 3 retries
        self.assertEqual(self.slept, [2.0, 6.0, 18.0])

    def test_a_retry_that_succeeds_returns_the_value(self):
        gw = self._gw(); fn = RecordingCall(); fn.mode = "ratelimit_then_ok"
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK), "payload")
        self.assertEqual(fn.calls, 2)
        self.assertEqual(self.slept, [2.0])

    def test_interactive_never_retries(self):
        # A stale on-screen candle beats a blocked request thread.
        gw = self._gw(); fn = RecordingCall(); fn.mode = "ratelimit"
        with self.assertRaises(yg.RateLimitedError):
            gw.call(fn, priority=yg.PRIORITY_INTERACTIVE)
        self.assertEqual(fn.calls, 1)
        self.assertEqual(self.slept, [])

    def test_jitter_scales_the_delay(self):
        clk = FakeClock(); self.slept = []
        gw = yg.YahooGateway(capacity=100, refill_per_sec=100, clock=clk,
                             sleep_fn=self.slept.append, rng=lambda: 1.0)  # +25 %
        fn = RecordingCall(); fn.mode = "ratelimit"
        with self.assertRaises(yg.RateLimitedError):
            gw.call(fn, priority=yg.PRIORITY_BULK)
        self.assertEqual(self.slept, [2.5, 7.5, 22.5])

    def test_no_token_returns_the_default_without_calling(self):
        gw = self._gw(capacity=1, refill=0)
        fn = RecordingCall()
        gw.call(fn, priority=yg.PRIORITY_INTERACTIVE)          # drains the bucket
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_INTERACTIVE, default="last"), "last")
        self.assertEqual(fn.calls, 1)

    def test_open_breaker_returns_the_default_without_calling(self):
        gw = self._gw()
        fn = RecordingCall(); fn.mode = "ratelimit"
        with self.assertRaises(yg.RateLimitedError):
            gw.call(fn, priority=yg.PRIORITY_BULK)             # trips the breaker
        before = fn.calls
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="last"), "last")
        self.assertEqual(fn.calls, before)

    def test_generic_errors_also_retry_then_surface(self):
        gw = self._gw(); fn = RecordingCall(); fn.mode = "error"
        with self.assertRaises(RuntimeError):
            gw.call(fn, priority=yg.PRIORITY_BULK)
        self.assertEqual(fn.calls, 4)

    def test_a_non_ratelimitederror_that_looks_like_a_429_is_normalised(self):
        # yfinance's own rate-limit exception (or curl_cffi's) is never a
        # yahoo_gateway.RateLimitedError -- only an injected one is. Without the
        # normalisation in call(), this would surface as RuntimeError and every
        # caller's `except RateLimitedError` (chart_history's re-raise, in particular)
        # would miss it entirely, letting a real 429 masquerade as a clean success.
        gw = self._gw(); fn = RecordingCall(); fn.mode = "generic_ratelimit"
        with self.assertRaises(yg.RateLimitedError):
            gw.call(fn, priority=yg.PRIORITY_BULK)
        self.assertEqual(fn.calls, 4)                 # still retried like any 429


class BulkWaitsForItsBudgetTest(unittest.TestCase):
    """A dropped bulk call is a hole in the data, not a slower refresh.

    The bucket is non-blocking by design — the on-screen chart must never queue behind
    a scan. The GENERATOR inherited that when it moved onto the shared budget, and for a
    batch job "no token" meant "fetch nothing and move on": the 2026-08-22 refresh drained
    the bucket in its first second, silently skipped ~every remaining request, and finished
    in 11 s with all 39 markets at `fresh_history_missing`. Bulk therefore WAITS for its
    token (bounded), while interactive keeps its original never-block contract."""

    def _gw(self, capacity=10, refill=10, clk=None):
        # Unlike the other suites' sleep double, this one ADVANCES the clock: the whole
        # point here is that waiting lets the bucket refill, which a frozen clock would
        # make impossible (a real time.sleep moves time on).
        clk = clk or FakeClock()
        self.clock = clk
        self.slept = []

        def sleep(seconds):
            self.slept.append(seconds)
            clk.advance(seconds)

        return yg.YahooGateway(
            capacity=capacity, refill_per_sec=refill, clock=clk,
            sleep_fn=sleep, rng=lambda: 0.5,
        )

    def _drain_to_floor(self, gw, priority):
        while gw._bucket.try_take(priority):
            pass

    def test_bulk_sleeps_for_the_token_instead_of_skipping_the_fetch(self):
        gw = self._gw()
        self._drain_to_floor(gw, yg.PRIORITY_BULK)      # bulk is now locked out
        fn = RecordingCall()

        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="skipped"), "payload")
        self.assertEqual(fn.calls, 1)
        self.assertTrue(self.slept, "bulk must wait for the bucket, not give up")
        # It waits only as long as the refill actually needs (10 tokens/s here).
        self.assertLess(sum(self.slept), 1.0)

    def test_interactive_still_never_blocks(self):
        gw = self._gw(capacity=1, refill=0)
        fn = RecordingCall()
        gw.call(fn, priority=yg.PRIORITY_INTERACTIVE)                       # drains it
        self.assertEqual(
            gw.call(fn, priority=yg.PRIORITY_INTERACTIVE, default="last"), "last")
        self.assertEqual(fn.calls, 1)
        self.assertEqual(self.slept, [])

    def test_a_bucket_that_can_never_refill_is_not_waited_on(self):
        # refill 0: waiting cannot help, so the call must decline at once (this is also
        # what keeps the offline tests that configure capacity=0 instant).
        gw = self._gw(capacity=0, refill=0)
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="skipped"), "skipped")
        self.assertEqual(fn.calls, 0)
        self.assertEqual(self.slept, [])

    def test_the_wait_is_bounded_and_then_gives_up(self):
        # A refill so slow that the token is further away than the bulk ceiling allows:
        # the call declines rather than parking a worker for minutes. Interactive drains
        # it to empty, so bulk needs its whole reserve (6 tokens) back at 0.001/s.
        gw = self._gw(capacity=10, refill=0.001)
        self._drain_to_floor(gw, yg.PRIORITY_INTERACTIVE)
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="skipped"), "skipped")
        self.assertEqual(fn.calls, 0)
        self.assertLessEqual(sum(self.slept), yg._PRIORITY_MAX_WAIT[yg.PRIORITY_BULK])

    def test_preload_waits_too_but_far_less_than_bulk(self):
        self.assertGreater(yg._PRIORITY_MAX_WAIT[yg.PRIORITY_BULK],
                           yg._PRIORITY_MAX_WAIT[yg.PRIORITY_PRELOAD])
        self.assertEqual(yg._PRIORITY_MAX_WAIT[yg.PRIORITY_INTERACTIVE], 0.0)
        gw = self._gw()
        self._drain_to_floor(gw, yg.PRIORITY_PRELOAD)
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_PRELOAD, default="skipped"), "payload")
        self.assertTrue(self.slept)

    def test_a_stood_down_bulk_call_does_not_wait_at_all(self):
        # The server profile stands bulk/preload down while a refresh holds the lock —
        # that is a decision, not a budget shortage, so it must stay instant.
        gw = self._gw()
        gw._refresh_running = lambda: True
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="stood-down"),
                         "stood-down")
        self.assertEqual(fn.calls, 0)
        self.assertEqual(self.slept, [])


class SessionTest(unittest.TestCase):
    def test_session_is_built_once_and_reused(self):
        built = []
        def factory():
            built.append(1)
            return {"fake": "session"}
        gw = yg.YahooGateway(capacity=10, refill_per_sec=10, clock=FakeClock(),
                             session_factory=factory)
        a, b = gw.session(), gw.session()
        self.assertIs(a, b)
        self.assertEqual(len(built), 1)

    def test_a_failing_factory_degrades_to_none(self):
        def factory():
            raise RuntimeError("curl_cffi missing")
        gw = yg.YahooGateway(capacity=10, refill_per_sec=10, clock=FakeClock(),
                             session_factory=factory)
        self.assertIsNone(gw.session())


class RefreshLockThrottleTest(unittest.TestCase):
    def _gw(self, tmp, clk):
        return yg.YahooGateway(capacity=10, refill_per_sec=0, clock=clk,
                               sleep_fn=lambda s: None, rng=lambda: 0.5,
                               lock_path=tmp)

    def test_without_the_lock_bulk_is_admitted(self):
        import tempfile, os as _os
        path = _os.path.join(tempfile.mkdtemp(), "refresh.lock")
        gw = self._gw(path, FakeClock())
        self.assertEqual(gw.call(RecordingCall(), priority=yg.PRIORITY_BULK), "payload")

    def test_with_the_lock_only_interactive_is_admitted(self):
        import tempfile, os as _os
        path = _os.path.join(tempfile.mkdtemp(), "refresh.lock")
        open(path, "w").close()                       # a refresh is running
        gw = self._gw(path, FakeClock())
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="held"), "held")
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_PRELOAD, default="held"), "held")
        self.assertEqual(fn.calls, 0)
        # Standing down must be FREE: neither stood-down call may have touched the
        # bucket or the breaker. Pinning this directly means moving the lock check
        # below try_take()/allow() in call() makes this test fail, even though
        # fn still wouldn't run and the interactive call below would still pass.
        self.assertEqual(gw._bucket._tokens, 10.0)
        self.assertEqual(gw._breaker._state, "closed")
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_INTERACTIVE), "payload")

    def test_a_stale_lock_from_a_crashed_refresh_does_not_stand_us_down(self):
        # A refresh killed mid-run leaves the file behind. Existence alone would then
        # disable preload and bulk forever, so the mtime has to be recent as well
        # (the age half of start.py's _lock_is_active).
        import tempfile, os as _os
        path = _os.path.join(tempfile.mkdtemp(), "refresh.lock")
        open(path, "w").close()
        stale = time.time() - (yg.LOCK_MAX_AGE_SECONDS + 60)
        _os.utime(path, (stale, stale))
        gw = self._gw(path, FakeClock())
        self.assertEqual(gw.call(RecordingCall(), priority=yg.PRIORITY_BULK), "payload")

    def test_a_lock_that_vanishes_mid_check_is_not_running(self):
        # getmtime() on a path removed between the exists() and the stat must degrade to
        # "no refresh", never raise into call().
        import tempfile, os as _os
        gw = self._gw(_os.path.join(tempfile.mkdtemp(), "never-created.lock"), FakeClock())
        self.assertFalse(gw._refresh_running())

    def test_with_the_lock_a_stood_down_call_never_reaches_the_breaker(self):
        # Round 2 of the same invariant: when the breaker is OPEN, allow() itself
        # mutates state (open -> half_open, probe_in_flight = True) once the cooldown
        # has elapsed. Observing _state == "closed" (as the sibling test does) proves
        # nothing here because the breaker is closed throughout that test. This test
        # drives the breaker open, arms the open->half_open transition by clearing the
        # cooldown, then asserts a stood-down bulk call never lets allow() run at all --
        # otherwise it would silently burn the single half-open probe slot.
        import tempfile, os as _os
        path = _os.path.join(tempfile.mkdtemp(), "refresh.lock")
        open(path, "w").close()                       # a refresh is running
        clk = FakeClock()
        gw = self._gw(path, clk)
        gw._breaker.record_failure(rate_limited=True)  # -> "open"
        clk.advance(yg.LIVE_BREAKER_COOLDOWN_SECONDS + 1)  # cooldown elapsed
        fn = RecordingCall()
        self.assertEqual(gw.call(fn, priority=yg.PRIORITY_BULK, default="held"), "held")
        self.assertEqual(fn.calls, 0)
        self.assertEqual(gw._breaker._state, "open")
        self.assertFalse(gw._breaker._probe_in_flight)


class BatchQuoteTest(unittest.TestCase):
    RAW = {"quoteResponse": {"result": [
        {"symbol": "GCZ26.CMX", "regularMarketPrice": 4680.6, "regularMarketOpen": 4577.0,
         "regularMarketDayHigh": 4690.4, "regularMarketDayLow": 4565.5,
         "regularMarketTime": 1787345998, "gmtOffSetMilliseconds": -14400000,
         "marketState": "CLOSED"},
        {"symbol": "ZCZ26.CBT", "regularMarketPrice": 508.5, "regularMarketOpen": 502.0,
         "regularMarketDayHigh": 509.0, "regularMarketDayLow": 499.0,
         "regularMarketTime": 1787336399, "gmtOffSetMilliseconds": -14400000,
         "marketState": "REGULAR"},
    ]}}

    def _gw(self, raw=None, fail=False):
        calls = []
        def fetch_json(url, params):
            calls.append(params["symbols"])
            if fail:
                raise yg.RateLimitedError("429 Too Many Requests")
            return raw if raw is not None else self.RAW
        gw = yg.YahooGateway(capacity=100, refill_per_sec=100, clock=FakeClock(),
                             sleep_fn=lambda s: None, rng=lambda: 0.5,
                             json_fetcher=fetch_json)
        return gw, calls

    def test_continuous_symbols_are_never_batchable(self):
        # Measured: 14/16 =F symbols disagree with their own chart series, up to 9.44 %.
        self.assertFalse(yg.is_batchable("GC=F"))
        self.assertFalse(yg.is_batchable("KC=F"))
        self.assertTrue(yg.is_batchable("GCZ26.CMX"))
        self.assertTrue(yg.is_batchable("ZCZ26.CBT"))

    def test_one_request_serves_many_contracts(self):
        gw, calls = self._gw()
        out = gw.quotes(["GCZ26.CMX", "ZCZ26.CBT"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], "GCZ26.CMX,ZCZ26.CBT")
        self.assertEqual(set(out), {"GCZ26.CMX", "ZCZ26.CBT"})

    def test_the_quote_shape_matches_the_live_cache_contract(self):
        gw, _ = self._gw()
        q = gw.quotes(["GCZ26.CMX"])["GCZ26.CMX"]
        self.assertEqual(sorted(q), ["day", "high", "low", "open", "price", "state"])
        self.assertEqual(q["price"], 4680.6)
        self.assertEqual(q["open"], 4577.0)
        self.assertEqual(q["state"], "CLOSED")

    def test_day_is_the_exchange_local_date(self):
        # regularMarketTime + gmtOffSetMilliseconds, formatted as a UTC date. Verified
        # against hist.index[-1].strftime("%Y-%m-%d") on four symbols.
        gw, _ = self._gw()
        self.assertEqual(gw.quotes(["GCZ26.CMX"])["GCZ26.CMX"]["day"], "2026-08-21")

    def test_continuous_symbols_are_dropped_from_the_batch(self):
        gw, calls = self._gw()
        out = gw.quotes(["GC=F", "GCZ26.CMX"])
        self.assertEqual(calls[0], "GCZ26.CMX")       # =F never sent
        self.assertNotIn("GC=F", out)                 # caller falls back per-symbol

    def test_chunking_splits_at_the_batch_size(self):
        syms = [f"CL{i:02d}26.NYM" for i in range(120)]
        gw, calls = self._gw(raw={"quoteResponse": {"result": []}})
        gw.quotes(syms)
        self.assertEqual(len(calls), 3)               # 50 + 50 + 20
        self.assertEqual(len(calls[0].split(",")), 50)

    def test_a_failed_batch_returns_empty_rather_than_raising(self):
        gw, _ = self._gw(fail=True)
        self.assertEqual(gw.quotes(["GCZ26.CMX"]), {})

    def test_status_tells_a_ran_batch_from_a_declined_one(self):
        # {} means two different things and the live cache's breaker must not confuse
        # them: "ran, nothing usable" vs "never ran".
        gw, _ = self._gw(raw={"quoteResponse": {"result": []}})
        status = {}
        self.assertEqual(gw.quotes(["GCZ26.CMX"], status=status), {})
        self.assertTrue(status["ran"])
        self.assertFalse(status["declined"])
        self.assertFalse(status["rate_limited"])

    def test_status_reports_a_rate_limited_batch(self):
        gw, _ = self._gw(fail=True)
        status = {}
        self.assertEqual(gw.quotes(["GCZ26.CMX"], status=status), {})   # still never raises
        self.assertTrue(status["rate_limited"])
        self.assertTrue(status["declined"])
        self.assertFalse(status["ran"])

    def test_status_reports_a_budget_decline(self):
        # capacity=0 -> call() returns its default without the fetcher ever running.
        gw, calls = self._gw()
        gw._bucket._tokens = 0.0
        gw._bucket._refill = 0.0
        status = {}
        self.assertEqual(gw.quotes(["GCZ26.CMX"], status=status), {})
        self.assertEqual(calls, [])
        self.assertTrue(status["declined"])
        self.assertFalse(status["ran"])
        self.assertFalse(status["rate_limited"])

    def test_a_row_without_a_price_is_omitted(self):
        raw = {"quoteResponse": {"result": [
            {"symbol": "DEAD.CME", "regularMarketTime": 1787345998,
             "gmtOffSetMilliseconds": 0, "marketState": "CLOSED"}]}}
        gw, _ = self._gw(raw=raw)
        self.assertEqual(gw.quotes(["DEAD.CME"]), {})


if __name__ == "__main__":
    unittest.main()
