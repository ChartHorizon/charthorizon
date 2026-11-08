"""Offline tests: the generator takes a settle's answers from ff_data/contract_history/
instead of asking Yahoo a second time (contract_history_cache.is_complete_answer).

Within one settle the generator can only ingest what it already has: settled bars, nothing
intraday. So a second run before the next settle (a later start the same day, the weekend)
reads every contract, and the =F chart, back from the files the first one wrote. These tests
pin the three things that must hold for that: a reused answer is the answer the request
would have returned, a file is only ever reused for the settle it was asked for (and only
once that session's day had ended), and nothing the server reads changes meaning.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import time as wallclock
import unittest
from datetime import datetime, time, timedelta
from unittest import mock

import pandas as pd

import commodity_dashboard as cd
import contract_history_cache as chc
import fetch_yfinance as fy
import series_utils
import start
import yahoo_gateway as yg
from test_priority_gather import ET, KEYS, _EndingTicker, _FirstPassBase, _frame_to


def _night_after_a_session():
    """01:00 ET on a recent day whose settle both clocks agree on (not an exchange holiday):
    every file written then was asked after its session's day had ended."""
    day = chc.eastern_now().date()
    while True:
        now = datetime.combine(day, time(1, 0), tzinfo=ET)
        if chc.latest_settled_eod_date(now) == series_utils._latest_settled_eod_date(now):
            return now
        day -= timedelta(days=1)


class _ReuseBase(_FirstPassBase):
    """_FirstPassBase on a quiet night: both patched clocks read self.now, and the fake
    Yahoo's frames end on that night's settle."""

    def setUp(self):
        super().setUp()
        self.now = _night_after_a_session()
        self.cutoff = chc.latest_settled_eod_date(self.now)
        rec, end = self.requests, self.cutoff
        p = mock.patch.object(fy.YahooFinanceClient, "_ticker",
                              lambda self_, symbol: _EndingTicker(rec, symbol, end))
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(fy.disable_cache_reuse)

    def fresh_client(self):
        """A new thread-local client for the main thread, as a new run (or thread) has."""
        p = mock.patch.object(fy._yf_client._local, "client", fy.YahooFinanceClient(),
                              create=True)
        p.start()
        self.addCleanup(p.stop)

    def write(self, symbol, period="5y", **kw):
        """Fetch `symbol` once through the client and write its file, as a run does."""
        if period == "5y":
            fy._yf_client.quote(symbol, quiet=True)
        else:
            fy._yf_client.chart_history(symbol, period=period, quiet=True)
        return cd._write_contract_history(symbol, now_et=self.now, period=period, **kw)

    def payload(self, symbol, period="5y"):
        with open(chc.cache_path(symbol, period), encoding="utf-8") as f:
            return json.load(f)


class ReaderTest(_ReuseBase):
    SYM = "CLF27.NYM"

    def test_without_reuse_a_complete_file_is_asked_again(self):
        self.assertTrue(self.write(self.SYM))
        self.fresh_client()
        self.requests.clear()
        fy._yf_client.quote(self.SYM, quiet=True)
        self.assertEqual(self.requests, [(self.SYM, "5y")])

    def test_a_complete_file_is_the_answer_the_request_would_give(self):
        self.assertTrue(self.write(self.SYM))
        asked_rows = fy._yf_client.chart_history(self.SYM, period="5y")
        asked_quote = fy._yf_client.quote(self.SYM)
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff)
        self.assertEqual(fy._yf_client.chart_history(self.SYM, period="5y"), asked_rows)
        self.assertEqual(fy._yf_client.quote(self.SYM), asked_quote)
        self.assertEqual(self.requests, [])
        self.assertTrue(fy._yf_client.answered_from_cache(self.SYM))
        self.assertEqual(fy.cache_reuse_count(), 1)

    def test_a_shorter_period_is_cut_from_the_file(self):
        self.assertTrue(self.write(self.SYM))
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff)
        month = fy._yf_client._history(self.SYM, "1mo")
        self.assertEqual(self.requests, [])
        self.assertLessEqual(len(month), 32)
        self.assertEqual(month.index.max().date(), self.cutoff)

    def test_a_file_for_another_settle_is_asked_again(self):
        self.assertTrue(self.write(self.SYM))
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff + timedelta(days=3))
        fy._yf_client.quote(self.SYM, quiet=True)
        self.assertEqual(self.requests, [(self.SYM, "5y")])

    def test_an_expired_contract_is_never_asked_again(self):
        self.assertTrue(self.write(self.SYM, expiry=(self.cutoff - timedelta(days=40)).isoformat()))
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff + timedelta(days=30))
        fy._yf_client.chart_history(self.SYM, period="5y")
        self.assertEqual(self.requests, [])

    def test_an_empty_answer_stays_empty_without_a_request(self):
        empty = pd.DataFrame({"Open": [], "High": [], "Low": [], "Close": [], "Volume": []})
        fy._yf_client.seed({"history": {(self.SYM, "5y", "1d"): empty}, "quotes": {}})
        self.assertTrue(cd._write_contract_history(self.SYM, now_et=self.now))
        self.fresh_client()
        fy.enable_cache_reuse(self.cutoff)
        self.assertEqual(fy._yf_client.chart_history(self.SYM, period="5y",
                                                     raise_errors=True), [])
        self.assertFalse(fy._yf_client.quote(self.SYM).get("available"))
        self.assertEqual(self.requests, [])

    def test_the_continuous_chart_is_read_back_but_never_stands_in_for_max(self):
        self.assertTrue(self.write("CL=F", period="20y"))
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff)
        self.assertTrue(fy._yf_client.chart_history("CL=F", period="20y"))
        self.assertEqual(self.requests, [])
        fy._yf_client.chart_history("CL=F", period="max")    # the seasonal history
        self.assertEqual(self.requests, [("CL=F", "max")])

    def test_an_unreadable_file_is_asked_again(self):
        self.assertTrue(self.write(self.SYM))
        payload = self.payload(self.SYM)
        payload["history"] = [{"date": "garbage"}]
        with open(chc.cache_path(self.SYM, "5y"), "w", encoding="utf-8") as f:
            json.dump(payload, f)
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff)
        self.assertTrue(fy._yf_client.quote(self.SYM).get("available"))
        self.assertEqual(self.requests, [(self.SYM, "5y")])


