# ChartHorizon

**A local-first commodity-futures dashboard.** Commercial (COT) positioning,
seasonality, a conviction screener, and an FX-strength heatmap — rendered in your
browser, running entirely on your machine. No account. No cloud. Bring your own data.

## Download

Unsigned installers for the latest release:

- **macOS** — `ChartHorizon-<version>-macOS.dmg`
- **Windows** — `ChartHorizon-<version>-Windows-Setup.exe`
- **Linux** — `ChartHorizon-<version>-x86_64.AppImage`

Get them from the [Releases page](../../releases/latest).

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

## License

Code: **AGPL-3.0** (`LICENSE`). The **ChartHorizon** name and logo are reserved —
see `TRADEMARK.md`. Data sources and legal: see `DISCLAIMER.md`.
