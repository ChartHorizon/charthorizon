# ── test_settled_eod.py ── What "the latest settled EoD" means, and that nothing serves less.
# The 2026-09-11 Hedgers' Ledger shipped cards whose last candle was Thursday's. They were
# exported at 17:27 ET, three minutes before this app counts a daily bar as settled, and the
# single-contract cache behind them never recorded which settle it was built for — so a
# history fetched before 17:30 went on being served after it, until the next refresh wiped
# the folder. The card header then said "Data as of Sep 09" over a Sep 10 candle, because it
# read the continuous series instead of the one drawn, and config.js called the whole board
# "Sep 12": the local calendar day of a run that finished after midnight in Europe.
# Run from app/:  python3 -m unittest test_settled_eod -v
# No network: `_history_rows` is replaced, and the clock is `_eastern_now`.

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date, datetime
from unittest import mock

import commodity_dashboard as cd
import start
import yahoo_gateway

# Same hand-back as test_crash_recovery: importing start installs the server gateway profile,
# whose lock_path is the real ff_data/refresh.lock.
yahoo_gateway.configure(
    capacity=start.live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=start.live_cache.LIVE_RATE_REFILL_PER_SEC,
)

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except ImportError:                      # pragma: no cover - Python 3.7/3.8
    from dateutil import tz
    ET = tz.gettz("America/New_York")


def _et(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=ET)


def _bars(*days):
    return [{"date": d, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 100}
            for d in days]


class LatestSettledEodTest(unittest.TestCase):
    def test_a_bar_counts_as_settled_from_half_past_five_new_york(self):
        self.assertEqual(start._latest_settled_eod_date(_et(2026, 9, 11, 17, 27)), date(2026, 9, 10))
        self.assertEqual(start._latest_settled_eod_date(_et(2026, 9, 11, 17, 30)), date(2026, 9, 11))

    def test_the_weekend_reads_friday(self):
        self.assertEqual(start._latest_settled_eod_date(_et(2026, 9, 12, 10, 0)), date(2026, 9, 11))

    def test_an_exchange_holiday_is_not_a_session(self):
        # Labor Day 2026. No bar will ever exist for 09-07, so a gate that demanded one would
        # refuse every card all evening — and again the next morning, before the settle.
        self.assertEqual(start._latest_settled_eod_date(_et(2026, 9, 7, 18, 0)), date(2026, 9, 4))
        self.assertEqual(start._latest_settled_eod_date(_et(2026, 9, 8, 9, 0)), date(2026, 9, 4))

    def test_the_endpoint_payload_names_the_date_and_the_rule(self):
        payload = start.settled_eod_payload(_et(2026, 9, 11, 17, 27))
        self.assertEqual(payload["settled_eod"], "2026-09-10")
        self.assertEqual(payload["settle_ready_et"], "17:30")


