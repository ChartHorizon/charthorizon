<p align="center">
  <img src="brand/charthorizon_logo.png" alt="ChartHorizon" width="420">
</p>

<p align="center">
  <b>Local-first commodity futures dashboard</b> — COT (commercials/hedgers), seasonals, screener &amp; FX strength.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg"></a>
</p>

---

## What is ChartHorizon?

ChartHorizon is a **local-first** dashboard for commodity futures: it pulls market data
from free APIs, stores it locally, and renders it in your browser — no cloud, no login, no
tracking. It includes futures charts, COT positioning (commercials/hedgers), seasonality,
a signal screener, and an FX strength heatmap.

> ⚠️ For informational purposes only — **not financial advice.**

## Installation

Download for your OS from the [latest release](https://github.com/ChartHorizon/charthorizon/releases/latest):
**macOS** (`.dmg`), **Windows** (`.exe`), **Linux** (`.AppImage`). No Python needed — it's bundled.

> **First launch (unsigned build):** the apps are not code-signed yet, so your OS shows a one-time warning.
> - **macOS:** right-click the app → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
> - **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
> - **Linux:** `chmod +x ChartHorizon-x86_64.AppImage` then run it.
>
> The first launch fetches market data (1–2 minutes) before the dashboard appears.
>
> *Auto-update (daily refresh) currently applies to the source install only; the bundled app refreshes on launch. Bundled-app auto-update is out of scope for v1.*

## Updating the app

New versions are released on the [releases page](https://github.com/ChartHorizon/charthorizon/releases/latest). There's no in-app updater yet, so updating to a newer version is a quick manual reinstall — **your data is kept**: the EOD archive and settings live in a separate per-user folder, not inside the app, so a reinstall never touches them.

1. **Quit ChartHorizon** if it's running.
2. **Download** the installer for your OS from the latest release.
3. **Install over the old version:**
   - **macOS:** open the `.dmg`, drag `ChartHorizon` into **Applications** and choose **Replace**.
   - **Windows:** run the new `.exe` — it installs over the existing per-user install.
   - **Linux:** replace the old `.AppImage` with the new file (`chmod +x` it again).
4. **Launch it** (the same one-time unsigned-app warning as above may reappear for a new version).

Your data folder is:

| OS | Location |
|----|----------|
| macOS | `~/Library/Application Support/ChartHorizon/` |
| Windows | `%LOCALAPPDATA%\ChartHorizon\` |
| Linux | `~/.local/share/charthorizon/` |

On the first launch after updating, ChartHorizon refreshes to the latest EOD data in the background — no re-fetch from scratch.

## Getting started

You don't need any coding experience. For a normal launch you just double-click one file.

### Mac

Double-click:

`START_CHARTHORIZON.command`

If macOS blocks it the first time:

1. Right-click `START_CHARTHORIZON.command`
2. Choose `Open`
3. Confirm `Open` again

### Windows

Double-click:

`START_CHARTHORIZON_WINDOWS.bat`

## Updating data

When you want to load fresh market data:

Mac:

`UPDATE_DATA.command`

Windows:

`UPDATE_DATA_WINDOWS.bat`

The update first checks whether the expected yfinance EOD data is already stored
locally. ChartHorizon expects new yfinance daily data from roughly `17:30 ET`
(because of the delay after the US futures close). If your local data is already
current, no new API download is started.

CFTC Open Interest/COT is only re-fetched in the matching weekly window after the
official COT release.

## Automatic updates (Mac only)

ChartHorizon can update the EOD data automatically once a day in the background.

Enable:

`AUTO_UPDATE_ENABLE.command`

After that the update runs every day at:

`23:30` (this Mac's local time)

This targets normal yfinance EOD data and lines up roughly with `17:30 ET`. Per EOD
target day ChartHorizon downloads at most once; after that it uses the locally
stored JSON/SQLite data. CFTC COT/Open Interest data is still only refreshed once a
week internally: after the CFTC release at 15:30 ET, with a small safety window. If
a US holiday delays the CFTC release, ChartHorizon waits for the next known release
date.

The enable script automatically remembers where the ChartHorizon folder is. If you
move the folder later, just double-click `AUTO_UPDATE_ENABLE.command` again.

The automatic job only generates new data and does not open a browser. The page then
uses the updated data the next time it reloads. If the Mac is switched off at 23:30,
macOS catches the run up the next time it is switched on.

You can find the logs here:

`logs/auto_update.log`

To disable again:

`AUTO_UPDATE_DISABLE.command`

Note for Windows: there is no automatic update here yet. On Windows, reload the data
manually via `UPDATE_DATA_WINDOWS.bat` when needed.

## In the dashboard

The main chart always starts as a continuous contract.

When you click a contract row in the term structure, the main chart switches to that
exact single contract. A button with the contract symbol — for example `CLN26` —
then appears next to `Continuous` at the top of the chart.

Use `Continuous` to switch back to the continuous contract.

## What happens on launch?

The normal launch window starts quickly with the existing dashboard files. If no
files exist yet, they are generated automatically.

The update file handles everything automatically:

1. It checks whether the required Python packages are present.
2. It automatically installs missing packages such as `yfinance`, `pypdf` and
   `curl_cffi`.
3. It loads current futures, COT and Open Interest data.
4. It regenerates the dashboard.
5. It starts a local web server.
6. It opens the page in your browser.

If the expected yfinance EOD data is already present locally, steps 3 and 4 are
skipped to keep the launch fast.

The first launch can take a few minutes because a lot of market data is loaded.

## Quitting

Leave the terminal/console window open for as long as you want to use the dashboard.

To quit, press `Ctrl + C` in the window.

## Folder structure

```text
Chart Horizon/
  START_CHARTHORIZON.command       <- Mac: double-click this
  START_CHARTHORIZON_WINDOWS.bat   <- Windows: double-click this
  UPDATE_DATA.command              <- Mac: reload data
  UPDATE_DATA_WINDOWS.bat
  AUTO_UPDATE_ENABLE.command       <- Mac: turn on the daily update
  AUTO_UPDATE_DISABLE.command      <- Mac: turn off the daily update
  AUTO_UPDATE_CHARTHORIZON.command <- Mac: called by the auto-update
  com.charthorizon.daily-update.plist <- template for the macOS LaunchAgent
  README.md                        <- this guide
  LICENSE                          <- GNU AGPL-3.0
  logs/                            <- automatic update logs
  app/                             <- technical files
    start.py
    commodity_dashboard.py
    index.html
    web/
    ff_data/
```

You normally don't need to touch the `app` folder.

## Important

Please don't just open `index.html` by double-clicking it. The page needs the local
web server because the data is loaded from `ff_data/`. So always start it via the
launch file.

## Requirement

Python 3 must be installed.

On Mac, Python is often already present. If not, install Python from:

https://www.python.org/downloads/

Then double-click `START_CHARTHORIZON.command` again.

## Data sources & legal

- **Price data, charts and seasonality** come via [yfinance](https://github.com/ranaroussi/yfinance) (Yahoo Finance) and are intended for **personal use**. ChartHorizon is *local-first*: every installation loads the data itself onto its own machine — **no** price data is redistributed.
- **COT and Open Interest** come from the **CFTC** (US agency) and are public domain.
- The Forex view embeds the **TradingView** widget for viewing.
- All content is **for informational purposes only** and is **not financial advice**.

### License

ChartHorizon is licensed under the **GNU AGPL-3.0** (see [`LICENSE`](LICENSE)): you may
use, study, adapt and redistribute it; anyone who runs it as a network service must
disclose their changes.
