#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  CHARTHORIZON – LOCAL START
═══════════════════════════════════════════════════════════════════════
  This script does everything automatically:
    1. Checks & installs the required packages (yfinance, python-dateutil, pypdf, curl_cffi)
    2. Uses the existing dashboard files or regenerates them
    3. Starts a local web server
    4. Opens the dashboard in the browser

  Start:
    python3 start.py            (fast start; pulls the freshest data in the background)
    python3 start.py --refresh  (always fetch the most recent yfinance data)
    python3 start.py --refresh --no-serve  (data update only, no web server)

  Quit:  Ctrl + C
═══════════════════════════════════════════════════════════════════════
"""

import os
import sys
import argparse
import subprocess
import threading
import webbrowser

import app_version
import live_cache
import yahoo_gateway

try:
    from curl_cffi import requests as _curl_requests
except ImportError:
    _curl_requests = None


def _build_live_session():
    """One shared browser-impersonating session for the live-quote path. Cookie/crumb
    reuse + a Chrome fingerprint cut Yahoo 429s at the source. Returns None when
    curl_cffi is unavailable or the API rejects our args (the live path then falls back
    to a bare yfinance Ticker — still protected by the cache + rate cap)."""
    if _curl_requests is None:
        return None
    try:
        return _curl_requests.Session(impersonate="chrome",
                                      timeout=live_cache.LIVE_FETCH_TIMEOUT_SECONDS)
    except Exception:
        try:
            return _curl_requests.Session(impersonate="chrome")
        except Exception:
            return None


# The shared session now lives on the gateway (one owner for every Yahoo caller in this
# process); _LIVE_SESSION is kept as a thin alias so the existing live-quote call sites
# read unchanged.


import http.server
import socketserver
import json
import tempfile
import re
import urllib.parse
from datetime import datetime, time, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None

PORT = 8000
HTML_FILE = "index.html"
GENERATOR = "commodity_dashboard.py"
REQUIRED = ["yfinance", "python-dateutil", "pypdf", "curl_cffi"]
YFINANCE_EOD_READY_ET = time(17, 30)
PROGRESS_FILE = os.path.join("ff_data", "refresh_progress.json")
LOCK_FILE = os.path.join("ff_data", "refresh.lock")
LOCK_MAX_AGE = 1800  # seconds — a refresh never takes this long; older lock = stale

# The SERVER gateway profile. The generator subprocess installs its own (see
# commodity_dashboard.py) and must NOT be given lock_path — it is the process that holds
# the lock. Here lock_path is exactly right: while a refresh runs, the server drops to
# interactive-only so the refresh gets Yahoo largely to itself.
yahoo_gateway.configure(
    capacity=live_cache.LIVE_RATE_CAPACITY,
    refill_per_sec=live_cache.LIVE_RATE_REFILL_PER_SEC,
    session_factory=_build_live_session,
    lock_path=LOCK_FILE,
)
_LIVE_SESSION = yahoo_gateway.gateway().session()

FROZEN = getattr(sys, "frozen", False)

def app_dir():
    """Folder holding the static frontend (index.html, web/) + bundled Python modules.
    Frozen (PyInstaller): the unpacked bundle. Dev: this script's directory."""
    if FROZEN:
        return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))

def data_root():
    """Writable root that holds ff_data/. Frozen: per-user OS data dir. Dev: app_dir()."""
    if not FROZEN:
        return app_dir()
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support", "ChartHorizon")
    elif sys.platform.startswith("win"):
        base = os.path.join(os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local")), "ChartHorizon")
    else:
        base = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(home, ".local", "share")), "charthorizon")
    os.makedirs(base, exist_ok=True)
    return base

APP_DIR = app_dir()
DATA_ROOT = data_root()


def info(msg):  print(f"  {msg}")
def step(msg):  print(f"\n▶ {msg}")
def ok(msg):    print(f"  ✓ {msg}")
def warn(msg):  print(f"  ⚠ {msg}")


