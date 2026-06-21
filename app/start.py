#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  CHARTHORIZON – LOKALER START
═══════════════════════════════════════════════════════════════════════
  Dieses Skript erledigt alles automatisch:
    1. Prüft & installiert benötigte Pakete (yfinance, python-dateutil, pypdf, curl_cffi)
    2. Nutzt vorhandene Dashboard-Dateien oder generiert sie neu
    3. Startet einen lokalen Webserver
    4. Öffnet das Dashboard im Browser

  Starten:
    python3 start.py            (schnell starten; holt im Hintergrund die neuesten Daten)
    python3 start.py --refresh  (immer die aktuellsten yfinance-Daten laden)
    python3 start.py --refresh --no-serve  (nur Daten-Update, kein Webserver)

  Beenden:  Strg + C  (Ctrl + C)
═══════════════════════════════════════════════════════════════════════
"""

import os
import sys
import argparse
import subprocess
import threading
import webbrowser

import live_cache

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


_LIVE_SESSION = _build_live_session()


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


def _pid_alive(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True            # exists, owned by someone else
    except OSError:
        return True            # Windows: os.kill(pid,0) unreliable — age fallback covers stale
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


def check_python():
    if sys.version_info < (3, 7):
        print("✗ Python 3.7 oder neuer wird benötigt.")
        print(f"  Aktuelle Version: {sys.version}")
        sys.exit(1)


def ensure_packages():
    """Installiert fehlende Pakete automatisch via pip."""
    step("Prüfe benötigte Pakete…")
    if FROZEN:
        ok("Pakete im Bundle enthalten")
        return
    import importlib.util

    # Importname kann vom Paketnamen abweichen
    import_names = {"python-dateutil": "dateutil", "yfinance": "yfinance", "pypdf": "pypdf", "curl_cffi": "curl_cffi"}

    missing = []
    for pkg in REQUIRED:
        mod = import_names.get(pkg, pkg)
        if importlib.util.find_spec(mod) is None:
            missing.append(pkg)
        else:
            ok(f"{pkg} vorhanden")

    if not missing:
        return

    warn(f"Fehlend: {', '.join(missing)} – installiere jetzt…")
    for pkg in missing:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--user", pkg],
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
            )
            ok(f"{pkg} installiert")
        except subprocess.CalledProcessError:
            # zweiter Versuch ohne --user (z.B. in venv)
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", pkg],
                    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                )
                ok(f"{pkg} installiert")
            except subprocess.CalledProcessError:
                print(f"\n✗ Konnte {pkg} nicht installieren.")
                print(f"  Bitte manuell ausführen:  pip install {pkg}")
                sys.exit(1)


def dashboard_exists():
    """Prueft, ob die generierten Daten (config.js + Kategorie-JSONs) vorhanden sind.

    Das statische Frontend (index.html + web/) ist immer im Repo; was fehlen kann,
    sind die generierten Daten in ff_data/.
    """
    if not os.path.exists(os.path.join("ff_data", "config.js")):
        return False
    data_dir = "ff_data"
    if not os.path.isdir(data_dir):
        return False
    return any(name.endswith(".json") for name in os.listdir(data_dir))


def _eastern_now():
    """Aktuelle New-York-Zeit; dateutil hält Python 3.7 kompatibel."""
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
        print(f"\n✗ {GENERATOR} nicht gefunden!")
        return 1
    try:
        return subprocess.call(cmd, cwd=DATA_ROOT)
    except Exception as e:
        print(f"\n✗ Generator-Subprozess fehlgeschlagen: {e}")
        return 1


def generate_dashboard():
    """Erzeugt ff_data/ neu (blockierend). Bricht bei Fehler mit sys.exit ab —
    fuer den Vordergrund-Pfad (--refresh, Erstlauf)."""
    step("Generiere Dashboard (Daten werden geladen – das kann 1–2 Min dauern)…")
    rc = _run_generator_subprocess()
    if rc != 0:
        print("\n✗ Fehler beim Generieren des Dashboards.")
        sys.exit(1)
    if not os.path.exists(os.path.join(DATA_ROOT, "ff_data", "config.js")):
        print("\n✗ ff_data/config.js wurde nicht erstellt.")
        sys.exit(1)
    ok("Dashboard erstellt")


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
        warn("Ein anderer Refresh laeuft bereits — uebersprungen.")
        return
    try:
        clear_contract_history_cache()
        generate_dashboard()   # generator writes its own running->done progress
        _write_progress(state="done",
                        finished_at=datetime.now().isoformat(timespec="seconds"))
    finally:
        release_refresh_lock()


def free_port(port):
    """Sucht einen freien Port ab dem gewünschten."""
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
    """Verwirft die zwischengespeicherten Einzelkontrakt-Historien.

    Diese werden erst beim Klick auf eine Kontraktzeile lazy erzeugt und sonst
    dauerhaft wiederverwendet. Bei --refresh müssen sie weg, sonst zeigen bereits
    angeklickte Einzelkontrakte nach dem Aktualisieren weiterhin alte Kurse.
    """
    import shutil
    cache_dir = os.path.join("ff_data", "contract_history")
    with _contract_cache_lock:
        if os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir, ignore_errors=True)
            ok("Einzelkontrakt-Cache geleert (wird bei Bedarf neu geladen)")


def _trim_leading_flat(rows):
    """Entfernt führende Platzhalter-Bars (Volumen 0/None und O=H=L=C), wie yfinance
    sie für noch nicht aktiv gehandelte, weit datierte Kontrakte liefert."""
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
    """Verwirft nachlaufende Bars jenseits des letzten settled EoD (nie ein Pre-Settle-Bar
    ausliefern). Gespiegelt zur Ingest-Regel im Generator; hier datumsbasiert genügt für
    den lazy Einzelkontrakt-Endpoint."""
    cutoff = _latest_settled_eod_date()
    while rows:
        d = _parse_date(rows[-1].get("date"))
        if d is not None and d > cutoff:
            rows.pop()
        else:
            break
    return rows


def _history_rows(symbol, period):
    import yfinance as yf

    ticker = yf.Ticker(symbol)
    hist = ticker.history(period=period, interval="1d")
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


def get_contract_history(symbol, period="5y"):
    """Holt und cached die Historie eines einzelnen Futures-Kontrakts."""
    cache_path = _contract_history_cache_path(symbol, period)
    with _contract_cache_lock:
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (ValueError, OSError):
                # Korrupte/abgeschnittene Cache-Datei (z.B. Absturz mitten im Schreiben):
                # verwerfen und neu erzeugen, statt bei jedem Aufruf 500 zu liefern.
                try:
                    os.remove(cache_path)
                except OSError:
                    pass

    # Netzwerk-Fetch bewusst außerhalb des Locks (langsam) — nur die FS-Ops sind serialisiert.
    history = _history_rows(symbol, period)
    payload = {
        "symbol": symbol,
        "period": period,
        "source": "yfinance",
        "contract_type": "single_expiry_month",
        "history": history,
    }
    # Ein LEERES Ergebnis nie cachen: das passiert v.a. während eines Refreshs (Cache gerade
    # geleert + Yahoo durch den Refresh gedrosselt). Würde man die leere Antwort cachen, bliebe
    # der Kontrakt bis zum nächsten Refresh leer ("No chart history"). So holt der nächste Aufruf
    # frisch — sobald Yahoo wieder liefert, steht die Historie.
    if not history:
        return payload
    with _contract_cache_lock:
        cache_dir = os.path.dirname(cache_path)
        try:
            os.makedirs(cache_dir, exist_ok=True)
            # Atomar schreiben (tempfile + os.replace), damit ein Absturz/voller Datenträger
            # keine halbe JSON-Datei hinterlässt, die jeden späteren Read crasht.
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
            pass   # Cache best-effort: bei FS-Problemen liefern wir die Historie trotzdem aus.
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


def _is_rate_limit_error(exc):
    """Best-effort 429 detection across yfinance/curl_cffi versions (the dedicated
    YFRateLimitError isn't present in every build)."""
    if "ratelimit" in type(exc).__name__.lower():
        return True
    text = str(exc).lower()
    return "429" in text or "too many requests" in text or "rate limit" in text


def _live_fetch_fn(symbol):
    """Injected into LiveQuoteCache. Returns {"day","price"} (or a None-valued row) and
    re-raises a 429 as live_cache.RateLimitedError so the breaker can trip on it."""
    try:
        row = _live_quote_row(symbol, session=_LIVE_SESSION)
    except live_cache.RateLimitedError:
        raise
    except Exception as e:
        if _is_rate_limit_error(e):
            raise live_cache.RateLimitedError(str(e))
        raise
    return row if row is not None else {"day": None, "price": None}


# One process-wide cache shared by every request thread (cross-tab + cross-poll dedup).
_live_quote_cache = live_cache.LiveQuoteCache(_live_fetch_fn)


def live_quote_payload(symbol):
    """Display-only live quote, served through the RAM-only cache. Never persisted."""
    q = _live_quote_cache.get(symbol)
    return {
        "symbol": symbol, "price": q.get("price"), "day": q.get("day"),
        "open": q.get("open"), "high": q.get("high"), "low": q.get("low"),
    }


def live_quotes_payload(symbols):
    """Batch form: one request warms/serves many symbols (e.g. the SMT tab's 3 charts)."""
    return {"quotes": _live_quote_cache.get_many(symbols)}


def live_cooldown_retry_after():
    """Seconds to back off if the breaker is open (cooldown), else 0."""
    return _live_quote_cache.retry_after() if _live_quote_cache.cooldown_active() else 0


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

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/refresh-status":
            self._send_json(200, refresh_status_payload())
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
            try:
                self._send_json(200, get_contract_history(symbol, period))
            except Exception as e:
                self._send_json(500, {"error": str(e), "symbol": symbol})
            return

        if parsed.path == "/api/live-quote":
            qs = urllib.parse.parse_qs(parsed.query)
            retry = live_cooldown_retry_after()
            symbols_raw = (qs.get("symbols") or [""])[0].strip()
            if symbols_raw:                              # batch form: ?symbols=A,B,C
                syms = [s.strip() for s in symbols_raw.split(",") if s.strip()]
                syms = [s for s in syms if re.fullmatch(r"[A-Za-z0-9_.=-]{2,32}", s)][:12]
                payload = live_quotes_payload(syms)
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
        warn(f"macOS-App-Loop nicht verfügbar ({e}) — einfacher Modus.")
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
        info = ("ChartHorizon ist bereits im Programme-Ordner installiert und wird von "
                "dort gestartet. Der Start aus dem temporären Ort kann abstürzen.")
        primary = "Aus „Programme“ starten"
    else:
        info = ("ChartHorizon läuft gerade aus einem temporären Ort (DMG bzw. Download) "
                "und kann dort abstürzen. Die App wird in den Programme-Ordner kopiert "
                "und von dort neu gestartet.")
        primary = "Verschieben & starten"
    try:
        choice = _mac_alert("ChartHorizon in den Programme-Ordner", info,
                            [primary, "Abbrechen"])
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
            _mac_alert("Verschieben fehlgeschlagen",
                       f"Bitte ziehe ChartHorizon manuell in den Programme-Ordner.\n\n{e}",
                       ["OK"])
        except Exception:
            pass


def serve(open_browser=True):
    """Startet den Webserver und öffnet den Browser (außer open_browser=False —
    für den nächtlichen Content-Bot-Lauf, der nur die HTTP-API headless braucht)."""
    global PORT
    PORT = free_port(PORT)
    url = f"http://127.0.0.1:{PORT}/{HTML_FILE}"

    step("Starte lokalen Webserver…")
    class LocalServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    try:
        httpd = LocalServer(("127.0.0.1", PORT), DashboardHandler)
    except OSError as e:
        print(f"\n✗ Port {PORT} belegt: {e}")
        sys.exit(1)

    ok(f"Server läuft auf {url}")
    print("\n" + "═" * 60)
    print(f"  Dashboard geöffnet:  {url}")
    print("  Zum Beenden:  Strg + C  (Ctrl + C)")
    print("═" * 60 + "\n")

    # The clickable macOS .app must serve from a Cocoa loop so re-opening it (Dock
    # click or double-click) reopens the browser tab. Without it the .app is a
    # window-less resident server: LaunchServices routes every later click to the
    # already-running instance, which does nothing — so it "opens only once".
    if open_browser and _should_run_mac_app():
        _serve_with_mac_app(httpd, url)
        return

    # Browser nach kurzer Verzögerung öffnen (nicht im headless/Bot-Modus).
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\n▶ Server wird beendet… Tschüss!")
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
    print("  CHARTHORIZON – LOKALER START")
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
            # Immer die aktuellsten yfinance-Daten holen (kein EoD-Skip-Gate mehr).
            # Der Generator speichert weiterhin nur settled EoD — nie Intraday.
            foreground_refresh()
        else:
            generate_dashboard()      # erster Lauf ohne Daten — unconditional
    else:
        step("Nutze vorhandene Dashboard-Dateien")
        ok("Kein neuer Daten-Download nötig")
    if args.no_serve:
        step("Datenmodus abgeschlossen")
        ok("Webserver wurde nicht gestartet")
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
