"""
ChartHorizon EoD store (SQLite).

A small, durable end-of-day archive that sits *behind* the JSON files the
dashboard reads. The generator writes every refresh into SQLite and can read
back the latest stored date per series, so future runs only need to fetch the
missing days (incremental updates). The JSON files are still generated for the
website; this database is the long-term source of truth.

Design (per DATA_STRATEGY.md):
  - ohlcv_bars        : daily OHLCV per market (yfinance)
  - total_volume      : daily total volume per market
  - open_interest     : open interest per market (CFTC weekly only)
  - cot               : weekly COT per market (CFTC)
  - calendar_spread   : daily front-minus-next calendar spread per market
  - market_meta       : per-market descriptive fields + last refresh / quality

Everything is keyed by a stable ``market_key`` (e.g. "wti_crude") plus ``date``.
Writes are idempotent upserts (last write wins for a given key+date), so
re-running a day overwrites it cleanly instead of duplicating.
"""

import os
import sqlite3
from contextlib import contextmanager

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "ff_data", "charthorizon.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS ohlcv_bars (
    market_key TEXT NOT NULL,
    date       TEXT NOT NULL,
    open       REAL,
    high       REAL,
    low        REAL,
    close      REAL,
    volume     REAL,
    source     TEXT,
    PRIMARY KEY (market_key, date)
);

CREATE TABLE IF NOT EXISTS total_volume (
    market_key     TEXT NOT NULL,
    date           TEXT NOT NULL,
    volume         REAL,
    source         TEXT,
    method         TEXT,
    contract_count INTEGER,
    PRIMARY KEY (market_key, date)
);

CREATE TABLE IF NOT EXISTS open_interest (
    market_key TEXT NOT NULL,
    date       TEXT NOT NULL,
    oi         REAL,
    source     TEXT,
    method     TEXT,
    PRIMARY KEY (market_key, date)
);

CREATE TABLE IF NOT EXISTS cot (
    market_key TEXT NOT NULL,
    date       TEXT NOT NULL,
    oi         REAL,
    cot_net    REAL,
    cot_long   REAL,
    cot_short  REAL,
    cot_label  TEXT,
    cot_report TEXT,
    market     TEXT,
    comm_net   REAL,
    comm_long  REAL,
    comm_short REAL,
    PRIMARY KEY (market_key, date)
);

CREATE TABLE IF NOT EXISTS calendar_spread (
    market_key     TEXT NOT NULL,
    date           TEXT NOT NULL,
    spread         REAL,
    front_contract TEXT,
    next_contract  TEXT,
    front_close    REAL,
    next_close     REAL,
    source         TEXT,
    PRIMARY KEY (market_key, date)
);

CREATE TABLE IF NOT EXISTS market_meta (
    market_key    TEXT PRIMARY KEY,
    display_name  TEXT,
    category      TEXT,
    currency      TEXT,
    unit          TEXT,
    tick_decimals INTEGER,
    cftc_code     TEXT,
    last_refresh  TEXT,
    quality_json  TEXT
);
"""


@contextmanager
def connect(db_path=DEFAULT_DB_PATH):
    """Context manager yielding a connection with sane defaults and the schema applied."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path=DEFAULT_DB_PATH):
    """Create the database file and tables if they don't exist yet."""
    with connect(db_path):
        pass
    return db_path


# ---------------------------------------------------------------------------
# Writes (idempotent upserts)
# ---------------------------------------------------------------------------

def _upsert_many(conn, table, columns, rows):
    """Generic INSERT .. ON CONFLICT upsert for a list of dict rows."""
    if not rows:
        return 0
    cols = ",".join(columns)
    placeholders = ",".join("?" for _ in columns)
    # On conflict of the primary key, overwrite the non-key columns.
    key_cols = {"ohlcv_bars": ["market_key", "date"],
                "total_volume": ["market_key", "date"],
                "open_interest": ["market_key", "date"],
                "cot": ["market_key", "date"],
                "calendar_spread": ["market_key", "date"],
                "market_meta": ["market_key"]}[table]
    update_cols = [c for c in columns if c not in key_cols]
    set_clause = ",".join(f"{c}=excluded.{c}" for c in update_cols)
    conflict = ",".join(key_cols)
    sql = (f"INSERT INTO {table} ({cols}) VALUES ({placeholders}) "
           f"ON CONFLICT({conflict}) DO UPDATE SET {set_clause}")
    data = [[row.get(c) for c in columns] for row in rows]
    conn.executemany(sql, data)
    return len(data)