def _read_progress():
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_progress(**fields):
    """Best-effort atomic merge into ff_data/refresh_progress.json."""
    try:
        os.makedirs("ff_data", exist_ok=True)
        data = _read_progress() or {}
        data.update(fields)
        fd, tmp = tempfile.mkstemp(dir="ff_data", prefix=".progress_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, PROGRESS_FILE)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        pass


# Windows process-liveness constants (winnt.h / winerror.h).
_WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000   # "does this pid exist" and nothing more
_WIN_ERROR_ACCESS_DENIED = 5                      # it exists, it is just not ours to open
_WIN_ERROR_INVALID_PARAMETER = 87                 # no process owns that pid


def _windows_kernel32():
    """kernel32 behind a three-call surface (OpenProcess / CloseHandle / last_error),
    so the probe above can be exercised on a machine that is not Windows.

    The signatures are declared rather than left to ctypes' defaults: a HANDLE is
    pointer-sized and ctypes would otherwise marshal the return as a C int, truncating
    it on 64-bit — which would leak the handle on every probe."""
    import ctypes
    from ctypes import wintypes

    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.OpenProcess.restype = wintypes.HANDLE
    dll.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    dll.CloseHandle.restype = wintypes.BOOL
    dll.CloseHandle.argtypes = (wintypes.HANDLE,)

    class _Kernel32:
        def OpenProcess(self, access, inherit, pid):
            return dll.OpenProcess(access, inherit, pid)

        def CloseHandle(self, handle):
            return dll.CloseHandle(handle)

        def last_error(self):
            return ctypes.get_last_error()

    return _Kernel32()


def _pid_alive_windows(pid, kernel32=None):
    """Windows liveness — deliberately NOT via os.kill.

    os.kill is not a probe on Windows. Signal 0 is CTRL_C_EVENT, so CPython routes it
    into GenerateConsoleCtrlEvent, which *signals* a console process group — and this
    process shares its console with the generator subprocess it spawns. Every other
    signal value goes to TerminateProcess instead. Neither asks a question; both fail
    with a plain OSError for a foreign pid, which the old code read as "alive", so on
    Windows a stale refresh.lock could never expire before LOCK_MAX_AGE and the app
    could not start the refresh that would have repaired it.

    OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION only asks. (A pid whose process
    has exited but whose handle someone still holds reads as alive here; LOCK_MAX_AGE
    remains the backstop for that.)"""
    k32 = kernel32 or _windows_kernel32()
    handle = k32.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return k32.last_error() == _WIN_ERROR_ACCESS_DENIED
    k32.CloseHandle(handle)
    return True


def _pid_alive(pid):
    if not pid or pid <= 0:
        return False
    if sys.platform.startswith("win"):
        try:
            return _pid_alive_windows(pid)
        except Exception:
            return True        # probe unavailable — age fallback covers stale
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True            # exists, owned by someone else
    except OSError:
        return True
    return True


def _read_lock():
    try:
        with open(LOCK_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _lock_is_active(lock):
    """A lock is active only if its holder pid is alive AND it is not older than
    LOCK_MAX_AGE (so a crash on any OS eventually frees it)."""
    if not lock:
        return False
    started = lock.get("started_epoch")
    if started is None:
        return False   # no timestamp -> treat as stale (safe direction; never wedge)
    try:
        if (datetime.now().timestamp() - float(started)) > LOCK_MAX_AGE:
            return False
    except (TypeError, ValueError):
        return False   # unparseable timestamp -> treat as stale
    return _pid_alive(lock.get("pid"))


def acquire_refresh_lock(trigger):
    """Best-effort cross-process lock. Returns True if acquired, False if a live
    refresh already holds it. (Single local user — the TOCTOU window is negligible
    and the in-process spawn lock covers the common double-click case.)"""
    if _lock_is_active(_read_lock()):
        return False
    try:
        os.makedirs("ff_data", exist_ok=True)
        with open(LOCK_FILE, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(),
                       "started_epoch": datetime.now().timestamp(),
                       "trigger": trigger}, f)
        return True
    except Exception:
        return False


def release_refresh_lock():
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def refresh_status_payload():
    """Progress for the API, cross-checked against the lock: a 'running' state with
    no live lock (crashed run) is reported as 'idle' so the bar never freezes."""
    prog = _read_progress() or {"state": "idle"}
    active = _lock_is_active(_read_lock())
    if prog.get("state") == "running" and not active:
        prog = dict(prog)
        prog["state"] = "idle"
    prog["running"] = active
    return prog


def _platform_label():
    if sys.platform == "darwin":
        return "macOS"
    if sys.platform.startswith("win"):
        return "Windows"
    if sys.platform.startswith("linux"):
        return "Linux"
    return sys.platform


def version_payload():
    """Build info for the Settings tab's About card. Read from the RUNNING process,
    never from ff_data/config.js: a freshly installed version must report itself
    before (and even if) the first refresh rewrites the data folder."""
    return {
        "version": app_version.APP_VERSION,
        "build": "installer" if FROZEN else "source",
        "python": "%d.%d.%d" % sys.version_info[:3],
        "platform": _platform_label(),
    }


def check_python():
    if sys.version_info < (3, 7):
        print("✗ Python 3.7 or newer is required.")
        print(f"  Current version: {sys.version}")
        sys.exit(1)


def ensure_packages():
    """Install missing packages automatically via pip."""
    step("Checking required packages…")
    if FROZEN:
        ok("Packages included in the bundle")
        return
    import importlib.util

    # The import name can differ from the package name
    import_names = {"python-dateutil": "dateutil", "yfinance": "yfinance", "pypdf": "pypdf", "curl_cffi": "curl_cffi"}

    missing = []
    for pkg in REQUIRED:
        mod = import_names.get(pkg, pkg)
        if importlib.util.find_spec(mod) is None:
            missing.append(pkg)
        else:
            ok(f"{pkg} present")

    if not missing:
        return

    warn(f"Missing: {', '.join(missing)} – installing now…")
    for pkg in missing:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--user", pkg],
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
            )
            ok(f"{pkg} installed")
        except subprocess.CalledProcessError:
            # second attempt without --user (e.g. inside a venv)
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", pkg],
                    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                )
                ok(f"{pkg} installed")
            except subprocess.CalledProcessError:
                print(f"\n✗ Could not install {pkg}.")
                print(f"  Please run manually:  pip install {pkg}")
                sys.exit(1)


