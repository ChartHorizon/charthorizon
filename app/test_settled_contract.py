# ── test_settled_contract.py ── Which single contract a native `=F` series settles on.
# One Yahoo answer for an `=F` chart prices its settled bars off the nearest contract and
# its still-forming bar off the next one (2026-09-11, 12 of 12 markets checked: SB=F
# settled SBV26 at 18.73, forming SBH27 at 19.15). The live overlay spliced that forming
# bar onto the settled series and drew a roll that is not in the market, so the generator
# now records the settled contract and the overlay polls that instead.
# Run from app/:  python3 -m unittest test_settled_contract -v
# No network: every Yahoo read goes through the injected `fetch`.

from __future__ import annotations

import unittest

import fetch_yfinance
import yahoo_gateway as yg
from fetch_yfinance import _settlement_rows, resolve_settled_contracts
from local_first_merge import _settled_contract_for_history

try:
    import pandas as pd
except ImportError:                     # pragma: no cover - pandas ships with yfinance
    pd = None


def _rows(pairs):
    return [{"date": d, "open": c, "high": c, "low": c, "close": c, "volume": 1} for d, c in pairs]


SUGAR = {"_key": "sugar", "yf_continuous": "SB=F", "yf_root": "SB", "yf_exchange": "NYB"}
GOLD = {"_key": "gold", "yf_continuous": "GC=F", "yf_root": "GC", "yf_exchange": "CMX"}

SUGAR_CONTRACTS = [
    {"yf_symbol": "SBH27.NYB", "expiry": "2027-02-26"},
    {"yf_symbol": "SBV26.NYB", "expiry": "2026-09-30"},
]
SUGAR_SETTLED = _rows([("2026-09-08", 18.10), ("2026-09-09", 18.40), ("2026-09-10", 18.73)])


class FakeFetch:
    """Serves rows per symbol and records the order symbols were asked for."""
    def __init__(self, rows_by_symbol, raising=()):
        self.rows_by_symbol = rows_by_symbol
        self.raising = set(raising)
        self.calls = []

    def __call__(self, symbol):
        self.calls.append(symbol)
        if symbol in self.raising:
            raise yg.RateLimitedError(f"{symbol}: throttled")
        return self.rows_by_symbol.get(symbol, [])


class ResolveSettledContractsTest(unittest.TestCase):
    def setUp(self):
        self._saved_memo = dict(fetch_yfinance._dead_memo)
        fetch_yfinance._dead_memo.clear()

    def tearDown(self):
        fetch_yfinance._dead_memo.clear()
        fetch_yfinance._dead_memo.update(self._saved_memo)

    def test_the_listed_contract_whose_settles_match_is_resolved_first(self):
        fetch = FakeFetch({
            "SBV26.NYB": SUGAR_SETTLED,
            "SBH27.NYB": _rows([("2026-09-08", 19.09), ("2026-09-09", 19.39), ("2026-09-10", 19.75)]),
        })
        found = resolve_settled_contracts(SUGAR, SUGAR_SETTLED, SUGAR_CONTRACTS, fetch=fetch)
        self.assertEqual(found, {d: "SBV26.NYB" for d in ("2026-09-08", "2026-09-09", "2026-09-10")})
        # Nearest expiry first, and nothing more once the last bar is placed.
        self.assertEqual(fetch.calls, ["SBV26.NYB"])

    def test_a_month_the_chain_does_not_carry_is_probed_when_no_listed_contract_matches(self):
        # GC=F settles on September gold; the chain is Feb/Apr/Jun/Aug/Oct/Dec.
        settled = _rows([("2026-09-09", 4416.0), ("2026-09-10", 4364.5)])
        fetch = FakeFetch({
            "GCV26.CMX": _rows([("2026-09-09", 4426.7), ("2026-09-10", 4373.7)]),
            "GCZ26.CMX": _rows([("2026-09-09", 4460.7), ("2026-09-10", 4407.3)]),
            "GCU26.CMX": settled,
        })
        contracts = [{"yf_symbol": "GCV26.CMX", "expiry": "2026-10-28"},
                     {"yf_symbol": "GCZ26.CMX", "expiry": "2026-12-29"}]
        found = resolve_settled_contracts(GOLD, settled, contracts, fetch=fetch)
        self.assertEqual(found["2026-09-10"], "GCU26.CMX")
        self.assertEqual(fetch.calls, ["GCV26.CMX", "GCZ26.CMX", "GCU26.CMX"])

    def test_a_calendar_month_that_expired_before_the_last_bar_is_never_asked_for(self):
        settled = _rows([("2026-09-10", 4364.5)])
        fetch = FakeFetch({})
        resolve_settled_contracts(GOLD, settled, [], fetch=fetch)
        self.assertNotIn("GCQ26.CMX", fetch.calls)      # August gold expired 2026-08-27
        self.assertEqual(fetch.calls[0], "GCU26.CMX")

    def test_a_roll_inside_the_window_places_each_bar_on_its_own_contract(self):
        history = _rows([("2026-09-08", 10.0), ("2026-09-09", 10.5), ("2026-09-10", 12.0)])
        fetch = FakeFetch({
            "SBV26.NYB": _rows([("2026-09-08", 10.0), ("2026-09-09", 10.5)]),
            "SBH27.NYB": _rows([("2026-09-08", 11.8), ("2026-09-09", 12.1), ("2026-09-10", 12.0)]),
        })
        found = resolve_settled_contracts(SUGAR, history, SUGAR_CONTRACTS, fetch=fetch)
        self.assertEqual(found, {"2026-09-08": "SBV26.NYB", "2026-09-09": "SBV26.NYB",
                                 "2026-09-10": "SBH27.NYB"})

    def test_a_throttled_candidate_is_skipped_and_the_search_goes_on(self):
        fetch = FakeFetch({"SBX26.NYB": SUGAR_SETTLED}, raising={"SBV26.NYB"})
        found = resolve_settled_contracts(SUGAR, SUGAR_SETTLED, SUGAR_CONTRACTS, fetch=fetch)
        self.assertEqual(found["2026-09-10"], "SBX26.NYB")
        self.assertIn("SBV26.NYB", fetch.calls)

    def test_nothing_matching_leaves_the_last_bar_unresolved(self):
        fetch = FakeFetch({})
        found = resolve_settled_contracts(SUGAR, SUGAR_SETTLED, SUGAR_CONTRACTS, fetch=fetch)
        self.assertNotIn("2026-09-10", found)

    def test_an_index_quote_is_one_instrument_and_needs_no_resolving(self):
        fetch = FakeFetch({})
        cfg = {"_key": "usdx", "yf_continuous": "DX-Y.NYB", "yf_root": "DX", "yf_exchange": "NYB"}
        self.assertEqual(resolve_settled_contracts(cfg, SUGAR_SETTLED, [], fetch=fetch), {})
        self.assertEqual(fetch.calls, [])

    def test_no_history_resolves_nothing(self):
        fetch = FakeFetch({})
        self.assertEqual(resolve_settled_contracts(SUGAR, [], SUGAR_CONTRACTS, fetch=fetch), {})
        self.assertEqual(fetch.calls, [])


