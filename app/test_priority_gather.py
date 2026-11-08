from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import tempfile
import threading
import unittest
from datetime import date, datetime, timedelta
from unittest import mock

import pandas as pd

import commodity_dashboard as cd
import contract_history_cache as chc
import fetch_yfinance as fy
import fx_rates
import series_utils
import start
import yahoo_gateway as yg
from contracts import build_contract_candidates, pick_lead_and_next
from market_config import COMMODITIES

# Importing start installs the SERVER gateway profile, whose lock_path is the real
# ff_data/refresh.lock; the whole suite inherits whichever profile is installed last.
# Hand the singleton back a plain profile, as test_crash_recovery does.
yg.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except ImportError:                      # pragma: no cover - Python 3.7/3.8
    from dateutil import tz
    ET = tz.gettz("America/New_York")

A, B, C = {"yf_symbol": "A"}, {"yf_symbol": "B"}, {"yf_symbol": "C"}
CANDS = [A, B, C]


class PickLeadAndNextTest(unittest.TestCase):
    def test_lead_is_highest_batch_volume_and_next_follows_it(self):
        self.assertEqual(pick_lead_and_next(CANDS, {"A": 10, "B": 500, "C": 40}), (B, C))

    def test_lead_on_last_candidate_has_no_next(self):
        self.assertEqual(pick_lead_and_next(CANDS, {"A": 1, "C": 9}), (C, None))

    def test_ties_go_to_the_earlier_month(self):
        self.assertEqual(pick_lead_and_next(CANDS, {"A": 5, "B": 5}), (A, B))

    def test_falls_back_to_previous_stored_volume(self):
        prev = [{"yf_symbol": "A", "volume": 0}, {"yf_symbol": "B", "volume": 0},
                {"yf_symbol": "C", "volume": 900}]
        self.assertEqual(pick_lead_and_next(CANDS, {}, prev), (C, None))

    def test_falls_back_to_first_two_candidates(self):
        self.assertEqual(pick_lead_and_next(CANDS, {}), (A, B))
        self.assertEqual(pick_lead_and_next(CANDS, {}, []), (A, B))

    def test_empty_candidates(self):
        self.assertEqual(pick_lead_and_next([], {"A": 1}), (None, None))


class BatchVolumesTest(unittest.TestCase):
    def test_keeps_only_positive_volumes(self):
        q = lambda s: {"A": {"volume": 7}, "B": {"volume": 0}, "C": {"volume": None}}
        self.assertEqual(cd._batch_volumes(["A", "B", "C"], quotes=q), {"A": 7})

    def test_batch_volumes_swallows_failure(self):
        def boom(s):
            raise RuntimeError("down")
        self.assertEqual(cd._batch_volumes(["A"], quotes=boom), {})


def _frame(days=1830):
    idx = pd.date_range(end=datetime.now() - timedelta(days=3), periods=days, freq="D").normalize()
    return pd.DataFrame(
        {"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": 100}, index=idx)


class FakeTicker:
    def __init__(self, recorder, symbol):
        self._rec, self._symbol = recorder, symbol

    def history(self, period, interval="1d"):
        self._rec.append((self._symbol, period))
        return _frame()


class _FrameHandoffBase(unittest.TestCase):
    def setUp(self):
        self.requests = []
        rec = self.requests
        patcher = mock.patch.object(
            fy.YahooFinanceClient, "_ticker",
            lambda self_, symbol: FakeTicker(rec, symbol))
        patcher.start()
        self.addCleanup(patcher.stop)


class FrameHandoffTest(_FrameHandoffBase):
    def test_seeded_client_issues_no_request(self):
        a = fy.YahooFinanceClient()
        snap = a.cache_snapshot()
        a.quote("GCZ26.CMX")
        self.assertEqual(len(self.requests), 1)
        b = fy.YahooFinanceClient()
        b.seed(a.cache_added_since(snap))
        self.assertTrue(b.quote("GCZ26.CMX").get("available"))
        self.assertEqual(len(b.chart_history("GCZ26.CMX", period="5y")) > 0, True)
        self.assertEqual(len(self.requests), 1)

    def test_seed_works_across_threads(self):
        a = fy.YahooFinanceClient()
        a.quote("GCZ26.CMX")
        out = {}
        def work():
            b = fy.YahooFinanceClient()
            b.seed(a.cache_added_since((frozenset(), frozenset())))
            out["q"] = b.quote("GCZ26.CMX")
        t = threading.Thread(target=work)
        t.start(); t.join()
        self.assertTrue(out["q"]["available"])
        self.assertEqual(len(self.requests), 1)

    def test_snapshot_excludes_earlier_entries(self):
        a = fy.YahooFinanceClient()
        a.quote("A.CMX")
        snap = a.cache_snapshot()
        a.quote("B.CMX")
        added = a.cache_added_since(snap)
        self.assertEqual(set(added["quotes"]), {"B.CMX"})
        self.assertEqual(set(added["history"]), {("B.CMX", "5y", "1d")})

    def test_cached_history_serves_superset_and_never_requests(self):
        a = fy.YahooFinanceClient()
        self.assertIsNone(a.cached_history("GCZ26.CMX", "5y"))
        self.assertIsNone(a.cached_quote("GCZ26.CMX"))
        self.assertEqual(self.requests, [])
        a.quote("GCZ26.CMX")
        self.assertIsNotNone(a.cached_history("GCZ26.CMX", "5y"))
        short = a.cached_history("GCZ26.CMX", "10d")
        self.assertEqual(len(short), 11)
        self.assertEqual(len(self.requests), 1)

    def test_seed_never_overwrites(self):
        b = fy.YahooFinanceClient()
        own_frame = _frame(5)
        own_quote = {"last": 1.0, "available": True}
        b._history_cache[("X", "5y", "1d")] = own_frame
        b._quote_cache["X"] = own_quote
        b.seed({"history": {("X", "5y", "1d"): _frame(9)},
                "quotes": {"X": {"last": 2.0, "available": True}}})
        self.assertIs(b._history_cache[("X", "5y", "1d")], own_frame)
        self.assertIs(b._quote_cache["X"], own_quote)