class WriterTest(_ReuseBase):
    SYM = "CLF27.NYM"

    def test_a_full_answer_is_stamped_for_both_readers(self):
        self.assertTrue(self.write(self.SYM, expiry="2026-12-18"))
        payload = self.payload(self.SYM)
        self.assertEqual(payload["settled_through"], self.cutoff.isoformat())
        self.assertEqual(payload["complete_for"], self.cutoff.isoformat())
        self.assertEqual(payload["expiry"], "2026-12-18")
        self.assertEqual(payload["contract_type"], "single_expiry_month")

    def test_a_short_answer_is_kept_for_the_generator_but_not_served(self):
        # A thin far month that did not print on the settled session.
        short = _frame_to(self.cutoff - timedelta(days=3))
        fy._yf_client.seed({"history": {(self.SYM, "5y", "1d"): short}, "quotes": {}})
        self.assertTrue(cd._write_contract_history(self.SYM, now_et=self.now))
        payload = self.payload(self.SYM)
        self.assertIsNone(payload["settled_through"])
        self.assertEqual(payload["complete_for"], self.cutoff.isoformat())
        self.assertFalse(start._contract_history_is_current(
            payload, self.cutoff, self.now.timestamp() + 1))

    def test_an_empty_answer_during_a_rate_limit_is_not_kept(self):
        empty = pd.DataFrame({"Open": [], "High": [], "Low": [], "Close": [], "Volume": []})
        fy._yf_client.seed({"history": {(self.SYM, "5y", "1d"): empty}, "quotes": {}})
        with mock.patch.object(yg._instance, "cooldown_active", lambda: True):
            self.assertFalse(cd._write_contract_history(self.SYM, now_et=self.now))
        self.assertFalse(os.path.exists(chc.cache_path(self.SYM, "5y")))

    def test_a_holiday_evening_file_is_served_but_never_reused(self):
        # Labor Day after the settle: the generator's clock calls Monday settled, the
        # server's cutoff is Friday. Rows cut at Friday are not what this run ingested.
        self.now = datetime(2026, 9, 7, 18, 0, tzinfo=ET)
        frame = _frame_to(datetime(2026, 9, 4).date())
        fy._yf_client.seed({"history": {(self.SYM, "5y", "1d"): frame}, "quotes": {}})
        self.assertTrue(cd._write_contract_history(self.SYM, now_et=self.now))
        payload = self.payload(self.SYM)
        self.assertEqual(payload["settled_through"], "2026-09-04")
        self.assertNotIn("complete_for", payload)

    def test_a_reused_file_is_kept_not_rewritten(self):
        self.assertTrue(self.write(self.SYM))
        before = self.payload(self.SYM)
        path = chc.cache_path(self.SYM, "5y")
        os.utime(path, (wallclock.time() - 5 * 86400,) * 2)
        self.fresh_client()
        self.requests.clear()
        fy.enable_cache_reuse(self.cutoff)
        fy._yf_client.quote(self.SYM, quiet=True)             # answered by the file
        later = self.now + timedelta(hours=5)                 # a later run, same settle
        with mock.patch.object(chc, "write_payload", side_effect=AssertionError("rewritten")):
            self.assertTrue(cd._write_contract_history(self.SYM, now_et=later))
        self.assertEqual(self.requests, [])
        self.assertEqual(self.payload(self.SYM), before)
        self.assertGreater(os.path.getmtime(path), wallclock.time() - 60)

    def test_an_unreadable_complete_file_is_repaired_not_kept(self):
        self.assertTrue(self.write(self.SYM))
        payload = self.payload(self.SYM)
        payload["history"] = [{"date": "garbage"}]
        with open(chc.cache_path(self.SYM, "5y"), "w", encoding="utf-8") as f:
            json.dump(payload, f)
        self.fresh_client()
        fy.enable_cache_reuse(self.cutoff)
        fy._yf_client.quote(self.SYM, quiet=True)             # asked again: file unreadable
        self.assertTrue(cd._write_contract_history(self.SYM, now_et=self.now))
        self.assertEqual(self.payload(self.SYM)["history"][-1]["date"], self.cutoff.isoformat())

    def test_without_reuse_a_complete_file_is_rewritten(self):
        self.assertTrue(self.write(self.SYM))
        self.fresh_client()
        later = self.now + timedelta(hours=5)
        fy._yf_client.quote(self.SYM, quiet=True)
        self.assertTrue(cd._write_contract_history(self.SYM, now_et=later))
        self.assertEqual(self.payload(self.SYM)["fetched_at"], later.timestamp())

    def test_the_continuous_chart_is_named_as_such(self):
        self.assertTrue(self.write("CL=F", period="20y", contract_type="continuous_front_month"))
        self.assertEqual(self.payload("CL=F", "20y")["contract_type"], "continuous_front_month")