class SettledContractForHistoryTest(unittest.TestCase):
    BY_DATE = {"2026-09-09": "SBV26.NYB", "2026-09-10": "SBV26.NYB"}

    def test_the_last_bar_takes_the_contract_resolved_for_its_own_day(self):
        self.assertEqual(_settled_contract_for_history(SUGAR_SETTLED, self.BY_DATE, None),
                         {"yf_symbol": "SBV26.NYB", "date": "2026-09-10"})

    def test_a_series_cut_back_a_day_takes_the_contract_of_the_bar_it_now_ends_on(self):
        self.assertEqual(_settled_contract_for_history(SUGAR_SETTLED[:-1], self.BY_DATE, None),
                         {"yf_symbol": "SBV26.NYB", "date": "2026-09-09"})

    def test_a_kept_stored_series_keeps_its_stored_contract_when_the_day_agrees(self):
        previous = {"yf_symbol": "SBV26.NYB", "date": "2026-09-10"}
        self.assertEqual(_settled_contract_for_history(SUGAR_SETTLED, {}, previous), previous)

    def test_a_contract_resolved_for_another_day_is_never_written(self):
        previous = {"yf_symbol": "SBN26.NYB", "date": "2026-06-30"}
        self.assertIsNone(_settled_contract_for_history(SUGAR_SETTLED, {}, previous))
        self.assertIsNone(_settled_contract_for_history(SUGAR_SETTLED, {"2026-09-08": "SBV26.NYB"}, None))

    def test_no_history_no_contract(self):
        self.assertIsNone(_settled_contract_for_history([], self.BY_DATE, None))


@unittest.skipIf(pd is None, "pandas ships with yfinance")
class SettlementRowsTest(unittest.TestCase):
    """What the resolver reads off a candidate: every priced bar, never filtered by settle volume."""

    def test_the_thin_settled_bar_of_an_expiring_month_is_kept(self):
        # SIU26 on 2026-09-10: 138 lots after a busy August. _drop_unsettled_tail pops a newest bar
        # that thin, and silver was left with no bar to match its =F series against.
        days = pd.bdate_range("2026-08-13", "2026-09-10")
        closes = [66.0 + i * 0.01 for i in range(len(days) - 1)] + [64.284]
        volumes = [5000] * (len(days) - 1) + [138]
        frame = pd.DataFrame({"Open": closes, "High": closes, "Low": closes,
                              "Close": closes, "Volume": volumes}, index=days)
        rows = _settlement_rows(frame)
        self.assertEqual(len(rows), len(days))
        self.assertEqual(rows[-1], {"date": "2026-09-10", "close": 64.284})

    def test_an_unpriced_bar_is_skipped(self):
        days = pd.bdate_range("2026-09-08", "2026-09-10")
        frame = pd.DataFrame({"Close": [18.1, float("nan"), 18.73], "Volume": [1, 1, 1]}, index=days)
        self.assertEqual([r["date"] for r in _settlement_rows(frame)], ["2026-09-08", "2026-09-10"])


if __name__ == "__main__":
    unittest.main()
