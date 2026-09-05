# ── test_local_first_merge.py ── Stdlib-only unit tests for the local-first
# contract-quote fallback and the calendar-spread fallback. Run from app/:
#   python3 -m unittest test_local_first_merge -v

import unittest

from datetime import date, timedelta

from local_first_merge import (
    _choose_fresh_or_previous_contracts,
    _choose_fresh_or_previous_series,
    _choose_fresh_or_previous_spread,
    _history_looks_worse,
    _recent_max_gap_days,
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


def _daily(start, end, skip=()):
    """Weekday bars from `start` to `end`, minus any (from, to) ranges in `skip`."""
    rows, day = [], date.fromisoformat(start)
    last = date.fromisoformat(end)
    holes = [(date.fromisoformat(a), date.fromisoformat(b)) for a, b in skip]
    while day <= last:
        if day.weekday() < 5 and not any(a <= day <= b for a, b in holes):
            rows.append({"date": day.isoformat()})
        day += timedelta(days=1)
    return rows


class RecentMaxGapDaysTest(unittest.TestCase):
    def test_ignores_a_hole_outside_the_window(self):
        rows = _daily("2006-01-02", "2026-08-31", skip=[("2007-04-27", "2007-06-27")])
        self.assertGreater(max((date.fromisoformat(b["date"]) - date.fromisoformat(a["date"])).days
                               for a, b in zip(rows, rows[1:])), 21)
        self.assertLessEqual(_recent_max_gap_days(rows), 4)

    def test_sees_a_hole_inside_the_window(self):
        rows = _daily("2006-01-02", "2026-08-31", skip=[("2026-05-01", "2026-06-30")])
        self.assertGreater(_recent_max_gap_days(rows), 21)

    def test_anchors_on_the_series_own_last_bar_not_on_today(self):
        # A series that ended years ago is judged over ITS last three years, so a stale
        # store is not automatically "clean" just by having no recent bars at all.
        rows = _daily("2016-01-04", "2019-12-31", skip=[("2019-03-01", "2019-05-31")])
        self.assertGreater(_recent_max_gap_days(rows), 21)

    def test_too_few_points_is_not_a_gap(self):
        self.assertEqual(_recent_max_gap_days([]), 0)
        self.assertEqual(_recent_max_gap_days([{"date": "2026-08-31"}]), 0)


class HistoryGapGateTest(unittest.TestCase):
    """The platinum wedge (2026-06-12 -> 2026-09-01): Yahoo's PL=F carries 19 multi-week
    holes, every one of them in 1997-2009. Judged whole-series, the fresh fetch was
    rejected for gappiness on every run — and since an accepted fetch is the only thing
    that can extend the store, the market froze in the JSON and in the SQLite archive
    while data_quality still called it "ok"."""

    def test_ancient_gap_no_longer_vetoes_a_fetch_that_reaches_further(self):
        fresh = _daily("2006-09-28", "2026-08-31", skip=[("2007-04-27", "2007-06-27")])
        previous = _daily("2021-04-14", "2026-06-12")

        use_previous, fresh_health, _prev, reason = _history_looks_worse(
            fresh, previous, kind="price")

        self.assertFalse(use_previous)
        self.assertEqual(reason, "fresh_history_accepted")
        # The old whole-series figure is still reported — it is true, just not the test.
        self.assertGreater(fresh_health["max_gap_days"], 21)
        self.assertLessEqual(fresh_health["recent_gap_days"], 4)

    def test_a_recent_hole_is_still_rejected(self):
        fresh = _daily("2006-09-28", "2026-08-31", skip=[("2026-05-01", "2026-06-30")])
        previous = _daily("2021-04-14", "2026-06-12")

        use_previous, _fresh, _prev, reason = _history_looks_worse(
            fresh, previous, kind="price")

        self.assertTrue(use_previous)
        self.assertEqual(reason, "fresh_history_has_large_gaps")

    def test_the_chosen_series_is_the_fresh_one_for_the_platinum_shape(self):
        fresh = _daily("2006-09-28", "2026-08-31", skip=[("2007-04-27", "2007-06-27")])
        previous = _daily("2021-04-14", "2026-06-12")

        chosen = _choose_fresh_or_previous_series(fresh, previous, kind="price")

        self.assertEqual(chosen["used"], "fresh_api")
        self.assertEqual(chosen["series"][-1]["date"], "2026-08-31")


if __name__ == "__main__":
    unittest.main()