class ContractHistoryFreshnessTest(unittest.TestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)                 # the cache lives at ./ff_data/contract_history
        self.now = _et(2026, 9, 11, 17, 26)
        self.yahoo = _bars("2026-09-09", "2026-09-10")
        self.fetches = []
        for patch in (mock.patch.object(start, "_eastern_now", lambda: self.now),
                      mock.patch.object(start, "_history_rows", self._fake_rows)):
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def _fake_rows(self, symbol, period, priority=None):
        self.fetches.append(self.now)
        return [dict(r) for r in self.yahoo]

    @staticmethod
    def _last(payload):
        return payload["history"][-1]["date"]

    def test_a_history_cached_before_the_settle_is_refetched_after_it(self):
        # The incident: fetched at 17:26 ET, it ends on Thursday, correctly. At 17:31 the
        # Friday bar is settled and Yahoo has it — serving the cached Thursday is the bug.
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-10")
        self.now = _et(2026, 9, 11, 17, 31)
        self.yahoo = _bars("2026-09-09", "2026-09-10", "2026-09-11")
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-11")
        self.assertEqual(len(self.fetches), 2)

    def test_a_history_that_reaches_the_settle_is_served_from_the_cache(self):
        self.now = _et(2026, 9, 11, 17, 31)
        self.yahoo = _bars("2026-09-10", "2026-09-11")
        start.get_contract_history("ZCZ26.CBT", "5y")
        self.now = _et(2026, 9, 11, 22, 0)
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-11")
        self.assertEqual(len(self.fetches), 1)

    def test_an_empty_refetch_keeps_the_older_history_rather_than_a_blank_chart(self):
        start.get_contract_history("ZCZ26.CBT", "5y")
        self.now = _et(2026, 9, 11, 17, 31)
        self.yahoo = []                          # throttled, or Yahoo answering empty
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-10")
        self.assertEqual(len(self.fetches), 2)

    def test_a_settle_yahoo_has_not_posted_yet_is_retried_but_not_on_every_request(self):
        self.now = _et(2026, 9, 11, 17, 31)      # settled by the clock, but Yahoo still ends Thursday
        start.get_contract_history("ZCZ26.CBT", "5y")
        self.now = _et(2026, 9, 11, 17, 33)
        start.get_contract_history("ZCZ26.CBT", "5y")
        self.assertEqual(len(self.fetches), 1)   # inside the retry window the cache stands
        self.now = _et(2026, 9, 11, 17, 32 + start.CONTRACT_HISTORY_RETRY_SECONDS // 60)
        self.yahoo = _bars("2026-09-10", "2026-09-11")
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-11")
        self.assertEqual(len(self.fetches), 2)

    def test_a_cache_file_written_before_this_rule_is_judged_by_its_last_bar(self):
        os.makedirs(os.path.join("ff_data", "contract_history"))
        with open(start._contract_history_cache_path("ZCZ26.CBT", "5y"), "w", encoding="utf-8") as f:
            json.dump({"symbol": "ZCZ26.CBT", "period": "5y", "source": "yfinance",
                       "contract_type": "single_expiry_month",
                       "history": _bars("2026-09-09", "2026-09-10")}, f)
        self.now = _et(2026, 9, 11, 18, 0)
        self.yahoo = _bars("2026-09-10", "2026-09-11")
        self.assertEqual(self._last(start.get_contract_history("ZCZ26.CBT", "5y")), "2026-09-11")


class DataAsOfLabelTest(unittest.TestCase):
    def test_the_label_names_the_board_settled_session(self):
        self.assertEqual(cd._data_as_of_label(date(2026, 9, 11), {}), "Sep 11, 2026")

    def test_without_a_board_vote_it_names_the_newest_written_bar(self):
        dataset = {"corn": {"continuous_contract": {"history": _bars("2026-09-09", "2026-09-10")}},
                   "gold": {"continuous_contract": {"history": _bars("2026-09-11")}}}
        self.assertEqual(cd._data_as_of_label(None, dataset), "Sep 11, 2026")


class ContractHistoryPrecisionTest(unittest.TestCase):
    """The single-contract endpoint is what every card draws, and it rounded every price to 4
    decimals — the rounding the generator dropped long ago (`series_utils._round_price`). The yen
    trades near 0.0065, so each 6J bar came out open = high = low = close = 0.0065, and the
    re-shot 2026-09-11 Ledger's yen card drew a staircase."""

    def _rows(self, bars):
        import sys
        import types
        try:
            import pandas as pd
        except ImportError:                      # pragma: no cover - pandas ships with yfinance
            self.skipTest("pandas not importable here")
        idx = pd.DatetimeIndex([b[0] for b in bars], tz="America/New_York", name="Date")
        frame = pd.DataFrame([{"Open": o, "High": h, "Low": l, "Close": c, "Volume": v}
                              for _, o, h, l, c, v in bars], index=idx)

        class Ticker:
            def __init__(self, symbol, session=None):
                pass

            def history(self, period, interval="1d"):
                return frame

        fake = types.ModuleType("yfinance")
        fake.Ticker = Ticker
        with mock.patch.dict(sys.modules, {"yfinance": fake}), \
                mock.patch.object(start, "_eastern_now", lambda: _et(2026, 9, 12, 10, 0)):
            return start._history_rows("6JU26.CME", "5y")

    def test_a_yen_bar_keeps_its_own_open_high_low_and_close(self):
        rows = self._rows([("2026-09-08", 0.006406, 0.006544, 0.006401, 0.006511, 609420)])
        self.assertEqual([(r["open"], r["high"], r["low"], r["close"]) for r in rows],
                         [(0.006406, 0.006544, 0.006401, 0.006511)])

    def test_a_price_above_one_keeps_four_decimals(self):
        rows = self._rows([("2026-09-10", 19.430001, 19.899999, 19.24, 19.75, 163960)])
        self.assertEqual((rows[0]["open"], rows[0]["high"]), (19.43, 19.9))


if __name__ == "__main__":
    unittest.main()