class OfflineSelectionTest(_FrameHandoffBase):
    def test_offline_selection_requests_nothing(self):
        cfg = next(iter(COMMODITIES.values()))
        cands = fy.build_contract_candidates(cfg, count=max(fy.YF_CONTRACT_LOOKAHEAD, 6))
        self.assertGreaterEqual(len(cands), 7)
        seeder = fy.YahooFinanceClient()
        for c in cands[:2]:
            seeder.quote(c["yf_symbol"], quiet=True)
        self.requests.clear()
        client = fy.YahooFinanceClient()
        client.seed(seeder.cache_added_since((frozenset(), frozenset())))
        with mock.patch.object(fy._yf_client._local, "client", client, create=True):
            out = fy.select_yfinance_contracts(cfg, 6, offline=True)
        self.assertEqual(self.requests, [])
        self.assertEqual(len(out), 6)
        self.assertEqual(sum(1 for c in out if c.get("available")), 2)

    def test_offline_selection_prints_nothing(self):
        # On a fresh install every market's offline pick "skips" all but lead and next; a
        # "missing/expired skipped" line per market says something untrue 39 times.
        cfg = next(iter(COMMODITIES.values()))
        out = io.StringIO()
        with mock.patch.object(fy._yf_client._local, "client", fy.YahooFinanceClient(),
                               create=True), contextlib.redirect_stdout(out):
            fy.select_yfinance_contracts(cfg, 6, offline=True)
        self.assertEqual(out.getvalue(), "")


# ── Task 5: phase "fronts", generator-written cache files, phase-2 seeding ──────────────

KEYS = list(COMMODITIES)[:3]


def _frame_to(end, days=400, volume=100, last_volume=None, freq="D"):
    """A daily frame ending ON `end` (a date). `last_volume` overrides the final bar's.
    Short on purpose: building rows from a frame is the slow part of a gather run."""
    idx = pd.date_range(end=pd.Timestamp(end), periods=days, freq=freq)
    vols = [volume] * len(idx)
    if last_volume is not None:
        vols[-1] = last_volume
    return pd.DataFrame(
        {"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": vols}, index=idx)


class _EndingTicker:
    def __init__(self, recorder, symbol, end):
        self._rec, self._symbol, self._end = recorder, symbol, end

    def history(self, period, interval="1d"):
        self._rec.append((self._symbol, period))
        return _frame_to(self._end)


def _candidates(key):
    cfg = dict(COMMODITIES[key])
    cfg["_key"] = key
    return build_contract_candidates(cfg)


