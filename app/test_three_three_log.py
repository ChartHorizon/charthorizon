#!/usr/bin/env python3
"""Offline tests for the generator-side 3/3 period log (ff_data/three_three_log.json).

The log used to be written by the content bot alone, so the Weekly Outlook's band went
stale whenever the bot had not run: cotton and soybean oil turned 3/3 after the last bot
run and showed no band at all, while lean hogs kept an OPEN band it had already left.
The generator now owns the file, which means it must (a) reconstruct periods from the
same signal helpers the screener uses, and (b) MERGE rather than overwrite -- the
reconstruction only reaches as far back as the calendar-spread window, and orange juice's
June period already sits outside it.

No network, no running app: every fixture is built here.
"""
from __future__ import annotations

import ast
import inspect
import json
import os
import textwrap
import unittest
from datetime import date, timedelta

import commodity_dashboard
import screener


# ── fixtures ──────────────────────────────────────────────────────────────────

def _seasonal_history(years=20, drop_from=200, drop_to=280):
    """Daily closes over `years` full years: flat at 100 until day-of-year `drop_from`,
    then falling 0.5/day until `drop_to`, then flat. Every year identical, so the 5/10/15Y
    and max curves all agree -- an unambiguous bearish season in the drop window."""
    rows = []
    for y in range(2005, 2005 + years):
        d = date(y, 1, 1)
        while d.year == y:
            if d.weekday() < 5:                      # weekdays only, like a real series
                doy = (d - date(y, 1, 1)).days
                if doy <= drop_from:
                    close = 100.0
                elif doy <= drop_to:
                    close = 100.0 - 0.5 * (doy - drop_from)
                else:
                    close = 100.0 - 0.5 * (drop_to - drop_from)
                rows.append({"date": d.isoformat(), "close": close})
            d += timedelta(days=1)
    return rows


def _cot_series(last_iso, weeks=26):
    """Weekly COT rows across the 182-day window with a monotonically FALLING net, so the
    latest point sits at the BOTTOM of its own trailing range on every day the backfill
    evaluates -- not merely on the last one. (An alternating series reads bullish on the
    days whose slice happens to end on a high week, which is not what this fixture is
    trying to say.)"""
    end = date.fromisoformat(last_iso)
    return [{"date": (end - timedelta(weeks=weeks - k)).isoformat(),
             "cot_net": 1000 - 40 * k} for k in range(weeks + 1)]


def _bearish_market(spread_dates, spread=-1.5):
    """A market whose three signals all read bearish on every date in `spread_dates`:
    the seasonal drop window, a COT net at the bottom of its range, a discount spread."""
    return {
        "continuous_contract": {"seasonal_history": _seasonal_history()},
        "cot_series": _cot_series(spread_dates[-1]),
        "calendar_spread_series": [{"date": d, "spread": spread} for d in spread_dates],
    }


def _drop_window_dates(n=10, start_doy=215, year=2026):
    """`n` consecutive weekday ISO dates inside the fixture's bearish season."""
    out, d = [], date(year, 1, 1) + timedelta(days=start_doy)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _row(key, score):
    return {"key": key, "score": score}


P = lambda direction, start, end: {"direction": direction, "start": start, "end": end}


# ── the reconstruction ────────────────────────────────────────────────────────

class BuildPeriodsTests(unittest.TestCase):

    def test_aligned_signals_produce_an_open_period_from_the_first_spread_day(self):
        dates = _drop_window_dates()
        periods = screener.build_three_three_periods(_bearish_market(dates))
        self.assertEqual(periods, [P("bearish", dates[0], None)])

    def test_period_closes_on_the_day_the_structure_signal_flips(self):
        dates = _drop_window_dates()
        mk = _bearish_market(dates)
        for r in mk["calendar_spread_series"][6:]:
            r["spread"] = 1.5                        # discount -> premium: 3/3 breaks
        periods = screener.build_three_three_periods(mk)
        self.assertEqual(periods, [P("bearish", dates[0], dates[6])])

    def test_no_periods_without_a_calendar_spread_series(self):
        mk = _bearish_market(_drop_window_dates())
        mk["calendar_spread_series"] = []
        self.assertEqual(screener.build_three_three_periods(mk), [])

    def test_no_periods_without_enough_seasonal_history(self):
        mk = _bearish_market(_drop_window_dates())
        mk["continuous_contract"]["seasonal_history"] = _seasonal_history(years=3)
        self.assertEqual(screener.build_three_three_periods(mk), [])


