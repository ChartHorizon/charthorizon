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

### Opening an unsigned build (one time)

The installers are unsigned, so the OS shows a one-time warning:

- **macOS:** right-click the app → **Open** → **Open** (or System Settings →
  Privacy & Security → **Open Anyway**).
- **Windows:** SmartScreen → **More info** → **Run anyway**.
- **Linux:** `chmod +x ChartHorizon-*-x86_64.AppImage` then run it.

## How it works

ChartHorizon ships with **no data**. On first launch it fetches end-of-day data to a
per-user folder on your machine and renders it locally. It runs a small web server on
`localhost` and opens your browser — nothing leaves your computer.

## License

Code: **AGPL-3.0** (`LICENSE`). The **ChartHorizon** name and logo are reserved —
see `TRADEMARK.md`. Data sources and legal: see `DISCLAIMER.md`.
