# dashboard/packaging/charthorizon.spec
# -*- mode: python ; coding: utf-8 -*-
"""Onedir build, wrapped per-OS into .dmg / Inno-Setup .exe / AppImage.
Run from the dashboard/ root:  pyinstaller packaging/charthorizon.spec --noconfirm
"""
import sys
import os
from PyInstaller.utils.hooks import collect_all

# SPECPATH is the directory containing this spec file (dashboard/packaging/).
# ROOT is dashboard/ — all source paths are relative to it.
ROOT = os.path.join(SPECPATH, "..")

datas, binaries, hiddenimports = [], [], []
for pkg in ("yfinance", "curl_cffi", "pypdf", "dateutil"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Generator modules are imported lazily inside start.py (--run-generator),
# so static analysis needs them spelled out.
hiddenimports += [
    "commodity_dashboard", "market_config", "series_utils", "calendar_utils",
    "contracts", "local_first_merge", "fetch_yfinance", "fetch_cftc",
    "screener", "eod_store", "fx_rates", "live_cache", "app_version",
    "yahoo_gateway", "dead_symbols", "net_tls",
]

# Static frontend, served from the read-only bundle (APP_DIR == sys._MEIPASS).
datas += [
    (os.path.join(ROOT, "app", "web"), "web"),
    (os.path.join(ROOT, "app", "index.html"), "."),
    (os.path.join(ROOT, "app", "loading.html"), "."),
]

if sys.platform == "darwin":
    icon = os.path.join(ROOT, "packaging", "icons", "icon.icns")
    # Cocoa reopen-handler in start.py drives serving so a Dock click reopens the
    # dashboard tab; the import is dynamic, so spell the frameworks out for PyInstaller.
    hiddenimports += ["AppKit", "Foundation", "objc"]
elif sys.platform.startswith("win"):
    icon = os.path.join(ROOT, "packaging", "icons", "icon.ico")
else:
    icon = None

a = Analysis(
    [os.path.join(ROOT, "app", "start.py")],
    pathex=[os.path.join(ROOT, "app")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="ChartHorizon",
    console=True,
    icon=icon,
)
coll = COLLECT(exe, a.binaries, a.datas, name="ChartHorizon")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="ChartHorizon.app",
        icon=os.path.join(ROOT, "packaging", "icons", "icon.icns"),
        bundle_identifier="com.charthorizon.dashboard",
        info_plist={
            "NSHighResolutionCapable": True,
            # console=True makes PyInstaller mark the bundle LSBackgroundOnly, turning
            # it into a window-less resident agent that LaunchServices won't re-open on
            # a second click. Force it off: start.py sets a Regular activation policy at
            # runtime and handles the reopen event so every click reopens the tab.
            "LSBackgroundOnly": False,
        },
    )