def _config_js_is_complete(path):
    """Whether ff_data/config.js is a WHOLE file, not just an existing one.

    The generator writes it as `window.__CONFIG__ = {…};\\n` in a single statement, so a
    complete file starts with the assignment and ends with the semicolon. A refresh
    killed mid-write used to leave an empty or half file here, and merely existing was
    enough to count as "data present" — the app then served a page whose very first
    line (core.js: window.__CONFIG__.index) threw before any other module was defined,
    with no way back except regenerating by hand. Writes are atomic now, so this only
    has to catch the files that earlier versions already left on disk. It is ~5 KB."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read().strip()
    except OSError:
        return False
    return text.startswith("window.__CONFIG__") and text.endswith(";")


def dashboard_exists():
    """Check whether the generated data (config.js + category JSONs) is present.

    The static frontend (index.html + web/) is always in the repo; what can be
    missing is the generated data in ff_data/.
    """
    if not _config_js_is_complete(os.path.join("ff_data", "config.js")):
        return False
    data_dir = "ff_data"
    if not os.path.isdir(data_dir):
        return False
    return any(name.endswith(".json") for name in os.listdir(data_dir))


def _eastern_now():
    """Current New York time; dateutil keeps this Python 3.7 compatible."""
    if ZoneInfo is not None:
        return datetime.now(ZoneInfo("America/New_York"))
    from dateutil import tz
    return datetime.now(tz.gettz("America/New_York"))


def _latest_business_day_on_or_before(day):
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _previous_business_day(day):
    return _latest_business_day_on_or_before(day - timedelta(days=1))


def _latest_settled_eod_date(now_et=None):
    """Latest business date whose settled EoD bar should already exist from yfinance.

    This is the settle cutoff for the contract-history endpoint's unsettled-tail
    guard (`_drop_unsettled_tail`) — a still-forming bar is never served. We use
    17:30 ET as a practical delay buffer after the US futures close; before that,
    today's bar has not settled yet, so the previous business day is the latest
    settled date.
    """
    now_et = now_et or _eastern_now()
    today = now_et.date()
    if today.weekday() >= 5:
        return _latest_business_day_on_or_before(today)
    if now_et.time() < YFINANCE_EOD_READY_ET:
        return _previous_business_day(today)
    return today


def _parse_date(value):
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _run_generator_subprocess():
    """Run the generator once; return its process return code. No sys.exit, so it is
    safe to call from a background thread."""
    cmd = [sys.executable, "--run-generator"] if FROZEN else [sys.executable, GENERATOR]
    if not FROZEN and not os.path.exists(GENERATOR):
        print(f"\n✗ {GENERATOR} not found!")
        return 1
    try:
        return subprocess.call(cmd, cwd=DATA_ROOT)
    except Exception as e:
        print(f"\n✗ Generator subprocess failed: {e}")
        return 1


def generate_dashboard():
    """Regenerate ff_data/ (blocking). Aborts with sys.exit on failure — for the
    foreground path (--refresh, first run)."""
    step("Generating dashboard (fetching data – this can take 1–2 min)…")
    rc = _run_generator_subprocess()
    if rc != 0:
        print("\n✗ Failed to generate the dashboard.")
        sys.exit(1)
    if not os.path.exists(os.path.join(DATA_ROOT, "ff_data", "config.js")):
        print("\n✗ ff_data/config.js was not created.")
        sys.exit(1)
    ok("Dashboard created")


_refresh_spawn_lock = threading.Lock()


def _run_locked_refresh():
    """Runs the generator while holding the lock; finalizes progress + releases.
    The lock is assumed already acquired by the caller. (The trigger is already
    recorded in the lock + progress file, so it is not needed here.)"""
    try:
        clear_contract_history_cache()
        rc = _run_generator_subprocess()
        if rc == 0:
            _write_progress(state="done",
                            finished_at=datetime.now().isoformat(timespec="seconds"))
        else:
            _write_progress(state="error",
                            finished_at=datetime.now().isoformat(timespec="seconds"),
                            error=f"generator-rc-{rc}")
    finally:
        release_refresh_lock()


def start_background_refresh(trigger="manual"):
    """Spawn a background refresh thread if none is running. Returns an API dict.
    Used by the manual endpoint AND the warm-start auto-trigger."""
    with _refresh_spawn_lock:
        if not acquire_refresh_lock(trigger):
            return {"running": True, "already": True}
        _write_progress(state="running", trigger=trigger, total=None, done=0,
                        current=None, category=None,
                        started_at=datetime.now().isoformat(timespec="seconds"),
                        finished_at=None, latest_eod=None, error=None)
        try:
            threading.Thread(target=_run_locked_refresh, daemon=True).start()
        except Exception:
            # Thread spawn failed (interpreter shutdown / thread limit) — don't
            # leave the file lock orphaned for up to LOCK_MAX_AGE.
            release_refresh_lock()
            return {"running": False, "error": "spawn-failed"}
        return {"running": True, "started": True}


def foreground_refresh():
    """Blocking refresh for the --refresh CLI path. Respects the shared lock so it
    never collides with a running server's background refresh or the 23:30 job."""
    if not acquire_refresh_lock("cli"):
        warn("Another refresh is already running — skipped.")
        return
    try:
        clear_contract_history_cache()
        generate_dashboard()   # generator writes its own running->done progress
        _write_progress(state="done",
                        finished_at=datetime.now().isoformat(timespec="seconds"))
    finally:
        release_refresh_lock()


