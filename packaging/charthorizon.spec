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

# ---- Bake in which recipe built this -------------------------------------------------
# The Windows installer is built in a VM from its own copy of the tree, and a stale
# packaging/ there still builds — quietly, from the previous recipe (that is how the
# ctypes.wintypes hidden import below reached the Mac build and never the Windows one).
# The digest is taken from the packaging tree THIS spec is sitting in, so a stale copy
# bakes the previous value; start.py reports it from /api/version and the Mac prints what
# it ought to be (tools/packaging-fingerprint.py). See app/packaging_fingerprint.py for
# why the definition lives in app/ — the only tree that is always synced.
sys.path.insert(0, os.path.join(ROOT, "app"))
from packaging_fingerprint import FINGERPRINT_FILE, packaging_fingerprint

_fp_dir = os.path.join(ROOT, "build")
os.makedirs(_fp_dir, exist_ok=True)                 # gitignored; --clean runs before this
_fp_path = os.path.join(_fp_dir, FINGERPRINT_FILE)
with open(_fp_path, "w", encoding="utf-8") as _fh:
    _fh.write(packaging_fingerprint(os.path.join(ROOT, "packaging")) + "\n")
datas += [(_fp_path, ".")]

if sys.platform == "darwin":
    icon = os.path.join(ROOT, "packaging", "icons", "icon.icns")
    # Cocoa reopen-handler in start.py drives serving so a Dock click reopens the
    # dashboard tab; the import is dynamic, so spell the frameworks out for PyInstaller.
    hiddenimports += ["AppKit", "Foundation", "objc"]
elif sys.platform.startswith("win"):
    icon = os.path.join(ROOT, "packaging", "icons", "icon.ico")
    # start.py's process-liveness probe (_pid_alive_windows) reaches kernel32 through
    # ctypes.wintypes, imported inside the function. If it were missing from the bundle
    # the probe would fall back to "alive" and a stale refresh.lock would wedge a refresh
    # for LOCK_MAX_AGE again — the exact bug it exists to fix, silently.
    hiddenimports += ["ctypes", "ctypes.wintypes"]
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