class _FrontsBase(unittest.TestCase):
    """Temp cwd, both clocks fixed at one instant, an unlimited gateway, and a fresh
    thread-local client for the main thread. Frames end on the server's settled session
    for that instant: quote() gates on the REAL date.today(), so the instant is now."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cwd = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, cwd)

        self.now = chc.eastern_now()
        self.cutoff = chc.latest_settled_eod_date(self.now)
        for target, name in ((series_utils, "_eastern_now"), (chc, "eastern_now")):
            p = mock.patch.object(target, name, lambda: self.now)
            p.start()
            self.addCleanup(p.stop)

        saved = yg._instance
        self.addCleanup(setattr, yg, "_instance", saved)
        yg.configure(capacity=10 ** 6, refill_per_sec=10 ** 6, sleep_fn=lambda s: None)
        self.batch_calls = []
        p = mock.patch.object(yg._instance, "quotes", self.fake_quotes)
        p.start()
        self.addCleanup(p.stop)

        self.requests = []
        rec, end = self.requests, self.cutoff
        p = mock.patch.object(fy.YahooFinanceClient, "_ticker",
                              lambda self_, symbol: _EndingTicker(rec, symbol, end))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(fy._yf_client._local, "client", fy.YahooFinanceClient(),
                              create=True)
        p.start()
        self.addCleanup(p.stop)

        self.markets = {k: dict(COMMODITIES[k]) for k in KEYS}
        self.cands = {k: _candidates(k) for k in KEYS}
        # Batch volume makes the SECOND candidate the lead, so lead != the first fallback.
        self.lead = {k: c[1]["yf_symbol"] for k, c in self.cands.items()}
        self.next = {k: c[2]["yf_symbol"] for k, c in self.cands.items()}

    def fake_quotes(self, symbols, priority=None, status=None):
        self.batch_calls.append(list(symbols))
        out = {}
        for c in self.cands.values():
            out[c[0]["yf_symbol"]] = {"volume": 100}
            out[c[1]["yf_symbol"]] = {"volume": 5000}
            out[c[2]["yf_symbol"]] = {"volume": 50}
        return out

    def fronts_syms(self):
        return [self.lead[k] for k in KEYS] + [self.next[k] for k in KEYS]

    @contextlib.contextmanager
    def gather_env(self, workers):
        """The patches a gather run needs; its console output lands in self.output."""
        status = {"should_refresh": True, "release_date": None, "report_date": None,
                  "reason": "test"}
        out = io.StringIO()
        try:
            with mock.patch.object(cd, "COMMODITIES", self.markets), \
                    mock.patch.object(cd, "REFRESH_FETCH_WORKERS", workers), \
                    mock.patch.object(cd, "_cot_refresh_status", lambda: status), \
                    mock.patch.object(cd, "fetch_cftc_cot", lambda: {}), \
                    contextlib.redirect_stdout(out):
                yield
        finally:
            self.output = out.getvalue()

    def run_gather(self, workers, on_first_pass=None):
        with self.gather_env(workers):
            return cd.gather_commodity_data(count=6, on_first_pass=on_first_pass)

    def run_fronts(self, existing=None, workers=2, quotes=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return cd._gather_fronts(list(self.markets.items()), existing or {}, workers,
                                     quotes=quotes or self.fake_quotes)


class GatherOrderTest(_FrontsBase):
    def test_every_lead_before_every_next_before_phase_two(self):
        self.run_gather(workers=1)
        expected = [(s, "5y") for s in self.fronts_syms()]
        self.assertEqual(self.requests[:6], expected)
        self.assertGreater(len(self.requests), 6)          # phase 2 did run afterwards
        self.assertFalse(set(expected) & set(self.requests[6:]))

    def test_phase_two_requests_nothing_phase_one_fetched(self):
        dataset = self.run_gather(workers=4)
        self.assertEqual(set(dataset), set(KEYS))
        self.assertEqual(set(self.requests[:6]), {(s, "5y") for s in self.fronts_syms()})
        five_y = [r for r in self.requests if r[1] == "5y"]
        self.assertEqual(len(five_y), len(set(five_y)))

    def test_declined_batch_still_orders_and_fetches(self):
        def declined(symbols):
            raise RuntimeError("batch quote down")
        k1, k2, k3 = KEYS
        c1 = self.cands[k1]
        existing = {k1: {"contracts": [{"yf_symbol": c1[0]["yf_symbol"], "volume": 5},
                                       {"yf_symbol": c1[2]["yf_symbol"], "volume": 900}]}}
        fronts = self.run_fronts(existing=existing, quotes=declined)
        self.assertEqual((fronts[k1]["lead"], fronts[k1]["next"]),
                         (c1[2]["yf_symbol"], c1[3]["yf_symbol"]))
        for k in (k2, k3):
            self.assertEqual((fronts[k]["lead"], fronts[k]["next"]),
                             (self.cands[k][0]["yf_symbol"], self.cands[k][1]["yf_symbol"]))
        requested = {s for s, p in self.requests if p == "5y"}
        for k in KEYS:
            self.assertIn(fronts[k]["lead"], requested)
            self.assertIn(fronts[k]["next"], requested)

    def test_market_without_candidates_has_no_fronts(self):
        real = cd.build_contract_candidates
        no_chain = lambda cfg, *a, **kw: [] if cfg["_key"] == KEYS[0] else real(cfg, *a, **kw)
        with mock.patch.object(cd, "build_contract_candidates", no_chain):
            fronts = self.run_fronts()
        self.assertEqual(fronts[KEYS[0]],
                         {"lead": None, "next": None, "cached": {"history": {}, "quotes": {}}})
        self.assertEqual(len(self.requests), 4)            # the other two markets only


class FrontsCacheFileTest(_FrontsBase):
    def test_fronts_written_to_cache_with_server_stamp(self):
        fronts = self.run_fronts()
        for k in KEYS:
            self.assertEqual((fronts[k]["lead"], fronts[k]["next"]), (self.lead[k], self.next[k]))
            for sym in (self.lead[k], self.next[k]):
                # What phase 2 seeds from: the frame and the computed quote.
                self.assertIn((sym, "5y", "1d"), fronts[k]["cached"]["history"])
                self.assertTrue(fronts[k]["cached"]["quotes"][sym]["available"])
                with open(chc.cache_path(sym, "5y"), encoding="utf-8") as f:
                    payload = json.load(f)
                self.assertEqual(payload["symbol"], sym)
                self.assertEqual(payload["settled_through"],
                                 chc.latest_settled_eod_date(self.now).isoformat())
                self.assertEqual(payload["history"][-1]["date"], self.cutoff.isoformat())

    def test_generator_writes_through_replace_with_retry(self):
        calls = []

        def recorder(tmp, path):
            if os.path.basename(os.path.dirname(path)) == "contract_history":  # not progress
                calls.append(path)
            os.replace(tmp, path)
        with mock.patch.object(cd, "_replace_with_retry", recorder):
            self.run_fronts()
        self.assertEqual(sorted(calls), sorted(chc.cache_path(s, "5y") for s in self.fronts_syms()))
        written = os.listdir(os.path.join("ff_data", "contract_history"))
        self.assertEqual(len(written), len(calls))

    def test_phase_two_writes_the_rest_of_the_chain_once(self):
        calls = []

        def recorder(tmp, path):
            if os.path.basename(os.path.dirname(path)) == "contract_history":  # not progress
                calls.append(path)
            os.replace(tmp, path)
        with mock.patch.object(cd, "_replace_with_retry", recorder):
            dataset = self.run_gather(workers=2)
        self.assertEqual(len(calls), len(set(calls)))       # nothing written twice
        for k in KEYS:
            for c in dataset[k]["contracts"]:
                if c.get("available"):
                    self.assertIn(chc.cache_path(c["yf_symbol"], "5y"), calls)

    def test_progress_reports_fronts_phase(self):
        calls = []
        real = cd._write_refresh_progress

        def recorder(**fields):
            calls.append(dict(fields))
            real(**fields)
        with mock.patch.object(cd, "_write_refresh_progress", recorder):
            self.run_gather(workers=2)
        fronts_idx = [i for i, c in enumerate(calls) if c.get("phase") == "fronts"]
        rest_idx = [i for i, c in enumerate(calls) if c.get("phase") == "rest"]
        self.assertTrue(fronts_idx and rest_idx)
        self.assertTrue(all(calls[i]["fronts_total"] == 6 for i in fronts_idx))
        self.assertEqual(max(calls[i]["fronts_done"] for i in fronts_idx), 6)
        self.assertLess(max(fronts_idx), min(rest_idx))
        with open(os.path.join("ff_data", "refresh_progress.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["phase"], "rest")

    def test_progress_phase_resets_at_run_start(self):
        os.makedirs("ff_data", exist_ok=True)
        path = os.path.join("ff_data", "refresh_progress.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"state": "done", "phase": "rest", "fronts_done": 78,
                       "fronts_total": 78}, f)
        on_disk = []
        real = cd._write_refresh_progress

        def recorder(**fields):
            real(**fields)
            with open(path, encoding="utf-8") as f:
                on_disk.append((len(self.requests), json.load(f)))
        with mock.patch.object(cd, "_write_refresh_progress", recorder):
            self.run_gather(workers=2)
        requests_before, first = on_disk[0]
        self.assertEqual(requests_before, 0)                # before any Yahoo request
        self.assertEqual(first["state"], "running")
        self.assertIsNone(first["phase"])
        self.assertEqual(first["fronts_done"], 0)
        self.assertIsNone(first["fronts_total"])

    def test_every_write_uses_the_run_start_clock(self):
        start, later = self.now, self.now + timedelta(minutes=6)
        reads = []

        def clock():
            reads.append(len(self.requests))
            return start if len(reads) == 1 else later
        seen = []
        real = cd._write_contract_history

        def recorder(symbol, now_et=None, **kw):
            seen.append(now_et)
            return real(symbol, now_et=now_et, **kw)
        with mock.patch.object(chc, "eastern_now", clock), \
                mock.patch.object(cd, "_write_contract_history", recorder):
            self.run_gather(workers=2)
        self.assertEqual(reads[:1], [0])                    # captured before any request
        self.assertGreater(len(seen), 6)                    # phase 1 and phase 2 writes
        self.assertTrue(all(now is start for now in seen))


class SettleEdgeTest(_FrontsBase):
    """Fixed-date frames seeded straight into the client: chart_history has no stale gate."""

    def _seed(self, symbol, frame):
        fy._yf_client.seed({"history": {(symbol, "5y", "1d"): frame}, "quotes": {}})

    def _at(self, when):
        self.now = when                     # both patched clocks read self.now

    def test_holiday_evening_file_is_written(self):
        self._at(datetime(2026, 9, 7, 18, 0, tzinfo=ET))           # Labor Day
        self._seed("CLV26.NYM", _frame_to(date(2026, 9, 4), days=300, freq="B"))
        self.assertTrue(cd._write_contract_history("CLV26.NYM", now_et=self.now))
        with open(chc.cache_path("CLV26.NYM", "5y"), encoding="utf-8") as f:
            payload = json.load(f)
        self.assertEqual(payload["settled_through"], "2026-09-04")
        self.assertEqual(payload["history"][-1]["date"], "2026-09-04")
        self.assertEqual(self.requests, [])

    def test_dropped_current_bar_is_never_served_as_current(self):
        self._at(datetime(2026, 9, 11, 18, 0, tzinfo=ET))
        # 1,000 lots against a 50,000 norm: under 15 %, so the generator drops 09-11. The
        # file is the next run's (complete_for), but carries no server stamp: inside the
        # 600 s retry floor the server must still refetch it, or the 23:30 bot's card would
        # be STALE_CARD on Thursday's candle.
        self._seed("CLV26.NYM", _frame_to(date(2026, 9, 11), days=300, freq="B",
                                          volume=50000, last_volume=1000))
        self.assertTrue(cd._write_contract_history("CLV26.NYM", now_et=self.now))
        short = self._payload("CLV26.NYM")
        self.assertEqual(short["history"][-1]["date"], "2026-09-10")
        self.assertIsNone(short["settled_through"])
        self.assertFalse(start._contract_history_is_current(
            short, date(2026, 9, 11), self.now.timestamp() + 1))
        # ... while the same frame with a full 09-11 session is served as it is.
        self._seed("CLX26.NYM", _frame_to(date(2026, 9, 11), days=300, freq="B", volume=50000))
        self.assertTrue(cd._write_contract_history("CLX26.NYM", now_et=self.now))
        self.assertTrue(start._contract_history_is_current(
            self._payload("CLX26.NYM"), date(2026, 9, 11), self.now.timestamp() + 1))
        self.assertEqual(self.requests, [])

    def _payload(self, symbol):
        with open(chc.cache_path(symbol, "5y"), encoding="utf-8") as f:
            return json.load(f)

    def test_run_start_clock_cuts_a_bar_fetched_before_the_settle(self):
        # The run started at 17:25 ET; the frame (fetched 17:28) holds Thursday's forming
        # bar at full volume; the write happens at 17:31, when every write-time clock
        # already calls Thursday settled.
        run_now = datetime(2026, 9, 10, 17, 25, tzinfo=ET)
        self._at(datetime(2026, 9, 10, 17, 31, tzinfo=ET))
        self._seed("CLV26.NYM", _frame_to(date(2026, 9, 10), days=300, freq="B", volume=50000))
        self.assertTrue(cd._write_contract_history("CLV26.NYM", now_et=run_now))
        payload = self._payload("CLV26.NYM")
        self.assertEqual(payload["settled_through"], "2026-09-09")
        self.assertEqual(payload["history"][-1]["date"], "2026-09-09")
        self.assertNotIn("2026-09-10", [r["date"] for r in payload["history"]])

    def test_holiday_bar_never_extends_past_the_stamp(self):
        # Yahoo printed a Labor Day bar; the generator's clock does not skip holidays and
        # keeps it, the server's cutoff is Friday. The file ends where its stamp says.
        self._at(datetime(2026, 9, 7, 18, 0, tzinfo=ET))
        self._seed("CLV26.NYM", _frame_to(date(2026, 9, 7), days=300, freq="B", volume=50000))
        self.assertTrue(cd._write_contract_history("CLV26.NYM", now_et=self.now))
        payload = self._payload("CLV26.NYM")
        self.assertEqual(payload["settled_through"], "2026-09-04")
        self.assertEqual(payload["history"][-1]["date"], "2026-09-04")

    def test_no_cached_frame_no_request_no_file(self):
        self.assertFalse(cd._write_contract_history("CLV26.NYM", now_et=self.now))
        self.assertEqual(self.requests, [])
        self.assertFalse(os.path.exists(chc.cache_path("CLV26.NYM", "5y")))


class CacheWriteFailureTest(_FrontsBase):
    """A cache file is an optimisation: whatever goes wrong while writing one costs that
    one file, never the refresh (the writer runs inside ex.map, which re-raises)."""

    def test_a_raising_write_returns_false_and_names_the_symbol(self):
        sym = self.lead[KEYS[0]]
        fy._yf_client.quote(sym, quiet=True)                 # the frame the write reads
        out = io.StringIO()
        with mock.patch.object(chc, "build_payload", side_effect=TypeError("not JSON")), \
                contextlib.redirect_stdout(out):
            self.assertFalse(cd._write_contract_history(sym, now_et=self.now))
        self.assertIn("⚠", out.getvalue())
        self.assertIn(sym, out.getvalue())
        self.assertFalse(os.path.exists(chc.cache_path(sym, "5y")))

    def test_fronts_phase_survives_a_raising_write(self):
        with mock.patch.object(chc, "write_payload", side_effect=ValueError("circular")):
            fronts = self.run_fronts()
        for k in KEYS:
            self.assertEqual((fronts[k]["lead"], fronts[k]["next"]), (self.lead[k], self.next[k]))
            self.assertIn((self.lead[k], "5y", "1d"), fronts[k]["cached"]["history"])


class ProgressWriteTest(_FrontsBase):
    def test_progress_replace_goes_through_replace_with_retry(self):
        # A 1 Hz status reader on Windows makes a plain os.replace fail with a sharing
        # violation, and the lost write could be the phase="rest" transition.
        calls = []

        def recorder(tmp, path):
            calls.append(path)
            os.replace(tmp, path)
        with mock.patch.object(cd, "_replace_with_retry", recorder):
            cd._write_refresh_progress(phase="rest")
        self.assertEqual(calls, [cd.PROGRESS_FILE])
        with open(cd.PROGRESS_FILE, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["phase"], "rest")


# ── Task 6: the first-pass board ─────────────────────────────────────────────────────────

SENTINEL_VOLUME = 987654321
PROGRESS = os.path.join("ff_data", "refresh_progress.json")


def _strip_source(rows):
    return [{f: v for f, v in r.items() if f != "source"} for r in rows]


class _FirstPassBase(_FrontsBase):
    """_FrontsBase plus what generate_html needs offline: the BIS fetch patched, and the
    process-wide seasonal-year cache started from nothing in this test's temp dir."""

    def setUp(self):
        super().setUp()
        for target, name, value in ((fx_rates, "fetch_fx_rates", lambda: {}),
                                    (fy, "_existing_seasonal_years", None)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def first_pass_dataset(self, existing=None):
        """Phase "fronts", then _first_pass_market for each market, as a first run does."""
        fronts = self.run_fronts(existing=existing)
        dataset = {}
        with contextlib.redirect_stdout(io.StringIO()):
            for key, cfg in self.markets.items():
                k, entry, _added = cd._first_pass_market(key, cfg, {}, 6, fronts[key])
                dataset[k] = entry
        return dataset

    def generate(self, dataset, first_pass=False):
        with contextlib.redirect_stdout(io.StringIO()):
            cd.generate_html(dataset, first_pass=first_pass)

    def written(self):
        return cd._load_existing_market_payloads("ff_data")

    def progress(self):
        try:
            with open(PROGRESS, encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            return {}

    def complete_dataset(self, first):
        """What phase 2 hands generate_html, built by hand so every series differs from its
        first-pass counterpart: six priced contracts, a spread, a total-volume series, and
        price and seasonal closes the first pass never wrote."""
        full = copy.deepcopy(first)
        for k, entry in full.items():
            for i, c in enumerate(entry["contracts"]):
                c.update({"last": 70.0 + i, "change": 0.5, "change_pct": 0.71,
                          "volume": 4000 + i, "open_interest": None, "available": True,
                          "source": "yfinance"})
            cc = entry["continuous_contract"]
            for series in ("history", "seasonal_history"):
                cc[series] = [dict(r, close=1.6) for r in cc[series]]
            days = [r["date"] for r in cc["history"]]
            cc["total_volume_series"] = [
                {"date": d, "volume": 25000, "source": "yfinance_contract_sum",
                 "method": "summed_yfinance_single_contract_histories", "contract_count": 6}
                for d in days]
            front, nxt = entry["contracts"][1], entry["contracts"][2]
            entry["calendar_spread_series"] = [
                {"date": d, "spread": -0.25, "front_contract": front["contract_symbol"],
                 "next_contract": nxt["contract_symbol"], "front_close": 1.6,
                 "next_close": 1.85, "source": "yfinance_liquid_contracts"}
                for d in days[-30:]]
        return full


class FirstPassBoardTest(_FirstPassBase):
    def test_first_pass_writes_board_but_not_log_or_archive(self):
        self.generate(self.first_pass_dataset(), first_pass=True)
        self.assertTrue(start._config_js_is_complete(os.path.join("ff_data", "config.js")))
        names = os.listdir("ff_data")
        self.assertIn("screener.json", names)
        self.assertTrue([n for n in names if n.startswith("data_") and n != "data_quality.json"])
        self.assertNotIn("three_three_log.json", names)
        self.assertNotIn("charthorizon.db", names)
        self.assertNotEqual(self.progress().get("state"), "done")
        self.assertTrue(start.dashboard_exists())     # a restart now is a warm start

    def test_first_pass_contracts_have_only_lead_and_next_priced(self):
        self.generate(self.first_pass_dataset(), first_pass=True)
        written = self.written()
        for k in KEYS:
            contracts = written[k]["contracts"]
            self.assertEqual(len(contracts), 6)
            self.assertEqual({c["yf_symbol"] for c in contracts if c.get("available")},
                             {self.lead[k], self.next[k]})
            self.assertEqual(written[k]["calendar_spread_series"], [])

    def test_first_pass_never_asks_bis(self):
        # BIS has a 30 s timeout and sits in front of config.js; the first pass takes the
        # previous rates (none on a true first run: forex.js has its built-in table).
        config_path = os.path.join("ff_data", "config.js")

        def read_config():
            with open(config_path, encoding="utf-8") as f:
                raw = f.read()
            return json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        dataset = self.first_pass_dataset()
        bis = mock.Mock(side_effect=AssertionError("BIS asked on the first pass"))
        with mock.patch.object(fx_rates, "fetch_fx_rates", bis):
            self.generate(dataset, first_pass=True)
            self.assertNotIn("fxRates", read_config())
            previous = {"USD": 4.5}
            with open(config_path, "w", encoding="utf-8") as f:
                f.write("window.__CONFIG__ = " + json.dumps({"index": {}, "fxRates": previous})
                        + ";\n")
            self.generate(dataset, first_pass=True)
            self.assertEqual(read_config()["fxRates"], previous)
        bis.assert_not_called()
        fresh = {"USD": 4.25}
        with mock.patch.object(fx_rates, "fetch_fx_rates", return_value=fresh) as complete:
            self.generate(dataset)                            # the complete run asks as before
        complete.assert_called_once_with()
        self.assertEqual(read_config()["fxRates"], fresh)

    def test_first_pass_price_history_is_cleaned_like_the_complete_run(self):
        # The complete run drops isolated spike-and-revert prints from the =F history and
        # caps it (fetch_yfinance_liquid_continuous_history); the first pass is the same board.
        spike_day = self.cutoff - timedelta(days=10)
        continuous = {self.markets[k]["yf_continuous"] for k in KEYS}
        rec, end = self.requests, self.cutoff

        class SpikeTicker(_EndingTicker):
            def history(self, period, interval="1d"):
                frame = super().history(period, interval)
                if self._symbol in continuous:
                    frame.loc[pd.Timestamp(spike_day), ["High", "Close"]] = 3.0
                return frame
        with mock.patch.object(fy.YahooFinanceClient, "_ticker",
                               lambda self_, symbol: SpikeTicker(rec, symbol, end)), \
                mock.patch.object(fy, "YF_PRICE_HISTORY_MAX_POINTS", 120):
            dataset = self.first_pass_dataset()
        for k in KEYS:
            history = dataset[k]["continuous_contract"]["history"]
            days = [r["date"] for r in history]
            self.assertNotIn(spike_day.isoformat(), days)
            self.assertEqual(len(history), 119)               # capped at 120, the spike gone
            self.assertEqual(days, sorted(days))
            self.assertEqual(days[-1], self.cutoff.isoformat())
            self.assertEqual({r["source"] for r in history}, {"yfinance_continuous_fallback"})

    def test_seasonal_max_serves_the_twenty_year_chart(self):
        fronts = self.run_fronts()
        after_fronts = len(self.requests)
        with contextlib.redirect_stdout(io.StringIO()):
            for k in KEYS:
                _k, entry, added = cd._first_pass_market(k, self.markets[k], {}, 6, fronts[k])
                sym = self.markets[k]["yf_continuous"]
                self.assertTrue(entry["continuous_contract"]["history"])
                self.assertIn((sym, "max", "1d"), added["history"])   # handed to phase 2
        # One request per market, the `max` frame: the 20-year chart is cut out of it, and
        # settling the =F series reads lead and next, never the unpriced chain rows.
        self.assertEqual(self.requests[after_fronts:],
                         [(self.markets[k]["yf_continuous"], "max") for k in KEYS])

    def test_complete_run_replaces_every_first_pass_series(self):
        first = self.first_pass_dataset()
        full = self.complete_dataset(first)
        self.generate(first, first_pass=True)
        self.generate(full)
        written = self.written()
        for k in KEYS:
            mk = written[k]
            want = json.loads(json.dumps(full[k]))
            cc, want_cc = mk["continuous_contract"], want["continuous_contract"]
            self.assertEqual(mk["contracts"], want["contracts"])
            self.assertEqual(mk["calendar_spread_series"], want["calendar_spread_series"])
            self.assertEqual(cc["total_volume_series"], want_cc["total_volume_series"])
            self.assertEqual(cc["history"], want_cc["history"])
            self.assertEqual([(r["date"], r["close"]) for r in cc["seasonal_history"]],
                             [(r["date"], r["close"]) for r in want_cc["seasonal_history"]])
            for rows in (mk["contracts"], mk["calendar_spread_series"],
                         cc["total_volume_series"]):
                self.assertFalse([r for r in rows if r.get("source") == "previous_local_store"])
            self.assertEqual(cc["data_quality"]["price"]["used"], "fresh_api")
            self.assertEqual(cc["data_quality"]["seasonal"]["used"], "fresh_api")

    def test_first_pass_over_stored_payload_keeps_stored_spread_and_quotes(self):
        # An older install after a crash: complete category files, a truncated config.js.
        days = [d.date().isoformat()
                for d in pd.date_range(end=pd.Timestamp(self.cutoff), periods=20, freq="D")]
        stored = {}
        for k in KEYS:
            cands = self.cands[k][:6]
            stored[k] = {
                "display_name": self.markets[k]["display_name"],
                "category": self.markets[k]["category"],
                "contracts": [dict(c, last=50.0 + i, change=0.25, change_pct=0.5,
                                   volume=3000 + i, open_interest=None, available=True,
                                   source="yfinance") for i, c in enumerate(cands)],
                "calendar_spread_series": [
                    {"date": d, "spread": -0.4, "front_contract": cands[1]["contract_symbol"],
                     "next_contract": cands[2]["contract_symbol"], "front_close": 51.0,
                     "next_close": 51.4, "source": "yfinance_liquid_contracts"}
                    for d in days],
                "continuous_contract": {"history": [], "total_volume_series": [
                    {"date": d, "volume": 60000, "source": "yfinance_contract_sum",
                     "method": "summed_yfinance_single_contract_histories",
                     "contract_count": 6} for d in days]},
            }
        os.makedirs("ff_data", exist_ok=True)
        with open(os.path.join("ff_data", "data_energy.json"), "w", encoding="utf-8") as f:
            json.dump(stored, f)
        with open(os.path.join("ff_data", "config.js"), "w", encoding="utf-8") as f:
            f.write("window.__CONFIG__ = {\"ind")             # truncated
        self.assertFalse(start.dashboard_exists())

        self.generate(self.first_pass_dataset(existing=stored), first_pass=True)
        written = self.written()
        for k in KEYS:
            mk = written[k]
            self.assertEqual(_strip_source(mk["calendar_spread_series"]),
                             _strip_source(stored[k]["calendar_spread_series"]))
            by_symbol = {c["yf_symbol"]: c for c in mk["contracts"]}
            for sym in (self.lead[k], self.next[k]):
                self.assertEqual(by_symbol[sym]["source"], "yfinance")     # this run's quote
            others = [c for c in stored[k]["contracts"]
                      if c["yf_symbol"] not in (self.lead[k], self.next[k])]
            self.assertEqual(len(others), 4)
            for c in others:
                got = by_symbol[c["yf_symbol"]]
                for field in ("last", "change", "change_pct", "volume", "available"):
                    self.assertEqual(got[field], c[field])
            volume = {r["date"]: r["volume"]
                      for r in mk["continuous_contract"]["total_volume_series"]}
            self.assertEqual({d: volume.get(d) for d in days}, {d: 60000 for d in days})
        self.assertTrue(start.dashboard_exists())

    def test_market_without_chain_gets_a_first_pass_entry(self):
        key = KEYS[0]
        self.markets[key]["contract_months"] = []
        fronts = self.run_fronts()
        self.assertEqual((fronts[key]["lead"], fronts[key]["next"]), (None, None))
        with contextlib.redirect_stdout(io.StringIO()):
            k, entry, _added = cd._first_pass_market(key, self.markets[key], {}, 6, fronts[key])
        self.assertEqual(k, key)
        cc = entry["continuous_contract"]
        self.assertTrue(cc["history"])
        self.assertTrue(cc["seasonal_history"])
        self.assertFalse([c for c in entry["contracts"] if c.get("available")])
        self.assertEqual(entry["calendar_spread_series"], [])
        self.generate({key: entry}, first_pass=True)
        self.assertTrue(self.written()[key]["continuous_contract"]["history"])


class FirstPassGatherTest(_FirstPassBase):
    def test_hook_gets_every_market_and_phase_two_reuses_its_frames(self):
        seen = []

        def hook(dataset):
            seen.append((set(dataset), len(self.requests), self.progress().get("phase")))
        self.run_gather(workers=2, on_first_pass=hook)
        self.assertEqual(len(seen), 1)
        keys, requests_at_hook, phase = seen[0]
        self.assertEqual(keys, set(KEYS))
        self.assertEqual(phase, "fronts")                   # "rest" only once it returns
        self.assertEqual(self.progress().get("phase"), "rest")
        for k in KEYS:
            sym = self.markets[k]["yf_continuous"]
            # One request for the =F symbol in the whole run: the first pass's `max` frame
            # serves the 20-year chart and phase 2's seasonal and chart alike.
            self.assertEqual([r for r in self.requests if r[0] == sym], [(sym, "max")])
            self.assertIn((sym, "max"), self.requests[:requests_at_hook])

    def test_no_hook_no_first_pass(self):
        # A raise inside the first pass would be swallowed by its own guard; count calls.
        with mock.patch.object(cd, "_first_pass_market") as first_pass:
            dataset = self.run_gather(workers=2)
        first_pass.assert_not_called()
        self.assertNotIn("First-pass board", self.output)
        self.assertEqual(set(dataset), set(KEYS))

    def test_failing_first_pass_hook_does_not_stop_the_run(self):
        def hook(dataset):
            raise RuntimeError("disk full")
        dataset = self.run_gather(workers=2, on_first_pass=hook)
        self.assertEqual(set(dataset), set(KEYS))
        self.assertTrue(all(dataset[k]["contracts"] for k in KEYS))
        self.assertIn("⚠", self.output)
        self.assertIn("disk full", self.output)
        self.assertEqual(self.progress().get("phase"), "rest")

    def test_batch_volume_never_written(self):
        def sentinel(symbols, priority=None, status=None):
            return {c[1]["yf_symbol"]: {"volume": SENTINEL_VOLUME} for c in self.cands.values()}
        # One worker: the request log is then in task order.
        with mock.patch.object(yg._instance, "quotes", sentinel), self.gather_env(workers=1):
            cd.run_generator(True)
        # The sentinel decided the order (the second candidate led), and both boards landed.
        self.assertEqual(self.requests[:3], [(self.lead[k], "5y") for k in KEYS])
        self.assertEqual(self.progress().get("state"), "done")
        self.assertTrue(os.listdir(os.path.join("ff_data", "contract_history")))
        hits = []
        for root, _dirs, files in os.walk("ff_data"):
            for name in files:
                with open(os.path.join(root, name), "rb") as f:
                    if str(SENTINEL_VOLUME).encode() in f.read():
                        hits.append(os.path.join(root, name))
        self.assertEqual(hits, [])


STORED_SEASONAL_CLOSE = 9.25
STORED_TOTAL_VOLUME = 60000


class WarmFirstPassTest(_FirstPassBase):
    """Every background refresh writes a first pass, and on a warm start it lands on the
    open page over a complete board from the previous run. It must put the front months
    on that board without making any of the rest worse until phase 2 replaces it."""

    def stored_board(self, volume_end):
        """The previous run's complete board, on disk: six priced contracts, a spread,
        this year's seasonal history and a total-volume series ending on `volume_end`."""
        vol_days = [d.date().isoformat()
                    for d in pd.date_range(end=pd.Timestamp(volume_end), periods=20, freq="D")]
        season_days = [d.date().isoformat()
                       for d in pd.date_range(end=pd.Timestamp(date.today()), periods=30,
                                              freq="D")]
        stored = {}
        for k in KEYS:
            cands = self.cands[k][:6]
            stored[k] = {
                "display_name": self.markets[k]["display_name"],
                "category": self.markets[k]["category"],
                "contracts": [dict(c, last=50.0 + i, change=0.25, change_pct=0.5,
                                   volume=3000 + i, open_interest=None, available=True,
                                   source="yfinance") for i, c in enumerate(cands)],
                "calendar_spread_series": [
                    {"date": d, "spread": -0.4, "front_contract": cands[1]["contract_symbol"],
                     "next_contract": cands[2]["contract_symbol"], "front_close": 51.0,
                     "next_close": 51.4, "source": "yfinance_liquid_contracts"}
                    for d in vol_days],
                "continuous_contract": {
                    "history": [],
                    "seasonal_history": [
                        {"date": d, "open": STORED_SEASONAL_CLOSE,
                         "high": STORED_SEASONAL_CLOSE, "low": STORED_SEASONAL_CLOSE,
                         "close": STORED_SEASONAL_CLOSE, "volume": 100}
                        for d in season_days],
                    "total_volume_series": [
                        {"date": d, "volume": STORED_TOTAL_VOLUME,
                         "source": "yfinance_contract_sum",
                         "method": "summed_yfinance_single_contract_histories",
                         "contract_count": 6} for d in vol_days],
                },
            }
        os.makedirs("ff_data", exist_ok=True)
        with open(os.path.join("ff_data", "data_energy.json"), "w", encoding="utf-8") as f:
            json.dump(stored, f)
        return stored

    def config(self):
        with open(os.path.join("ff_data", "config.js"), encoding="utf-8") as f:
            raw = f.read()
        return json.loads(raw[raw.index("{"):raw.rindex("}") + 1])

    def total_volume(self, key):
        return self.written()[key]["continuous_contract"]["total_volume_series"]

    def test_warm_first_pass_reuses_the_stored_seasonal_history(self):
        # The seasonal `max` is fetched once a year. A warm first pass must not fetch it 39
        # times in front of the board it exists to deliver early.
        stored = self.stored_board(volume_end=self.cutoff)
        fronts = self.run_fronts(existing=stored)
        after_fronts = len(self.requests)
        dataset = {}
        with contextlib.redirect_stdout(io.StringIO()):
            for k in KEYS:
                _k, entry, _added = cd._first_pass_market(k, self.markets[k], {}, 6, fronts[k])
                self.assertEqual(entry["continuous_contract"]["seasonal_history"], [])
                dataset[k] = entry
        self.assertEqual(self.requests[after_fronts:],
                         [(self.markets[k]["yf_continuous"], "20y") for k in KEYS])
        self.generate(dataset, first_pass=True)
        for k in KEYS:
            seasonal = self.written()[k]["continuous_contract"]["seasonal_history"]
            self.assertTrue(seasonal)
            self.assertEqual({r["close"] for r in seasonal}, {STORED_SEASONAL_CLOSE})

    def test_warm_first_pass_holds_total_volume_at_the_stored_last_day(self):
        # On the first pass only lead and next carry the new session, so its sum there is a
        # fraction of the market's (a third, for crude). The newest bar waits for phase 2.
        held = self.cutoff - timedelta(days=1)
        stored = self.stored_board(volume_end=held)
        first = self.first_pass_dataset(existing=stored)
        self.generate(first, first_pass=True)
        for k in KEYS:
            rows = self.total_volume(k)
            self.assertEqual(rows[-1]["date"], held.isoformat())
            stored_days = {r["date"] for r in
                           stored[k]["continuous_contract"]["total_volume_series"]}
            self.assertEqual({r["volume"] for r in rows if r["date"] in stored_days},
                             {STORED_TOTAL_VOLUME})
        self.generate(self.complete_dataset(first))
        for k in KEYS:
            self.assertEqual(self.total_volume(k)[-1]["date"], self.cutoff.isoformat())

    def test_a_true_first_pass_still_shows_the_newest_volume(self):
        # Nothing stored to hold to: a first run's board has only what this run fetched.
        self.generate(self.first_pass_dataset(), first_pass=True)
        for k in KEYS:
            self.assertEqual(self.total_volume(k)[-1]["date"], self.cutoff.isoformat())

    def test_first_pass_board_is_announced_to_the_open_page(self):
        # refresh.js applies a board in place when its version is new; a first pass leaves
        # the run "running", so it is announced beside that state.
        self.generate(self.first_pass_dataset(), first_pass=True)
        progress = self.progress()
        self.assertEqual(progress.get("first_pass_version"), self.config()["dataVersion"])
        self.assertNotEqual(progress.get("state"), "done")

    def test_warm_first_pass_does_not_report_its_unfetched_rows_as_failures(self):
        stored = self.stored_board(volume_end=self.cutoff)
        first = self.first_pass_dataset(existing=stored)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cd.generate_html(first, first_pass=True)
        self.assertNotIn("fresh Yahoo quote unavailable", out.getvalue())
        for k in KEYS:
            reused = [c for c in self.written()[k]["contracts"]
                      if c.get("source") == "previous_local_store"]
            self.assertEqual(len(reused), 4)          # shown with the previous values

    def test_a_run_clears_the_previous_first_pass_stamp(self):
        os.makedirs("ff_data", exist_ok=True)
        with open(PROGRESS, "w", encoding="utf-8") as f:
            json.dump({"state": "done", "first_pass_version": "20260101000000"}, f)
        seen = []
        self.run_gather(workers=1,
                        on_first_pass=lambda d: seen.append(
                            self.progress().get("first_pass_version", "missing")))
        self.assertEqual(seen, [None])


class RunGeneratorTest(unittest.TestCase):
    def test_first_pass_flag_wires_the_hook(self):
        calls = []

        def gather(count=6, on_first_pass=None, fresh=False):
            calls.append(("gather", count, on_first_pass is not None))
            if on_first_pass is not None:
                on_first_pass({"first": True})
            return {"full": True}

        def generate(dataset, first_pass=False):
            calls.append(("html", dataset, first_pass))
        with mock.patch.object(cd, "gather_commodity_data", gather), \
                mock.patch.object(cd, "generate_html", generate):
            cd.run_generator(True)
            cd.run_generator(False)
        self.assertEqual(calls, [
            ("gather", 6, True), ("html", {"first": True}, True), ("html", {"full": True}, False),
            ("gather", 6, False), ("html", {"full": True}, False),
        ])

    def test_fresh_flag_reaches_gather(self):
        seen = []

        def gather(count=6, on_first_pass=None, fresh=False):
            seen.append(fresh)
            return {}
        with mock.patch.object(cd, "gather_commodity_data", gather), \
                mock.patch.object(cd, "generate_html", lambda *a, **kw: None):
            cd.run_generator(False)
            cd.run_generator(True, fresh=True)
        self.assertEqual(seen, [False, True])


if __name__ == "__main__":
    unittest.main()