def free_port(port):
    """Find a free port at or above the requested one."""
    import socket
    for p in range(port, port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return port


# Serializes the lazy contract-history cache (request threads read/write it) against
# the refresh thread wiping it, so a wipe mid-request cannot race the open()/replace().
_contract_cache_lock = threading.Lock()


def _contract_history_cache_path(symbol, period):
    safe_symbol = re.sub(r"[^A-Za-z0-9_.=-]+", "_", symbol)
    safe_period = re.sub(r"[^A-Za-z0-9_.=-]+", "_", period)
    cache_dir = os.path.join("ff_data", "contract_history")
    return os.path.join(cache_dir, f"{safe_symbol}_{safe_period}.json")


def clear_contract_history_cache():
    """Discard the cached single-contract histories.

    They are built lazily on the first click of a contract row and otherwise reused
    forever. On --refresh they have to go, or contracts that were already clicked
    keep showing stale prices after the update.
    """
    import shutil
    cache_dir = os.path.join("ff_data", "contract_history")
    with _contract_cache_lock:
        if os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir, ignore_errors=True)
            ok("Single-contract cache cleared (reloaded on demand)")


def _trim_leading_flat(rows):
    """Drop leading placeholder bars (volume 0/None and O=H=L=C), the kind yfinance
    returns for far-dated contracts that are not actively traded yet."""
    i, n = 0, len(rows)
    while i < n:
        r = rows[i]
        flat = r["open"] == r["high"] == r["low"] == r["close"]
        if flat and not r.get("volume"):
            i += 1
        else:
            break
    return rows[i:]


def _drop_unsettled_tail(rows):
    """Drop trailing bars beyond the last settled EoD (never serve a pre-settle bar).
    Mirrors the generator's ingest rule; a date-based check is enough for the lazy
    single-contract endpoint."""
    cutoff = _latest_settled_eod_date()
    while rows:
        d = _parse_date(rows[-1].get("date"))
        if d is not None and d > cutoff:
            rows.pop()
        else:
            break
    return rows


def _history_rows(symbol, period, priority=yahoo_gateway.PRIORITY_INTERACTIVE):
    """One contract's daily bars. Routed through the shared gateway: this path used to
    run on a bare Ticker with no session, no rate cap and no retry — the same hole the
    generator had, and the one the cold-start preload drives 39 requests through."""
    import yfinance as yf

    session = yahoo_gateway.gateway().session()
    ticker = yf.Ticker(symbol, session=session) if session is not None else yf.Ticker(symbol)
    hist = yahoo_gateway.gateway().call(
        lambda: ticker.history(period=period, interval="1d"),
        priority=priority, default=None)
    rows = []
    if hist is None or hist.empty:
        return rows

    for idx, row in hist.iterrows():
        o, h, l, c = row["Open"], row["High"], row["Low"], row["Close"]
        if any(v != v for v in (o, h, l, c)):
            continue
        volume = row["Volume"] if "Volume" in row else None
        # `volume is not None` guards the missing-column case (None == None is True,
        # so the bare NaN-check `volume == volume` would let None reach int() -> 500);
        # the second clause then drops NaN volumes.
        rows.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open": round(float(o), 4),
            "high": round(float(h), 4),
            "low": round(float(l), 4),
            "close": round(float(c), 4),
            "volume": int(volume) if volume is not None and volume == volume else None,
        })
    return _drop_unsettled_tail(_trim_leading_flat(rows))


def get_contract_history(symbol, period="5y",
                         priority=yahoo_gateway.PRIORITY_INTERACTIVE):
    """Fetch and cache the history of a single futures contract."""
    cache_path = _contract_history_cache_path(symbol, period)
    with _contract_cache_lock:
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (ValueError, OSError):
                # Corrupt/truncated cache file (e.g. a crash mid-write): discard and
                # rebuild it instead of answering 500 on every call.
                try:
                    os.remove(cache_path)
                except OSError:
                    pass

    # Network fetch deliberately outside the lock (slow) — only the FS ops are serialized.
    history = _history_rows(symbol, period, priority=priority)
    payload = {
        "symbol": symbol,
        "period": period,
        "source": "yfinance",
        "contract_type": "single_expiry_month",
        "history": history,
    }
    # NEVER cache an empty result: that happens mostly during a refresh (cache just
    # cleared + Yahoo throttled by that refresh). Caching the empty answer would leave the
    # contract blank until the next refresh ("No chart history"). This way the next call
    # fetches fresh — as soon as Yahoo answers again, the history is there.
    if not history:
        return payload
    with _contract_cache_lock:
        cache_dir = os.path.dirname(cache_path)
        try:
            os.makedirs(cache_dir, exist_ok=True)
            # Write atomically (tempfile + os.replace) so a crash / full disk cannot
            # leave half a JSON file behind that crashes every later read.
            fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=".ch_", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False)
                os.replace(tmp, cache_path)
            except OSError:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        except OSError:
            pass   # Cache is best-effort: on FS trouble we still serve the history.
    return payload


