# ── test_local_first_merge.py ── Stdlib-only unit tests for the local-first
# contract-quote fallback. Run from app/:  python3 -m unittest test_local_first_merge -v

import unittest

from local_first_merge import _choose_fresh_or_previous_contracts


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


if __name__ == "__main__":
    unittest.main()
