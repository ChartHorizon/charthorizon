# ── test_calendar_spread.py ── The calendar spread's NEXT leg may come from a month that
# settled without trading. Deferred Treasury months settle every session and trade on a few:
# after the 2026-08-28 roll ZFH27 traded on three of ten sessions, and a spread built from
# traded rows alone had two points by 09-11. Settled rows are a last resort for the next leg
# only — never a front — and a month that only ever settled still counts as listed.
# Run from app/:  python3 -m unittest test_calendar_spread -v
# No network: build_calendar_spread_series is pure, and the loop test injects every fetch.

from __future__ import annotations

import unittest
from unittest import mock

import fetch_yfinance as fy

DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08"]


def _row(symbol, chain, expiry, close, volume):
    return {"contract_symbol": symbol, "chain_index": chain, "expiry": expiry,
            "close": close, "roll_basis_volume": volume}


def _front(i):
    return _row("ZFZ26", 10, "2026-12-31", round(105.5 - 0.1 * i, 4), 1_500_000)


def _march(i, volume=1):
    return _row("ZFH27", 11, "2027-03-31", round(105.4 - 0.1 * i, 4), volume)


class SettledNextLegTest(unittest.TestCase):
    def test_a_settled_month_fills_the_next_leg_on_days_it_did_not_trade(self):
        candidates = {d: [_front(i)] for i, d in enumerate(DAYS)}
        traded = {DAYS[0]: _march(0), DAYS[2]: _march(2)}
        settled = {d: {11: _march(i, volume=0)} for i, d in enumerate(DAYS) if d not in traded}

        # Traded rows alone: only the two days March traded.
        without = fy.build_calendar_spread_series(candidates, traded)
        self.assertEqual([r["date"] for r in without], [DAYS[0], DAYS[2]])

        rows = fy.build_calendar_spread_series(candidates, traded, settled)
        self.assertEqual([r["date"] for r in rows], DAYS)
        self.assertEqual({(r["front_contract"], r["next_contract"]) for r in rows}, {("ZFZ26", "ZFH27")})
        for r in rows:
            self.assertAlmostEqual(r["spread"], 0.1, places=6)

    def test_a_settled_row_is_never_the_front(self):
        # On DAYS[3] only the expiring September printed a trade. December's own settlement
        # that day must not stand in for a front that did not trade.
        candidates = {d: [_front(i)] for i, d in enumerate(DAYS)}
        candidates[DAYS[3]] = [_row("ZFU26", 9, "2026-09-30", 105.9, 600)]
        settled = {d: {10: dict(_front(i), roll_basis_volume=0), 11: _march(i, volume=0)}
                   for i, d in enumerate(DAYS)}

        rows = fy.build_calendar_spread_series(candidates, {}, settled)
        self.assertEqual([r["date"] for r in rows], [d for d in DAYS if d != DAYS[3]])
        self.assertEqual({r["front_contract"] for r in rows}, {"ZFZ26"})

    def test_a_month_that_only_settled_is_still_the_next_month(self):
        # March never traded in the window, June did. The pair is still December/March — the
        # month the exchange lists next — not December/June.
        candidates = {d: [_front(i)] for i, d in enumerate(DAYS)}
        june = {d: _row("ZFM27", 12, "2027-06-30", round(105.3 - 0.1 * i, 4), 5) for i, d in enumerate(DAYS)}
        settled = {d: {11: _march(i, volume=0)} for i, d in enumerate(DAYS)}

        self.assertEqual({r["next_contract"] for r in fy.build_calendar_spread_series(candidates, june)},
                         {"ZFM27"})
        rows = fy.build_calendar_spread_series(candidates, june, settled)
        self.assertEqual([r["date"] for r in rows], DAYS)
        self.assertEqual({r["next_contract"] for r in rows}, {"ZFH27"})


def _bar(day, close, volume, flat=False):
    if flat:     # an untraded session: Yahoo prints the settlement as open = high = low = close
        return {"date": day, "open": close, "high": close, "low": close, "close": close, "volume": volume}
    return {"date": day, "open": close + 0.02, "high": close + 0.05, "low": close - 0.05,
            "close": close, "volume": volume}


class SettledRowsReachTheSpreadTest(unittest.TestCase):
    """The contract loop is where untraded rows were lost: `_history_row_looks_tradable` drops
    a zero-volume or flat bar, which is right for the volume-led selection and was wrong for
    the next leg. Every fetch is injected."""

    def test_untraded_settlements_of_the_next_month_reach_the_spread(self):
        contracts = [
            {"yf_symbol": "ZFZ26.CBT", "contract_symbol": "ZFZ26", "chain_index": 10, "expiry": "2026-12-31"},
            {"yf_symbol": "ZFH27.CBT", "contract_symbol": "ZFH27", "chain_index": 11, "expiry": "2027-03-31"},
        ]
        histories = {
            "ZFZ26.CBT": [_bar(d, 105.5 - 0.1 * i, 1_500_000) for i, d in enumerate(DAYS)],
            # March trades on the first day only and settles untraded on the other four.
            "ZFH27.CBT": [_bar(d, 105.4 - 0.1 * i, 3 if i == 0 else 0, flat=i != 0) for i, d in enumerate(DAYS)],
        }
        with mock.patch.object(fy, "build_total_volume_contract_candidates", lambda cfg, **kw: contracts), \
                mock.patch.object(fy, "_skip_dead_contract", lambda contract: False), \
                mock.patch.object(fy, "_note_contract_result", lambda contract, rows: None), \
                mock.patch.object(fy._yf_client, "chart_history", lambda symbol, **kw: histories[symbol]):
            _, _, spread = fy.fetch_yfinance_liquid_continuous_history({"yf_root": "ZF"}, fallback_history=[])

        self.assertEqual([r["date"] for r in spread], DAYS)
        self.assertEqual({(r["front_contract"], r["next_contract"]) for r in spread}, {("ZFZ26", "ZFH27")})


class OnlyTheCurrentPairTest(unittest.TestCase):
    def test_the_series_starts_over_at_a_roll(self):
        # September/December until the roll, December/March from it. Two sessions after the
        # roll the series is those two points of the new pair — no preceding pair rides along.
        days = DAYS + ["2026-09-09"]

        def sep(i, volume):
            return _row("ZFU26", 9, "2026-09-30", round(105.7 - 0.1 * i, 4), volume)

        def dec(i, volume):
            return _row("ZFZ26", 10, "2026-12-31", round(105.5 - 0.1 * i, 4), volume)

        candidates = {d: [sep(i, 1_000_000), dec(i, 100_000)] for i, d in enumerate(days) if i < 4}
        candidates.update({d: [sep(i, 50_000), dec(i, 2_000_000)] for i, d in enumerate(days) if i >= 4})
        settled = {d: {11: _march(i, volume=0)} for i, d in enumerate(days)}

        rows = fy.build_calendar_spread_series(candidates, {}, settled)
        self.assertEqual([r["date"] for r in rows], days[4:])
        self.assertEqual({(r["front_contract"], r["next_contract"]) for r in rows}, {("ZFZ26", "ZFH27")})


if __name__ == "__main__":
    unittest.main()