def _live_quote_row(symbol, session=None):
    """Latest price for one symbol, INCLUDING the still-forming (unsettled) bar.

    The deliberate inverse of `_history_rows` + `_drop_unsettled_tail`: it keeps the
    unsettled tail and persists NOTHING (no cache file, no JSON, no SQLite). Display-only
    — the frontend overlays it on the chart and discards it on reload.
    """
    import yfinance as yf

    ticker = yf.Ticker(symbol, session=session) if session is not None else yf.Ticker(symbol)
    # 5 days guarantees at least one bar after weekends/holidays for a single latest quote.
    hist = ticker.history(period="5d", interval="1d")
    if hist is None or hist.empty:
        return None
    idx = hist.index[-1]
    row = hist.iloc[-1]
    close = row.get("Close")
    if close is None or close != close:  # missing column or NaN
        return None

    def _px(v):
        # round like the settled series; drop missing/NaN so the frontend can fall back.
        return round(float(v), 4) if v is not None and v == v else None

    # The still-forming 1d bar already carries today's intraday Open/High/Low/Close, so
    # the live overlay can paint a REAL candle (not a flat single-price mark). Display-only;
    # persisted nowhere.
    # idx is yfinance's native tz; "day" is a display label only and uses the same
    # strftime convention as _history_rows, so it lines up with the settled series.
    return {
        "day": idx.strftime("%Y-%m-%d"),
        "price": round(float(close), 4),
        "open": _px(row.get("Open")),
        "high": _px(row.get("High")),
        "low": _px(row.get("Low")),
    }


# Moved to yahoo_gateway.py so the generator subprocess shares one definition. The alias
# stays because this module is imported by tools and scripts outside this repo tree; the
# gateway now normalises rate limits itself, so nothing in start.py calls it directly.
_is_rate_limit_error = yahoo_gateway._is_rate_limit_error


def _live_fetch_many(symbols, priority=yahoo_gateway.PRIORITY_INTERACTIVE):
    """Injected into LiveQuoteCache. Batches every SINGLE-CONTRACT symbol into ONE Yahoo
    request; continuous (`=F`) symbols keep the per-symbol chart path.

    That split is measured, not cautious: Yahoo's quote endpoint prices a continuous
    symbol from a different contract than its own chart series does (GC=F chart returns
    GCQ26, GC=F quote returns GCZ26 — 14 of 16 `=F` symbols disagreed, up to 9.44 %), so
    splicing a batched quote onto a continuous chart would draw a jump that is not in the
    market. See yahoo_gateway.is_batchable.
    """
    symbols = list(symbols)
    batchable = [s for s in symbols if yahoo_gateway.is_batchable(s)]
    rest = [s for s in symbols if not yahoo_gateway.is_batchable(s)]
    out = {}
    batch_ran = True
    if batchable:
        # `status` is how the batch reports itself: {} means both "ran, nothing usable"
        # and "never ran", and the breaker below must not confuse the two.
        status = {}
        out.update(yahoo_gateway.gateway().quotes(batchable, priority=priority,
                                                  status=status))
        if status.get("rate_limited") or yahoo_gateway.gateway().cooldown_active():
            # Yahoo pushed back. Raising is what arms the client-side cooldown: the cache
            # trips its own breaker, /api/live-quote answers 429 + retry_after, and
            # live.js stands the poller down. Swallowing this (returning {}) left every
            # one of those unreachable — a failed batch even RESET the cache breaker.
            raise live_cache.RateLimitedError("Yahoo rate limit (batch quote)")
        # A batch that did not RUN — the bucket refused it, the breaker was open, or the
        # request failed. Fanning out to one request per symbol there is strictly worse
        # than doing nothing: it spends N requests of exactly the budget that just said
        # no, and it is how a declined batch of 39 turned into 39 individual chart
        # fetches. Serve last-known instead (the cache does that for us).
        batch_ran = bool(status.get("ran"))
    # Continuous symbols never batch, so they always take the per-symbol chart path. Batchable
    # ones only fall back when the batch actually ran and simply omitted them.
    fallback = list(rest)
    if batch_ran:
        fallback += [s for s in batchable if s not in out]
    for symbol in fallback:
        try:
            # THROUGH the gateway, one token per symbol: get_many() spends a single token
            # for the whole call, so an unwrapped fallback let one /api/live-quote of up
            # to 96 continuous symbols fire up to 96 unrationed Yahoo requests from one
            # handler thread — no breaker, no priority, no 429 normalisation. The
            # RateLimitedError below is only reachable because the gateway raises it.
            row = yahoo_gateway.gateway().call(
                lambda: _live_quote_row(symbol, session=yahoo_gateway.gateway().session()),
                priority=priority, default=None)
        except live_cache.RateLimitedError:
            raise                      # let the cache trip its breaker, as before
        except Exception:
            continue
        if row:
            row.setdefault("state", None)
            out[symbol] = row
    return out


# One process-wide cache shared by every request thread (cross-tab + cross-poll dedup).
_live_quote_cache = live_cache.LiveQuoteCache(_live_fetch_many)


def live_quote_payload(symbol):
    """Display-only live quote, served through the RAM-only cache. Never persisted."""
    q = _live_quote_cache.get(symbol)
    return {
        "symbol": symbol, "price": q.get("price"), "day": q.get("day"),
        "open": q.get("open"), "high": q.get("high"), "low": q.get("low"),
        "state": q.get("state"),
    }


def live_quotes_payload(symbols, priority=yahoo_gateway.PRIORITY_INTERACTIVE):
    """Batch form: ONE Yahoo request warms/serves every single-contract symbol asked for
    (the cold-start preload sends all 39 front months in one call)."""
    return {"quotes": _live_quote_cache.get_many(symbols, priority=priority)}


