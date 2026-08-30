# ── test_screener_score.py ── Stdlib-only unit tests for the screener alignment rule.
# Run from app/:  python3 -m unittest test_screener_score -v
# No network: screener_score is pure, and the summary fixture is an empty market.

import unittest

import screener


class SignalDirection(unittest.TestCase):
    def test_bullish_and_premium_are_positive(self):
        self.assertEqual(screener._signal_dir("bullish"), 1)
        self.assertEqual(screener._signal_dir("premium"), 1)

    def test_bearish_and_discount_are_negative(self):
        self.assertEqual(screener._signal_dir("bearish"), -1)
        self.assertEqual(screener._signal_dir("discount"), -1)

    def test_neutral_missing_and_unknown_are_zero(self):
        for value in ("neutral", None, "", "wat"):
            self.assertEqual(screener._signal_dir(value), 0, value)


class ScreenerScore(unittest.TestCase):
    def test_full_bullish_alignment_is_plus_three(self):
        self.assertEqual(screener.screener_score(
            {"seasonal": "bullish", "cot_hedge": "bullish", "structure": "premium"}), 3)

    def test_full_bearish_alignment_is_minus_three(self):
        self.assertEqual(screener.screener_score(
            {"seasonal": "bearish", "cot_hedge": "bearish", "structure": "discount"}), -3)

    def test_missing_structure_counts_as_neutral(self):
        # Yahoo drops quotes for thin deferred months, so structure can be absent.
        self.assertEqual(screener.screener_score(
            {"seasonal": "bullish", "cot_hedge": "bullish"}), 2)

    def test_plain_cot_is_ignored(self):
        # A row that still carries the removed signal (a pre-change screener.json)
        # must not have it counted.
        self.assertEqual(screener.screener_score(
            {"seasonal": "bullish", "cot": "bearish", "cot_hedge": "bullish",
             "structure": "premium"}), 3)

    def test_abs_two_means_two_aligned_and_one_neutral(self):
        # The whole design rests on this: with THREE signals, |score| == 2 can only be
        # produced by two agreeing votes plus one neutral -- an opposing vote can never
        # get past |score| == 1. Asserted exhaustively over all 27 combinations.
        for seasonal in ("bullish", "bearish", "neutral"):
            for hedge in ("bullish", "bearish", "neutral"):
                for structure in ("premium", "discount", None):
                    row = {"seasonal": seasonal, "cot_hedge": hedge, "structure": structure}
                    dirs = [screener._signal_dir(row[k]) for k in screener.SCORE_SIGNALS]
                    score = screener.screener_score(row)
                    if abs(score) == 2:
                        self.assertEqual(dirs.count(0), 1, row)
                        self.assertNotIn(-1 if score > 0 else 1, dirs, row)


class SummaryRow(unittest.TestCase):
    """build_screener_summary over one empty market: every signal resolves to None,
    which is the cheapest fixture that still exercises the row shape."""

    def _row(self):
        by_cat = {"Grains": {"corn": {
            "display_name": "Corn",
            "continuous_contract": {"history": [], "seasonal_history": []},
            "contracts": [],
            "cot_series": [],
            "calendar_spread_series": [],
        }}}
        return screener.build_screener_summary(by_cat)[0]

    def test_row_carries_a_score(self):
        self.assertEqual(self._row()["score"], 0)

    def test_row_no_longer_carries_the_plain_cot_signal(self):
        self.assertNotIn("cot", self._row())


if __name__ == "__main__":
    unittest.main()