class GatherReuseTest(_ReuseBase):
    def gather(self, fresh=False, on_first_pass=None):
        with self.gather_env(workers=2):
            return cd.gather_commodity_data(count=6, on_first_pass=on_first_pass, fresh=fresh)

    def store_board(self, dataset):
        """Write the run's board, as generate_html does after every run, so the next run
        finds this year's seasonal history stored and does not ask for `max` again."""
        self.generate(dataset)
        fy._existing_seasonal_years = None         # the process-wide cache, read afresh

    def test_every_answer_of_a_run_is_kept(self):
        self.gather()
        for sym, period in self.requests:
            if period == "5y":
                self.assertTrue(os.path.exists(chc.cache_path(sym, period)), sym)
        for k in KEYS:
            chart = self.markets[k]["yf_continuous"]
            self.assertTrue(os.path.exists(chc.cache_path(chart, "20y")), chart)

    def test_a_chart_cut_from_the_seasonal_max_is_kept_too(self):
        # A first pass asks for the seasonal `max` before the 20y chart and cuts the chart
        # out of it: no 20y frame in the cache, and still a 20y file.
        self.gather(on_first_pass=lambda dataset: None)
        for k in KEYS:
            chart = self.markets[k]["yf_continuous"]
            self.assertNotIn((chart, "20y"), self.requests)
            self.assertTrue(os.path.exists(chc.cache_path(chart, "20y")), chart)

    def test_a_second_run_on_the_same_settle_asks_yahoo_nothing(self):
        first = self.gather()
        self.store_board(first)
        self.assertTrue(self.requests)
        self.requests.clear()
        self.fresh_client()
        second = self.gather()
        self.assertEqual(self.requests, [])
        self.assertIn("answered from ff_data/contract_history", self.output)
        for k in KEYS:
            for field in ("contracts", "calendar_spread_series"):
                self.assertEqual(second[k][field], first[k][field], (k, field))
            for series in ("history", "total_volume_series"):
                self.assertEqual(second[k]["continuous_contract"][series],
                                 first[k]["continuous_contract"][series], (k, series))

    def test_fresh_asks_everything_again(self):
        self.gather()
        asked = sorted(self.requests)
        self.requests.clear()
        self.fresh_client()
        self.gather(fresh=True)
        self.assertEqual(sorted(self.requests), asked)

    def test_the_first_pass_is_skipped_only_when_it_could_show_nothing_new(self):
        boards = []
        hook = lambda dataset: boards.append(dataset)
        self.store_board(self.gather(on_first_pass=hook))   # run 1 writes a board
        self.assertEqual(len(boards), 1)
        self.fresh_client()
        self.gather(on_first_pass=hook)                     # same settle: nothing new
        self.assertEqual(len(boards), 1)
        self.assertIn("First-pass board skipped", self.output)
        self.fresh_client()
        self.gather(on_first_pass=hook, fresh=True)         # asked again: new answers
        self.assertEqual(len(boards), 2)

    def test_no_board_means_a_first_pass_even_from_the_cache(self):
        boards = []
        self.gather()                                        # files, but no board on disk
        self.fresh_client()
        self.gather(on_first_pass=lambda dataset: boards.append(dataset))
        self.assertEqual(len(boards), 1)


