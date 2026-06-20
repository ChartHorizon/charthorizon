# ── test_live_cache.py ── Stdlib-only unit tests for the live-quote cache logic.
# Run from app/:  python3 -m unittest test_live_cache -v
# No network and no real sleeps (except the one threaded single-flight test): a
# FakeClock + a recording fake fetch make every path deterministic.

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


class RecordingFetch:
    """fetch_fn double: returns a canned row and records calls. mode switches behavior:
    'ok' | 'ratelimit' (raise RateLimitedError) | 'error' (raise RuntimeError) |
    'empty' (return a None row)."""
    def __init__(self, row=None):
        self.row = row if row is not None else {"day": "2026-06-10", "price": 100.0}
        self.calls = []
        self.mode = "ok"
    def __call__(self, symbol):
        self.calls.append(symbol)
        if self.mode == "ratelimit":
            raise lc.RateLimitedError("429 Too Many Requests")
        if self.mode == "error":
            raise RuntimeError("boom")
        if self.mode == "empty":
            return {"day": None, "price": None}
        return dict(self.row)


class LiveQuoteCacheTest(unittest.TestCase):
    def _cache(self, fetch, clk, bucket=None):
        # Unlimited bucket by default so these tests isolate the TTL/breaker behavior.
        bucket = bucket if bucket is not None else lc._TokenBucket(1000, 1000, clk)
        breaker = lc._CircuitBreaker(90, 3, clk)
        return lc.LiveQuoteCache(fetch, ttl=20.0, clock=clk, bucket=bucket, breaker=breaker)

    def test_cold_triggers_one_fetch(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"), {"day": "2026-06-10", "price": 100.0})
        self.assertEqual(fetch.calls, ["CL=F"])

    def test_within_ttl_served_from_cache(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F")
        clk.advance(19.0)
        c.get("CL=F")
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
        self.assertEqual(out, {"day": "2026-06-10", "price": 100.0})   # last-known
        self.assertTrue(c.cooldown_active())
        self.assertGreater(c.retry_after(), 0)

    def test_cold_rate_limit_returns_empty(self):
        clk = FakeClock(); fetch = RecordingFetch(); fetch.mode = "ratelimit"
        c = self._cache(fetch, clk)
        self.assertEqual(c.get("CL=F"), {"day": None, "price": None})

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
        self.assertEqual(out, {"day": "2026-06-10", "price": 100.0})   # last-known, no fetch
        self.assertEqual(len(fetch.calls), 1)

    def test_empty_row_serves_last_known(self):
        clk = FakeClock(); fetch = RecordingFetch()
        c = self._cache(fetch, clk)
        c.get("CL=F"); clk.advance(21.0)
        fetch.mode = "empty"
        self.assertEqual(c.get("CL=F"), {"day": "2026-06-10", "price": 100.0})

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
        row = {"day": "2026-06-10", "price": 100.0}
        def slow_fetch(symbol):
            with calls_lock:
                calls.append(symbol)
            started.release()
            gate.wait(2.0)                               # hold the per-symbol lock
            return dict(row)
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
        _time.sleep(0.05)                                # let the other 4 queue on the lock
        gate.set()                                       # release the in-flight fetch
        for t in threads:
            t.join(2.0)
        self.assertEqual(len(calls), 1)                  # single-flight: one fetch for five callers
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r == row for r in results))


if __name__ == "__main__":
    unittest.main()