# ── the merge (what keeps history the spread window no longer reaches) ─────────

class MergePeriodsTests(unittest.TestCase):

    def test_keeps_a_period_that_ended_before_the_window(self):
        """Orange juice: its only period predates the trimmed spread series. A
        rebuild-from-scratch drops it; the merge must not."""
        old = [P("bearish", "2026-05-26", "2026-06-15")]
        merged = screener.merge_three_three_periods(old, [], "2026-06-26")
        self.assertEqual(merged, old)

    def test_recomputed_periods_win_inside_the_window(self):
        """Live cattle: the stored start (07-15) is wrong, the reconstruction says 07-09.
        Inside the window the fresh pass is authoritative."""
        old = [P("bullish", "2026-07-15", "2026-07-27")]
        fresh = [P("bullish", "2026-07-09", "2026-07-27")]
        merged = screener.merge_three_three_periods(old, fresh, "2026-06-26")
        self.assertEqual(merged, fresh)

    def test_clips_a_stored_period_that_straddles_the_window_start(self):
        old = [P("bearish", "2026-06-01", None)]
        fresh = [P("bullish", "2026-07-02", None)]
        merged = screener.merge_three_three_periods(old, fresh, "2026-06-26")
        self.assertEqual(merged, [P("bearish", "2026-06-01", "2026-06-26"),
                                 P("bullish", "2026-07-02", None)])

    def test_keeps_everything_when_nothing_can_be_reconstructed(self):
        old = [P("bearish", "2026-05-26", "2026-06-15")]
        self.assertEqual(screener.merge_three_three_periods(old, [], None), old)

    def test_does_not_mutate_the_stored_periods(self):
        old = [P("bearish", "2026-06-01", None)]
        screener.merge_three_three_periods(old, [], "2026-06-26")
        self.assertIsNone(old[0]["end"])


# ── the log (what the Weekly Outlook actually reads) ───────────────────────────

class BuildLogTests(unittest.TestCase):

    def setUp(self):
        self.today = "2026-09-05"

    def _log(self, by_cat, rows, previous=None):
        return screener.build_three_three_log(by_cat, rows, previous=previous,
                                              today=self.today)

    def test_opens_a_period_for_a_market_that_is_three_three_today(self):
        """Cotton: 3/3 in today's screener but nothing reconstructable (no spread
        history reaching the season). Without an entry the chart draws no band."""
        mk = _bearish_market(_drop_window_dates())
        mk["calendar_spread_series"] = []
        log = self._log({"Softs": {"cotton": mk}}, [_row("cotton", -3)])
        self.assertEqual(log["cotton"]["active"], "bearish")
        self.assertEqual(log["cotton"]["periods"], [P("bearish", self.today, None)])

    def test_closes_an_open_period_the_screener_no_longer_confirms(self):
        """Lean hogs: the stored period is still OPEN, but the market reads 2/3 today.
        An open period paints a band that is still running -- it must be closed."""
        mk = _bearish_market(_drop_window_dates())
        mk["calendar_spread_series"] = []
        previous = {"lean_hogs": {"active": "bullish",
                                  "periods": [P("bullish", "2026-08-21", None)]}}
        log = self._log({"Meats": {"lean_hogs": mk}}, [_row("lean_hogs", 2)], previous)
        self.assertIsNone(log["lean_hogs"]["active"])
        self.assertEqual(log["lean_hogs"]["periods"],
                         [P("bullish", "2026-08-21", self.today)])

    def test_leaves_an_open_period_alone_while_the_screener_confirms_it(self):
        dates = _drop_window_dates()
        mk = _bearish_market(dates)
        log = self._log({"Softs": {"cotton": mk}}, [_row("cotton", -3)])
        self.assertEqual(log["cotton"]["periods"], [P("bearish", dates[0], None)])

    def test_a_direction_change_closes_the_old_period_and_opens_a_new_one(self):
        mk = _bearish_market(_drop_window_dates())
        mk["calendar_spread_series"] = []
        previous = {"gold": {"active": "bearish",
                             "periods": [P("bearish", "2026-08-01", None)]}}
        log = self._log({"Metals": {"gold": mk}}, [_row("gold", 3)], previous)
        self.assertEqual(log["gold"]["periods"],
                         [P("bearish", "2026-08-01", self.today),
                          P("bullish", self.today, None)])

    def test_history_outside_the_window_survives_a_rebuild(self):
        """The whole point of merging: orange juice keeps its June period even though
        the spread series now starts in July."""
        dates = _drop_window_dates(start_doy=215)
        mk = _bearish_market(dates)
        previous = {"orange_juice": {"active": None,
                                     "periods": [P("bearish", "2026-05-26", "2026-06-15")]}}
        log = self._log({"Softs": {"orange_juice": mk}}, [_row("orange_juice", -1)],
                        previous)
        self.assertEqual(log["orange_juice"]["periods"][0],
                         P("bearish", "2026-05-26", "2026-06-15"))

    def test_a_market_with_no_periods_at_all_is_omitted(self):
        mk = _bearish_market(_drop_window_dates())
        mk["calendar_spread_series"] = []
        log = self._log({"Softs": {"cocoa": mk}}, [_row("cocoa", 1)])
        self.assertNotIn("cocoa", log)

    def test_an_active_three_three_carries_the_seasonal_runway(self):
        dates = _drop_window_dates()
        mk = _bearish_market(dates)
        log = self._log({"Softs": {"cotton": mk}}, [_row("cotton", -3)])
        rw = log["cotton"].get("runway")
        self.assertIsNotNone(rw)
        self.assertEqual(rw["direction"], "bearish")
        self.assertGreater(rw["days"], 0)