class KeepEveryAnswerTest(_ReuseBase):
    """Phase 2 keeps every 5y answer its market task holds, whoever asked for it: the scan,
    quote() on a forward-curve candidate past the scan's window (a month not listed yet), or
    the settled-contract probe. Asked again on every run, those were the requests a run on
    the same settle still made (19 on 2026-11-08: 13 unlisted *M28 months, 6 sugar and
    cotton probes)."""

    def test_an_answer_only_quote_asked_for_is_kept(self):
        key = KEYS[0]
        cfg = dict(self.markets[key], _key=key)
        fy._yf_client.quote("XXM28.NYM", quiet=True)          # in no candidate list
        frames = fy._yf_client.cache_added_since((frozenset(), frozenset()))["history"]
        with contextlib.redirect_stdout(io.StringIO()):
            cd._write_market_histories(cfg, [], None, frames, set(), now_et=self.now)
        self.assertTrue(os.path.exists(chc.cache_path("XXM28.NYM", "5y")))

    def test_the_settled_contract_probe_asks_at_the_kept_period(self):
        sym = "CLZ26.NYM"
        history = fy._yf_client.chart_history(sym, period="5y")
        self.fresh_client()
        self.requests.clear()
        cfg = dict(self.markets[KEYS[0]], _key=KEYS[0])
        fy.resolve_settled_contracts(cfg, history[-3:], [{"yf_symbol": sym}])
        self.assertEqual(self.requests[0], (sym, "5y"))


def _reference_rows(hist):
    """chart_history's rows as it built them before 2026-11-08, one iterrows() at a time —
    the definition the column-wise build must reproduce exactly."""
    out = []
    for idx, row in hist.iterrows():
        o, h, l, c = row["Open"], row["High"], row["Low"], row["Close"]
        if any(v != v for v in (o, h, l, c)):
            continue
        out.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open": series_utils._round_price(float(o)),
            "high": series_utils._round_price(float(h)),
            "low": series_utils._round_price(float(l)),
            "close": series_utils._round_price(float(c)),
            "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else None,
        })
    return series_utils._drop_unsettled_tail(series_utils._trim_leading_flat(out))


class RowBuildTest(unittest.TestCase):
    """chart_history builds its rows column-wise (a cache run builds ~440 contracts' rows
    with no network wait to hide them behind); the rows must not change by a digit."""

    def check(self, frame):
        client = fy.YahooFinanceClient()
        client._history_cache[("X", "5y", "1d")] = frame
        self.assertEqual(client.chart_history("X", period="5y"), _reference_rows(frame))

    def test_yahoo_shaped_frame_with_holes(self):
        idx = pd.date_range(end=pd.Timestamp("2026-11-06", tz="America/New_York"),
                            periods=40, freq="B")
        nan = float("nan")
        frame = pd.DataFrame({
            "Open": [1.0, 1.0] + [0.00651234 + i * 1e-6 for i in range(38)],
            "High": [1.0, 1.0] + [0.0066 + i * 1e-6 for i in range(38)],
            "Low": [1.0, 1.0] + [0.0064 for _ in range(38)],
            "Close": [1.0, 1.0] + [0.00655555] * 37 + [nan],
            "Volume": [0, 0] + [1000 + i for i in range(38)],
            "Dividends": 0.0, "Stock Splits": 0.0,
        }, index=idx)
        frame.loc[idx[10], "Open"] = nan                     # a row Yahoo left unpriced
        with mock.patch.object(series_utils, "_eastern_now",
                               lambda: datetime(2026, 11, 8, 1, 0, tzinfo=ET)):
            self.check(frame)

    def test_float_volume_with_gaps_and_prices_above_one(self):
        idx = pd.date_range(end=pd.Timestamp("2026-11-06"), periods=30, freq="D")
        frame = pd.DataFrame({
            "Open": [4012.123456 + i for i in range(30)],
            "High": [4020.98765 + i for i in range(30)],
            "Low": [4001.5 + i for i in range(30)],
            "Close": [4010.25 + i for i in range(30)],
            "Volume": [float("nan") if i % 7 == 0 else float(i * 10) for i in range(30)],
        }, index=idx)
        with mock.patch.object(series_utils, "_eastern_now",
                               lambda: datetime(2026, 11, 8, 1, 0, tzinfo=ET)):
            self.check(frame)


if __name__ == "__main__":
    unittest.main()