def live_cooldown_retry_after():
    """Seconds to back off if the breaker is open (cooldown), else 0."""
    return _live_quote_cache.retry_after() if _live_quote_cache.cooldown_active() else 0


def _is_client_disconnect(exc):
    """True for the errors a browser that walked away raises on OUR side of the socket.

    Every one of them means the same thing — the peer is gone — and none of them is a
    fault of this server: a reload or a closed tab resets an in-flight response, and the
    category JSONs are 6-14 MB, so there is a wide window to be reset inside. There is
    nothing to log and nothing to fix, but socketserver's default handle_error prints a
    full traceback, and this console is what a non-technical user is looking at.
    """
    return isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError))


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        return

    def translate_path(self, path):
        # Default roots the path at cwd (== DATA_ROOT). In dev APP_DIR == DATA_ROOT, so
        # this is a no-op. Frozen: keep ff_data/* in the writable DATA_ROOT, but serve the
        # static frontend (index.html, web/, loading.html) from the read-only bundle.
        full = super().translate_path(path)
        if APP_DIR == DATA_ROOT:
            return full
        rel = os.path.relpath(full, DATA_ROOT)
        top = rel.split(os.sep, 1)[0]
        if top == "ff_data":
            return full
        return os.path.join(APP_DIR, rel)

    def end_headers(self):
        # Local dev server: never serve a stale frontend. The HTML document references the
        # ?v-versioned assets, so a cached document means old ?v -> old JS (the "works in one
        # browser, broken in another" trap — e.g. Opera serving a pre-fix page). The document
        # gets no-store (never cached at all, which also defeats the back/forward cache and the
        # browser's heuristic cache); the versioned JS/CSS get no-cache (revalidate -> cheap
        # 304s). The JSON API sets its own Cache-Control (no-store) in _send_json, so skip /api/.
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            if path.endswith("/") or path.endswith(".html"):
                self.send_header("Cache-Control", "no-store, must-revalidate")
            else:
                self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    @staticmethod
    def _priority(qs):
        """The server cannot infer WHY a request was made, so the client declares it.
        Default is interactive — every pre-existing caller is a user action — and the
        value is validated against the two client-reachable classes, so a crafted request
        cannot claim one the frontend never uses (notably never PRIORITY_BULK, which
        outranks nothing but is reserved for the generator)."""
        want = (qs.get("priority") or [""])[0].strip()
        return (yahoo_gateway.PRIORITY_PRELOAD if want == "preload"
                else yahoo_gateway.PRIORITY_INTERACTIVE)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/refresh-status":
            self._send_json(200, refresh_status_payload())
            return
        if parsed.path == "/api/version":
            self._send_json(200, version_payload())
            return
        if parsed.path == "/api/contract-history":
            qs = urllib.parse.parse_qs(parsed.query)
            symbol = (qs.get("symbol") or [""])[0].strip()
            period = (qs.get("period") or ["5y"])[0].strip() or "5y"
            if not re.fullmatch(r"[A-Za-z0-9_.=-]{2,32}", symbol):
                self._send_json(400, {"error": "Ungueltiges Symbol"})
                return
            if period not in {"6mo", "1y", "2y", "5y", "max"}:
                period = "5y"
            # Build inside the try, send outside it. Failing to BUILD the payload is a
            # server error and earns a 500; failing to WRITE it means the client walked
            # away mid-body (a reload, a closed tab, a superseded fetch) — and answering
            # that with a second write onto the dead socket raised BrokenPipeError out of
            # do_GET, so the user's console got two full tracebacks for a non-event.
            try:
                payload = get_contract_history(
                    symbol, period, priority=self._priority(qs))
            except Exception as e:
                self._send_json(500, {"error": str(e), "symbol": symbol})
                return
            self._send_json(200, payload)
            return

        if parsed.path == "/api/live-quote":
            qs = urllib.parse.parse_qs(parsed.query)
            retry = live_cooldown_retry_after()
            symbols_raw = (qs.get("symbols") or [""])[0].strip()
            if symbols_raw:                              # batch form: ?symbols=A,B,C
                syms = [s.strip() for s in symbols_raw.split(",") if s.strip()]
                # 96 covers the cold-start preload's 39 front-month symbols with room to
                # spare; yahoo_gateway chunks at QUOTE_BATCH_SIZE regardless.
                syms = [s for s in syms if re.fullmatch(r"[A-Za-z0-9_.=-]{2,32}", s)][:96]
                payload = live_quotes_payload(syms, priority=self._priority(qs))
                if retry > 0:
                    payload["retry_after"] = retry
                    self._send_json(429, payload)
                else:
                    self._send_json(200, payload)
                return
            symbol = (qs.get("symbol") or [""])[0].strip()   # single form (back-compat)
            if not re.fullmatch(r"[A-Za-z0-9_.=-]{2,32}", symbol):
                self._send_json(400, {"error": "Ungueltiges Symbol"})
                return
            payload = live_quote_payload(symbol)
            if retry > 0:
                payload["retry_after"] = retry
                self._send_json(429, payload)
            else:
                self._send_json(200, payload)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/refresh":
            # The manual button always runs. The generator still ingests settled
            # EoD only — never intraday.
            self._send_json(200, start_background_refresh("manual"))
            return
        self._send_json(404, {"error": "not found"})


_mac_app_delegate = None   # strong ref: NSApplication.setDelegate_ does not retain it


