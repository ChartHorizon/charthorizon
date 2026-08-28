# ── test_local_first_merge.py ── Stdlib-only unit tests for the local-first
# contract-quote fallback and the calendar-spread fallback. Run from app/:
#   python3 -m unittest test_local_first_merge -v

import unittest

from local_first_merge import (
    _choose_fresh_or_previous_contracts,
    _choose_fresh_or_previous_spread,
)


def _contract(yf_symbol, available, volume=None, last=None, source=None):
    return {
        "yf_symbol": yf_symbol,
        "contract_symbol": yf_symbol.split(".")[0],
        "label": "Sep 2026",
        "expiry": "2026-09-28",
        "last": last,
        "change": None,
        "change_pct": None,
        "volume": volume,
        "open_interest": None,
        "available": available,
        "source": source,
    }


class ChooseFreshOrPreviousContractsTest(unittest.TestCase):
    def test_reuses_previous_quote_when_fresh_is_blank(self):
        fresh = [_contract("SIN26.CMX", available=False)]
        previous = [_contract("SIN26.CMX", available=True, volume=28, last=58.65, source="yfinance")]

        merged = _choose_fresh_or_previous_contracts(fresh, previous)

        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["available"])
        self.assertEqual(merged[0]["volume"], 28)
        self.assertEqual(merged[0]["last"], 58.65)
        self.assertEqual(merged[0]["source"], "previous_local_store")
        # Identity fields stay from the fresh candidate, not the previous one.
        self.assertEqual(merged[0]["contract_symbol"], "SIN26")

    def test_keeps_fresh_quote_when_available(self):
        fresh = [_contract("SIU26.CMX", available=True, volume=34948, last=58.9, source="yfinance")]
        previous = [_contract("SIU26.CMX", available=True, volume=30000, last=57.0, source="yfinance")]

        merged = _choose_fresh_or_previous_contracts(fresh, previous)

        self.assertEqual(merged[0]["volume"], 34948)
        self.assertEqual(merged[0]["source"], "yfinance")

    def test_stays_blank_when_no_matching_previous_contract(self):
        fresh = [_contract("SIZ26.CMX", available=False)]
        previous = [_contract("SIN26.CMX", available=True, volume=28)]  # different symbol

        merged = _choose_fresh_or_previous_contracts(fresh, previous)

        self.assertFalse(merged[0]["available"])
        self.assertIsNone(merged[0]["volume"])

    def test_stays_blank_when_previous_was_also_blank(self):
        fresh = [_contract("XXQ99.CMX", available=False)]
        previous = [_contract("XXQ99.CMX", available=False)]

        merged = _choose_fresh_or_previous_contracts(fresh, previous)

        self.assertFalse(merged[0]["available"])
        self.assertIsNone(merged[0]["volume"])

    def test_handles_none_previous_contracts(self):
        fresh = [_contract("SIN26.CMX", available=False)]

        merged = _choose_fresh_or_previous_contracts(fresh, None)

        self.assertEqual(merged, fresh)

    def test_handles_empty_fresh_contracts(self):
        self.assertEqual(_choose_fresh_or_previous_contracts([], [_contract("SIN26.CMX", True)]), [])


def _spread(day, front="GCZ26", nxt="GCG27", spread=-36.7, source="yfinance_liquid_contracts"):
    return {
        "date": day,
        "spread": spread,
        "front_contract": front,
        "next_contract": nxt,
        "front_close": 4680.6,
        "next_close": 4717.3,
        "source": source,
    }


class ChooseFreshOrPreviousSpreadTest(unittest.TestCase):
    """The calendar spread is recomputed from scratch every refresh (no accumulation),
    so before this gate an empty fetch WROTE the empty result: on 2026-08-22 a fully
    rate-limited run left 35 of 39 markets with no spread at all, in the JSON and — via
    purge_calendar_spread + rewrite — in the SQLite archive too. Same doctrine as
    price/COT/contracts: a degraded fetch never replaces a healthier local series."""

    def test_reuses_previous_when_fresh_is_empty(self):
        previous = [_spread("2026-08-20"), _spread("2026-08-21")]

        kept = _choose_fresh_or_previous_spread([], previous)

        self.assertEqual([r["date"] for r in kept], ["2026-08-20", "2026-08-21"])
        self.assertTrue(all(r["source"] == "previous_local_store" for r in kept))
        # The reused rows are copies — the caller must not mutate the previous payload.
        self.assertEqual(previous[0]["source"], "yfinance_liquid_contracts")

    def test_keeps_fresh_when_it_reaches_the_same_day(self):
        fresh = [_spread("2026-08-20"), _spread("2026-08-21")]
        previous = [_spread("2026-08-19"), _spread("2026-08-20"), _spread("2026-08-21")]

        self.assertEqual(_choose_fresh_or_previous_spread(fresh, previous), fresh)

    def test_keeps_a_short_fresh_series_after_a_roll(self):
        # _trailing_same_pair_spread keeps only the pair trading today, so the day after
        # a roll the series legitimately collapses to a couple of points. Length must not
        # be the test, or a real roll would be frozen out by the old pair forever.
        fresh = [_spread("2026-08-21", front="GCZ26", nxt="GCG27")]
        previous = [_spread(d, front="GCQ26", nxt="GCZ26") for d in
                    ("2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20")]

        self.assertEqual(_choose_fresh_or_previous_spread(fresh, previous), fresh)

    def test_reuses_previous_when_fresh_ends_earlier(self):
        # A partially throttled run: some contracts answered, the recent ones did not.
        fresh = [_spread("2026-08-12"), _spread("2026-08-13")]
        previous = [_spread("2026-08-20"), _spread("2026-08-21")]

        kept = _choose_fresh_or_previous_spread(fresh, previous)

        self.assertEqual([r["date"] for r in kept], ["2026-08-20", "2026-08-21"])

    def test_keeps_fresh_when_there_is_no_previous_series(self):
        fresh = [_spread("2026-08-21")]
        self.assertEqual(_choose_fresh_or_previous_spread(fresh, None), fresh)
        self.assertEqual(_choose_fresh_or_previous_spread([], None), [])
        self.assertEqual(_choose_fresh_or_previous_spread([], []), [])

    def test_undated_rows_never_win_over_a_dated_series(self):
        fresh = [{"spread": 1.0}]                    # no usable date at all
        previous = [_spread("2026-08-21")]

        kept = _choose_fresh_or_previous_spread(fresh, previous)

        self.assertEqual([r["date"] for r in kept], ["2026-08-21"])


if __name__ == "__main__":
    unittest.main()