# ── reading what is already on disk ───────────────────────────────────────────

class ReadStoredLogTests(unittest.TestCase):
    """The merge is only as good as its reading of the previous file, and that file is
    written on every refresh -- exactly the crash window _write_atomic exists for. A
    truncated log must degrade to "no history", never take the refresh down with it."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "three_three_log.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, text):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(text)

    def test_reads_the_stored_periods(self):
        self._write(json.dumps({"cotton": {"active": "bearish",
                                           "periods": [P("bearish", "2026-08-31", None)]}}))
        self.assertEqual(commodity_dashboard._read_three_three_log(self.path)["cotton"]["active"],
                         "bearish")

    def test_a_missing_file_reads_as_no_history(self):
        self.assertEqual(commodity_dashboard._read_three_three_log(self.path), {})

    def test_a_truncated_file_reads_as_no_history(self):
        self._write('{"cotton": {"active": "bea')
        self.assertEqual(commodity_dashboard._read_three_three_log(self.path), {})

    def test_a_file_that_is_not_an_object_reads_as_no_history(self):
        self._write('[1, 2, 3]')
        self.assertEqual(commodity_dashboard._read_three_three_log(self.path), {})


# ── the log must never be able to end a refresh ───────────────────────────────

class GeneratorGuardTests(unittest.TestCase):
    """generate_html builds the log BEFORE it writes config.js, so an exception on the way
    through would leave every category JSON replaced and config.js still naming the old
    run -- the half-updated state _write_atomic exists to prevent, reached from another
    road. The log is the youngest code in the generator and the Windows installer freezes
    an interpreter this suite never runs on, so the call is wrapped like the SQLite mirror
    beside it: a band that stops advancing is cosmetic and self-healing, a refresh that
    dies here is not."""

    def _generate_html_tree(self):
        return ast.parse(textwrap.dedent(inspect.getsource(commodity_dashboard.generate_html)))

    def test_the_log_is_built_and_written_inside_a_try(self):
        guarded = False
        for node in ast.walk(self._generate_html_tree()):
            if not isinstance(node, ast.Try):
                continue
            for inner in ast.walk(node):
                if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
                        and inner.func.id == "build_three_three_log"):
                    guarded = True
        self.assertTrue(
            guarded,
            "build_three_three_log() runs unguarded in generate_html -- an exception there "
            "ends the refresh before config.js is written")

    def test_the_guard_does_not_swallow_the_config_write(self):
        # A try wide enough to cover config.js would hide the one failure that must stop
        # the refresh. The guard has to be the log's alone.
        for node in ast.walk(self._generate_html_tree()):
            if not isinstance(node, ast.Try):
                continue
            names = {i.func.id for i in ast.walk(node)
                     if isinstance(i, ast.Call) and isinstance(i.func, ast.Name)}
            if "build_three_three_log" not in names:
                continue
            written = [c.args[0] for c in ast.walk(node)
                       if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                       and c.func.id == "_write_atomic"]
            self.assertTrue(all(isinstance(a, ast.Name) and a.id == "three_three_path"
                                for a in written),
                            "the 3/3 guard covers a payload write that is not its own")


if __name__ == "__main__":
    unittest.main()
