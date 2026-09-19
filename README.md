# ChartHorizon

**A local-first commodity-futures dashboard.** Commercial (COT) positioning,
seasonality, a conviction screener, and an FX-strength heatmap — rendered in your
browser, running entirely on your machine. No account. No cloud. Bring your own data.

[Website](https://chart-horizon.com/dashboard/) ·
[Weekly notes](https://chart-horizon.com/) ·
[FX strength map](https://chart-horizon.com/fx/)

## Risk notice

**Educational and informational only.** ChartHorizon is not investment advice and makes
no recommendation to buy or sell anything. Futures, forex and other leveraged derivatives
carry a **substantial risk of loss** — you can lose more than your deposit. Seasonal, COT
and structure signals are statistical: past results do not guarantee future ones. The data
comes from free third-party sources, is end-of-day, and is provided **as is** without
warranty. **The authors accept no liability for any loss or damage arising from use of this
tool; you use it entirely at your own risk.**

Full text: [`RISK-NOTICE.txt`](RISK-NOTICE.txt) — shown by the Windows installer, and once
on the dashboard's first launch.

## Download

Unsigned installers for the latest release:

- **macOS** — `ChartHorizon-<version>-macOS.dmg`
- **Windows** — `ChartHorizon-<version>-Windows-Setup.exe`
- **Linux** — `ChartHorizon-<version>-x86_64.AppImage`

Download them from **[chart-horizon.com/dashboard](https://chart-horizon.com/dashboard/)** —
the installers are hosted directly, not as GitHub Releases.

### Install & first launch

The builds are **unsigned**, so the first launch takes one manual step:

- **macOS:** open the `.dmg`, then drag **ChartHorizon** onto the **Applications**
  folder shown beside it. Launch it from Applications — on first run, right-click the
  app → **Open** → **Open**. If macOS still says the app is *"damaged"* or can't be
  opened, clear the download quarantine once in Terminal, then open it normally:
  ```
  xattr -cr /Applications/ChartHorizon.app
  ```
- **Windows:** run the `.exe` installer; if SmartScreen appears, click **More info** →
  **Run anyway**. It installs per-user (no admin) and adds Start-menu/desktop shortcuts.
- **Linux:** `chmod +x ChartHorizon-*-x86_64.AppImage`, then run it. If it reports
  *"AppImages require FUSE"* (common on newer distros), either install FUSE 2
  (`sudo apt install libfuse2` on Debian/Ubuntu) or run it without FUSE:
  ```
  ./ChartHorizon-*-x86_64.AppImage --appimage-extract-and-run
  ```

## How it works

ChartHorizon ships with **no data**. On first launch it fetches end-of-day data to a
per-user folder on your machine and renders it locally. It runs a small web server on
`localhost` and opens your browser — nothing leaves your computer.

## The same board, in writing

The desk that builds this reads the board every evening and writes up the markets worth
remarking on — same data, same signals, nothing to buy and no account to make.

- **[The Weekly Tape](https://chart-horizon.com/)** — weekly futures positioning notes
- **[The Hedgers' Ledger](https://chart-horizon.com/archive/)** — where the commercial
  hedgers sit against their three-year range, from each week's CFTC Commitments of
  Traders report
- **[FX Strength Map](https://chart-horizon.com/fx/)** — the daily currency-strength
  board this dashboard computes, published as it is computed

## License

Code: **AGPL-3.0** (`LICENSE`). The **ChartHorizon** name and logo are reserved —
see `TRADEMARK.md`. Data sources: see `DISCLAIMER.md`. Risk and liability: see `RISK-NOTICE.txt`.
