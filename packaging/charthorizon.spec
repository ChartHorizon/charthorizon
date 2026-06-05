# packaging/charthorizon.spec — build: pyinstaller packaging/charthorizon.spec --noconfirm
# (run from the repo root). Produces dist/ChartHorizon (onedir) and, on macOS, dist/ChartHorizon.app
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

# SPECPATH is the directory of this spec file (packaging/); the repo root is one level up.
REPO = os.path.dirname(SPECPATH)
APP  = os.path.join(REPO, 'app')

datas = [
    (os.path.join(APP, 'index.html'),   '.'),
    (os.path.join(APP, 'loading.html'), '.'),
    (os.path.join(APP, 'web'),          'web'),
]
binaries, hiddenimports = [], []

# Native-dep heavy packages — collect data files, binaries AND submodules.
for pkg in ('curl_cffi', 'yfinance'):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h

hiddenimports += collect_submodules('dateutil')
hiddenimports += ['pypdf']
# The generator + its module split are imported lazily via --run-generator, so name them
# explicitly (PyInstaller can't see the in-function import string statically).
hiddenimports += [
    'commodity_dashboard', 'market_config', 'series_utils', 'calendar_utils', 'contracts',
    'local_first_merge', 'fetch_yfinance', 'fetch_cftc', 'screener', 'eod_store',
]

a = Analysis([os.path.join(APP, 'start.py')], pathex=[APP], binaries=binaries, datas=datas,
             hiddenimports=hiddenimports, noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ChartHorizon',
          console=False, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, name='ChartHorizon')
app = BUNDLE(coll, name='ChartHorizon.app', bundle_identifier='com.charthorizon.app',
             info_plist={'CFBundleName': 'ChartHorizon', 'CFBundleShortVersionString': '1.0.0', 'LSBackgroundOnly': False})