def write_ohlcv(conn, market_key, bars):
    cols = ["market_key", "date", "open", "high", "low", "close", "volume", "source"]
    rows = [{"market_key": market_key, **{k: b.get(k) for k in
             ("date", "open", "high", "low", "close", "volume", "source")}} for b in bars or []]
    return _upsert_many(conn, "ohlcv_bars", cols, rows)


def write_total_volume(conn, market_key, series):
    cols = ["market_key", "date", "volume", "source", "method", "contract_count"]
    rows = [{"market_key": market_key, **{k: r.get(k) for k in
             ("date", "volume", "source", "method", "contract_count")}} for r in series or []]
    return _upsert_many(conn, "total_volume", cols, rows)


def write_open_interest(conn, market_key, series):
    cols = ["market_key", "date", "oi", "source", "method"]
    rows = [{"market_key": market_key, **{k: r.get(k) for k in
             ("date", "oi", "source", "method")}} for r in series or []]
    return _upsert_many(conn, "open_interest", cols, rows)


def purge_non_cftc_open_interest(conn):
    """Remove legacy yfinance/CME OI rows from earlier local builds."""
    conn.execute("DELETE FROM open_interest WHERE source IS NULL OR source <> 'cftc_cot'")


def purge_calendar_spread(conn):
    """Clear all calendar-spread rows. The spread is a current snapshot (only the
    currently-traded contracts), rewritten fresh each refresh — not accumulated."""
    conn.execute("DELETE FROM calendar_spread")


def purge_estimated_volume_gap_fill(conn):
    """Remove old median-filled volume bridges from earlier local builds."""
    conn.execute(
        "DELETE FROM total_volume "
        "WHERE source = 'yfinance_volume_gap_fill' "
        "OR method = 'estimated_bridge_for_missing_yfinance_contract_volume'"
    )


def purge_suspect_volume_markers(conn):
    """Remove old suspect-volume markers before recalculating them."""
    conn.execute(
        "DELETE FROM total_volume "
        "WHERE source = 'yfinance_volume_suspect_low' "
        "OR method = 'suspect_missing_active_contract_volume'"
    )


def write_cot(conn, market_key, series):
    cols = ["market_key", "date", "oi", "cot_net", "cot_long", "cot_short",
            "cot_label", "cot_report", "market", "comm_net", "comm_long", "comm_short"]
    rows = [{"market_key": market_key, **{k: r.get(k) for k in
             ("date", "oi", "cot_net", "cot_long", "cot_short", "cot_label",
              "cot_report", "market", "comm_net", "comm_long", "comm_short")}} for r in series or []]
    return _upsert_many(conn, "cot", cols, rows)


def write_calendar_spread(conn, market_key, series):
    cols = ["market_key", "date", "spread", "front_contract", "next_contract",
            "front_close", "next_close", "source"]
    rows = [{"market_key": market_key, **{k: r.get(k) for k in
             ("date", "spread", "front_contract", "next_contract",
              "front_close", "next_close", "source")}} for r in series or []]
    return _upsert_many(conn, "calendar_spread", cols, rows)


def write_market_meta(conn, market_key, meta):
    cols = ["market_key", "display_name", "category", "currency", "unit",
            "tick_decimals", "cftc_code", "last_refresh", "quality_json"]
    row = {"market_key": market_key, **{k: meta.get(k) for k in cols if k != "market_key"}}
    return _upsert_many(conn, "market_meta", cols, [row])


# ---------------------------------------------------------------------------
# Reads (for incremental updates + JSON generation)
# ---------------------------------------------------------------------------