def _should_run_mac_app():
    """Whether to drive serving from a macOS Cocoa app loop (Dock icon + reopen
    handler). Frozen .app on darwin only; CHARTHORIZON_MAC_APP=1 forces it on for a
    dev-mode live test without rebuilding."""
    return sys.platform == "darwin" and bool(FROZEN or os.environ.get("CHARTHORIZON_MAC_APP"))


def _serve_with_mac_app(httpd, url):
    """Serve in a background thread and run a Cocoa app on the main thread, so every
    re-open of the .app reopens the dashboard tab. Degrades to plain serving if
    PyObjC is unavailable, so the dashboard never fails to start."""
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()
    try:
        _run_mac_app(url, httpd)
    except Exception as e:                       # PyObjC missing / Cocoa failed
        warn(f"macOS app loop unavailable ({e}) — simple mode.")
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        try:
            server_thread.join()
        except KeyboardInterrupt:
            httpd.shutdown()


def _run_mac_app(url, httpd):
    """Minimal Cocoa application: shows a Dock icon and reopens the browser tab on
    launch and on every reopen (Dock click / re-launch of the running app). Cmd-Q
    stops the server. Raises if PyObjC is unavailable — the caller falls back."""
    from AppKit import (NSApplication, NSApplicationActivationPolicyRegular,
                        NSMenu, NSMenuItem)
    from Foundation import NSObject

    def _open():
        try:
            webbrowser.open(url)
        except Exception:
            pass

    class _Delegate(NSObject):
        def applicationDidFinishLaunching_(self, _note):
            _open()

        def applicationShouldHandleReopen_hasVisibleWindows_(self, _app, _has):
            _open()
            return True

        def applicationWillTerminate_(self, _note):
            try:
                httpd.shutdown()
            except Exception:
                pass

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)   # show in Dock

    global _mac_app_delegate
    _mac_app_delegate = _Delegate.alloc().init()
    app.setDelegate_(_mac_app_delegate)

    # Minimal main menu so Cmd-Q (terminate:) quits cleanly.
    menubar = NSMenu.alloc().init()
    app_item = NSMenuItem.alloc().init()
    menubar.addItem_(app_item)
    app.setMainMenu_(menubar)
    app_menu = NSMenu.alloc().init()
    app_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
        "ChartHorizon beenden", "terminate:", "q"))
    app_item.setSubmenu_(app_menu)

    app.activateIgnoringOtherApps_(True)
    app.run()


def _bundle_path():
    """Path to the enclosing .app bundle when frozen (…/ChartHorizon.app), else None."""
    exe = os.path.abspath(sys.executable)
    bundle = os.path.dirname(os.path.dirname(os.path.dirname(exe)))  # MacOS -> Contents -> .app
    return bundle if bundle.endswith(".app") else None


def _running_from_unsafe_location():
    """True when the frozen macOS app runs from a read-only / translocated / mounted
    location (DMG double-click, or a quarantined Download). macOS App-Translocation
    runs such apps from an ephemeral read-only mount; when it disappears mid-run the
    mmap'd binary faults with SIGBUS. The app must run from /Applications instead."""
    exe = os.path.abspath(sys.executable)
    if "/AppTranslocation/" in exe or exe.startswith("/Volumes/"):
        return True
    try:
        return bool(os.statvfs(exe).f_flag & os.ST_RDONLY)
    except (OSError, AttributeError):
        return False


def _mac_alert(message, informative, buttons):
    """Show a native modal alert; return the 0-based index of the clicked button.
    Raises if PyObjC is unavailable (the caller decides the fallback)."""
    from AppKit import (NSApplication, NSAlert, NSApplicationActivationPolicyRegular,
                        NSAlertFirstButtonReturn)
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    app.activateIgnoringOtherApps_(True)
    alert = NSAlert.alloc().init()
    alert.setMessageText_(message)
    alert.setInformativeText_(informative)
    for title in buttons:
        alert.addButtonWithTitle_(title)
    return int(alert.runModal()) - int(NSAlertFirstButtonReturn)


def _copy_bundle_to_applications(src, dest):
    """Copy the .app to /Applications and strip quarantine so the copy is never
    translocated again."""
    import shutil
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest, symlinks=True)
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", dest],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def _relocate_from_unsafe_location():
    """Offer to move the app into /Applications and relaunch it from there, so it
    never runs translocated (which crashes with SIGBUS when the mount vanishes)."""
    bundle = _bundle_path()
    if not bundle:
        return
    dest = "/Applications/ChartHorizon.app"
    already = os.path.isdir(dest)
    if already:
        info = ("ChartHorizon is already installed in the Applications folder and will "
                "be launched from there. Starting from the temporary location can crash.")
        primary = "Open from Applications"
    else:
        info = ("ChartHorizon is currently running from a temporary location (DMG or "
                "download) and can crash there. The app will be copied to the "
                "Applications folder and relaunched from there.")
        primary = "Move & launch"
    try:
        choice = _mac_alert("Move ChartHorizon to Applications", info,
                            [primary, "Cancel"])
    except Exception:
        return                       # no GUI available — bail instead of risking SIGBUS
    if choice != 0:
        return                       # cancelled
    try:
        if not already:
            _copy_bundle_to_applications(bundle, dest)
        subprocess.Popen(["open", dest])
    except Exception as e:
        try:
            _mac_alert("Move failed",
                       f"Please drag ChartHorizon into the Applications folder manually.\n\n{e}",
                       ["OK"])
        except Exception:
            pass


