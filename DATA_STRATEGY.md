# ChartHorizon Data Strategy

## Goal

ChartHorizon should be local-first while the project has no fixed data budget.
External APIs are treated as update sources, not as the only source of truth.
If a fresh API response is shorter, older, or more gappy than the local EoD
history, the local history wins.

## Current Source Stack

1. Local EoD archive in `app/ff_data/charthorizon.db` (SQLite, durable store)
2. Local EoD files in `app/ff_data/` (JSON, generated for the website)
3. yfinance for OHLCV prices, contracts, volume, and seasonal base history
4. CFTC Public Reporting API for weekly Open Interest and COT history

Open Interest is CFTC-only (weekly, Tuesday-dated, uniform across all markets);
yfinance is not used for OI. The CME Daily Bulletin path has been removed.
CFTC is checked only after the official COT release window (normally Friday
15:30 ET, with a small buffer and known holiday delays). Daily EoD refreshes
use a yfinance freshness gate: the expected yfinance target date advances after
17:30 ET, and `start.py --refresh` skips API downloads when local JSON already
covers that target date. CFTC data is reused until a new weekly report should
actually be available.

The generated `app/ff_data/data_quality.json` records the health of every
market after each refresh.

## Protection Rules Added

- Fresh price history is rejected if it is missing, materially shorter, older
  than the local store, or has large unexplained gaps.
- Fresh seasonal history is rejected if it loses a material number of years.
- Legacy estimated yfinance volume bridges are purged. Suspect low-volume runs
  are flagged and can be omitted from the chart, but they are not filled with
  synthetic values.
- Seasonal coverage is tracked per market: 5Y, 15Y, and 40Y availability are
  explicit quality flags instead of assumptions.
- `start.py --refresh` is EoD-gated for speed. Use `--force-refresh` when a full
  yfinance rebuild is intentionally required.

## Nasdaq Data Link

Nasdaq Data Link can be added later as an optional provider, but it should not
be required for the first public version. The official docs distinguish free and
premium datasets, and many professional datasets require a subscription or sales
access. That makes it useful as a fallback/upgrade path, not as the first layer.

Relevant docs:

- https://docs.data.nasdaq.com/docs/getting-started
- https://docs.data.nasdaq.com/docs/api-and-analysis-tools-for-tables-data
- https://docs.data.nasdaq.com/docs/error-codes

## Implemented: SQLite EoD store

The project now uses a small SQLite EoD store (`app/eod_store.py`,
`app/ff_data/charthorizon.db`) with five tables:

- `ohlcv_bars`    — daily OHLCV bars (yfinance)
- `total_volume`  — daily total volume
- `open_interest` — open interest (CFTC weekly only)
- `cot`           — weekly COT (CFTC)
- `market_meta`   — per-market descriptive fields + last refresh / quality

The JSON files are still generated for the website, but the database is the
durable archive. Writes use a local-first merge: the archive only ever grows or
gets its recent dates corrected. If a fresh fetch is shorter, older, or gappier
than the stored series, the archive wins (see `merge_is_safe` / `merge_series`).
This makes refreshes safe to re-run and lets future providers fill only missing
dates.