def latest_date(conn, table, market_key):
    """Most recent stored date for a market in a table, or None."""
    row = conn.execute(
        f"SELECT MAX(date) AS d FROM {table} WHERE market_key=?", (market_key,)
    ).fetchone()
    return row["d"] if row and row["d"] else None


def read_ohlcv(conn, market_key, since=None):
    q = "SELECT date,open,high,low,close,volume,source FROM ohlcv_bars WHERE market_key=?"
    args = [market_key]
    if since:
        q += " AND date >= ?"; args.append(since)
    q += " ORDER BY date"
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def read_total_volume(conn, market_key, since=None):
    q = "SELECT date,volume,source,method,contract_count FROM total_volume WHERE market_key=?"
    args = [market_key]
    if since:
        q += " AND date >= ?"; args.append(since)
    q += " ORDER BY date"
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def read_open_interest(conn, market_key, since=None):
    q = "SELECT date,oi,source,method FROM open_interest WHERE market_key=?"
    args = [market_key]
    if since:
        q += " AND date >= ?"; args.append(since)
    q += " ORDER BY date"
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def read_cot(conn, market_key, since=None):
    q = ("SELECT date,oi,cot_net,cot_long,cot_short,cot_label,cot_report,"
         "market,comm_net,comm_long,comm_short FROM cot WHERE market_key=?")
    args = [market_key]
    if since:
        q += " AND date >= ?"; args.append(since)
    q += " ORDER BY date"
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def read_calendar_spread(conn, market_key, since=None):
    q = ("SELECT date,spread,front_contract,next_contract,front_close,next_close,source "
         "FROM calendar_spread WHERE market_key=?")
    args = [market_key]
    if since:
        q += " AND date >= ?"; args.append(since)
    q += " ORDER BY date"
    return [dict(r) for r in conn.execute(q, args).fetchall()]


def read_market_meta(conn, market_key):
    row = conn.execute("SELECT * FROM market_meta WHERE market_key=?", (market_key,)).fetchone()
    return dict(row) if row else None


def all_market_keys(conn):
    return [r["market_key"] for r in
            conn.execute("SELECT market_key FROM market_meta ORDER BY market_key").fetchall()]


def store_stats(conn):
    """Quick row counts per table, for logging/diagnostics."""
    out = {}
    for t in ("ohlcv_bars", "total_volume", "open_interest", "cot", "calendar_spread", "market_meta"):
        out[t] = conn.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"]
    return out


# ---------------------------------------------------------------------------
# Local-first merge (incremental updates)
# ---------------------------------------------------------------------------

def merge_is_safe(stored_rows, fresh_rows, min_keep_ratio=0.8):
    """Decide whether a fresh fetch may replace/extend the stored series.

    Implements the DATA_STRATEGY rule: the local archive wins if the fresh
    response is materially shorter, older, or covers less than the stored one.
    Returns True when the fresh data is safe to merge in (it's at least as
    complete and as recent as what we already have).

    - If there is nothing stored yet, any fresh data is accepted.
    - If fresh is empty, reject (keep local).
    - If fresh ends before the stored series ends, reject (stale).
    - If fresh has far fewer rows than stored (< min_keep_ratio), reject.
    """
    if not stored_rows:
        return bool(fresh_rows)
    if not fresh_rows:
        return False
    stored_last = max(r["date"] for r in stored_rows)
    fresh_last = max(r["date"] for r in fresh_rows)
    if fresh_last < stored_last:
        return False  # fresh is older than what we have
    if len(fresh_rows) < len(stored_rows) * min_keep_ratio:
        return False  # fresh is materially shorter
    return True


def merge_series(stored_rows, fresh_rows):
    """Union of stored and fresh rows by date; fresh wins on overlapping dates.

    Used so the archive only ever grows or gets its recent dates corrected,
    never loses history. Always returns a date-sorted list.
    """
    by_date = {r["date"]: r for r in stored_rows or []}
    for r in fresh_rows or []:
        by_date[r["date"]] = r  # fresh overwrites same-date stored row
    return [by_date[d] for d in sorted(by_date)]