class LocalServer(socketserver.ThreadingTCPServer):
    # SO_REUSEADDR means opposite things on the two platforms. On POSIX it lets us
    # rebind a port still in TIME_WAIT from the previous run, which is why it is on.
    # On Windows it also permits binding a port another process is ACTIVELY LISTENING
    # on — the second binder simply takes over new connections. Two double-clicks in
    # the same second both find 8000 free (free_port probes with connect_ex), and
    # instead of the second one exiting with "port already in use" as it does on a
    # Mac, both bind and the browser reaches whichever won. Windows frees a listening
    # port as soon as the process goes, so it never needed the flag to begin with.
    allow_reuse_address = not sys.platform.startswith("win")

    def handle_error(self, request, client_address):
        """Stay silent when the peer merely went away; report everything else.

        This is the last stop for anything raised out of a handler, static files
        included — copyfile() streaming a 14 MB category JSON is reset just as readily
        as an /api/ response, and the default here would print a traceback for it.
        """
        if _is_client_disconnect(sys.exc_info()[1]):
            return
        super().handle_error(request, client_address)


def serve(open_browser=True):
    """Start the web server and open the browser (unless open_browser=False — for the
    nightly content-bot run, which only needs the HTTP API headless)."""
    global PORT
    PORT = free_port(PORT)
    url = f"http://127.0.0.1:{PORT}/{HTML_FILE}"

    step("Starting local web server…")
    try:
        httpd = LocalServer(("127.0.0.1", PORT), DashboardHandler)
    except OSError as e:
        print(f"\n✗ Port {PORT} already in use: {e}")
        sys.exit(1)

    ok(f"Server running at {url}")
    print("\n" + "═" * 60)
    print(f"  Dashboard open:  {url}")
    print("  To quit:  Ctrl + C")
    print("═" * 60 + "\n")

    # The clickable macOS .app must serve from a Cocoa loop so re-opening it (Dock
    # click or double-click) reopens the browser tab. Without it the .app is a
    # window-less resident server: LaunchServices routes every later click to the
    # already-running instance, which does nothing — so it "opens only once".
    if open_browser and _should_run_mac_app():
        _serve_with_mac_app(httpd, url)
        return

    # Open the browser after a short delay (not in headless/bot mode).
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\n▶ Shutting down the server… Bye!")
        httpd.shutdown()


def _first_run_generate():
    """Generate ff_data/ in the background on first launch (frozen), then the splash's
    poll loop redirects to the dashboard."""
    try:
        generate_dashboard()
    except SystemExit:
        pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--refresh", action="store_true")
    # Kept as a harmless no-op for backward compatibility: --refresh always does a
    # full fetch now (the old EoD skip-gate is gone), so --force-refresh adds nothing.
    parser.add_argument("--force-refresh", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--no-serve", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--run-generator", action="store_true")
    args = parser.parse_args()

    print("═" * 60)
    print("  CHARTHORIZON – LOCAL START")
    print("═" * 60)
    # Dev: cwd = script dir (ff_data lives beside the code, unchanged).
    # Frozen: cwd = writable data root, so the generator + server read/write ff_data
    # there instead of inside the read-only bundle.
    os.chdir(DATA_ROOT)

    if args.run_generator:
        # Re-exec entry point for the frozen build: behaves like running
        # commodity_dashboard.py as __main__ (cwd is already DATA_ROOT).
        import commodity_dashboard as cd
        data = cd.gather_commodity_data(count=6)
        cd.generate_html(data)
        return

    # Quarantined DMG/Download launches run via macOS App-Translocation from a
    # read-only ephemeral mount; when it disappears mid-run the mmap'd binary faults
    # (SIGBUS). Offer to move into /Applications and relaunch from there first.
    if FROZEN and sys.platform == "darwin" and _running_from_unsafe_location():
        _relocate_from_unsafe_location()
        return

    check_python()
    ensure_packages()
    if (args.refresh or not dashboard_exists()) and not (FROZEN and not dashboard_exists() and not args.refresh):
        if args.refresh:
            # Always pull the freshest yfinance data (no EoD skip-gate any more).
            # The generator still stores settled EoD only — never intraday.
            foreground_refresh()
        else:
            generate_dashboard()      # first run with no data — unconditional
    else:
        step("Using existing dashboard files")
        ok("No new data download needed")
    if args.no_serve:
        step("Data mode finished")
        ok("Web server was not started")
        return

    # Warm start (data already present, no CLI --refresh): serve instantly and always
    # kick a background refresh so the page is pulling the freshest yfinance data on
    # every open. The in-watchlist bar polls /api/refresh-status. (The lock serializes
    # against any other refresh; the generator still ingests settled EoD only.)
    if (not args.refresh) and dashboard_exists():
        start_background_refresh("auto")

    # Frozen first launch with no data yet: open the splash and fetch in the background,
    # so a double-clicked app shows progress instead of a dead window. (Dev keeps the
    # original blocking behaviour — data already generated above.)
    if FROZEN and not dashboard_exists():
        global HTML_FILE
        HTML_FILE = "loading.html"
        threading.Thread(target=_first_run_generate, daemon=True).start()
    serve(open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
