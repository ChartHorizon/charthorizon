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
    python3 start.py            (schnell starten)
    python3 start.py --refresh  (EoD-Daten laden, falls der Zieltag noch fehlt)
    python3 start.py --refresh --force-refresh  (Daten-Download erzwingen)
    python3 start.py --refresh --no-serve  (nur EoD-Update, kein Webserver)

  Beenden:  Strg + C  (Ctrl + C)
═══════════════════════════════════════════════════════════════════════
"""

import os
import sys
import argparse
import subprocess
import threading
import webbrowser
import http.server
import socketserver
import json
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
REFRESH_STATE_FILE = os.path.join("ff_data", "refresh_state.json")
YFINANCE_EOD_READY_ET = time(17, 30)

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


def expected_yfinance_eod_date(now_et=None):
    """Business date that should be available from yfinance by now.

    We use 17:30 ET as a practical delay buffer after the US futures close.
    Before that, today's EoD bar is not expected yet, so the previous business
    day is considered current.
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


def latest_price_date_from_quality():
    """Latest price-history end date in ff_data/data_quality.json."""
    path = os.path.join("ff_data", "data_quality.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return None
    latest = None
    for market in (payload.get("markets") or {}).values():
        price = market.get("price") or {}
        health = price.get("health") or {}
        end = _parse_date(health.get("end"))
        if end and (latest is None or end > latest):
            latest = end
    return latest


def eod_refresh_status():
    """Whether the local yfinance EoD files already cover the expected date."""
    now_et = _eastern_now()
    target = expected_yfinance_eod_date(now_et)
    latest = latest_price_date_from_quality()
    return {
        "is_current": bool(latest and latest >= target),
        "now_et": now_et,
        "target": target,
        "latest": latest,
    }


def write_refresh_state(status):
    """Small audit file for the local EoD refresh gate."""
    os.makedirs(os.path.dirname(REFRESH_STATE_FILE), exist_ok=True)
    now_et = _eastern_now()
    target = expected_yfinance_eod_date(now_et)
    latest = latest_price_date_from_quality()
    payload = {
        "last_checked_at": datetime.now().isoformat(timespec="seconds"),
        "last_checked_at_et": now_et.isoformat(timespec="seconds"),
        "status": status,
        "target_eod_date": target.isoformat(),
        "latest_price_date": latest.isoformat() if latest else None,
        "current_for_target": bool(latest and latest >= target),
        "yfinance_eod_rule": "target advances after 17:30 ET; before that it uses the previous business day",
    }
    with open(REFRESH_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def generate_dashboard():
    """Erzeugt ff_data/ neu. Dev: ruft commodity_dashboard.py als Subprozess.
    Frozen: re-exec't das gebündelte Binary mit --run-generator (gleiche Prozess-Isolation,
    aber ohne System-Python)."""
    step("Generiere Dashboard (Daten werden geladen – das kann 1–2 Min dauern)…")
    cmd = [sys.executable, "--run-generator"] if FROZEN else [sys.executable, GENERATOR]
    if not FROZEN and not os.path.exists(GENERATOR):
        print(f"\n✗ {GENERATOR} nicht gefunden!")
        sys.exit(1)
    try:
        subprocess.check_call(cmd, cwd=DATA_ROOT)
    except subprocess.CalledProcessError:
        print("\n✗ Fehler beim Generieren des Dashboards.")
        sys.exit(1)
    if not os.path.exists(os.path.join(DATA_ROOT, "ff_data", "config.js")):
        print("\n✗ ff_data/config.js wurde nicht erstellt.")
        sys.exit(1)
    ok("Dashboard erstellt")


def free_port(port):
    """Sucht einen freien Port ab dem gewünschten."""
    import socket
    for p in range(port, port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return port


def _contract_history_cache_path(symbol, period):
    safe_symbol = re.sub(r"[^A-Za-z0-9_.=-]+", "_", symbol)
    safe_period = re.sub(r"[^A-Za-z0-9_.=-]+", "_", period)
    cache_dir = os.path.join("ff_data", "contract_history")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, f"{safe_symbol}_{safe_period}.json")


def clear_contract_history_cache():
    """Verwirft die zwischengespeicherten Einzelkontrakt-Historien.

    Diese werden erst beim Klick auf eine Kontraktzeile lazy erzeugt und sonst
    dauerhaft wiederverwendet. Bei --refresh müssen sie weg, sonst zeigen bereits
    angeklickte Einzelkontrakte nach dem Aktualisieren weiterhin alte Kurse.
    """
    import shutil
    cache_dir = os.path.join("ff_data", "contract_history")
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
    cutoff = expected_yfinance_eod_date()
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
        rows.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open": round(float(o), 4),
            "high": round(float(h), 4),
            "low": round(float(l), 4),
            "close": round(float(c), 4),
            "volume": int(volume) if volume == volume else None,
        })
    return _drop_unsettled_tail(_trim_leading_flat(rows))


def get_contract_history(symbol, period="5y"):
    """Holt und cached die Historie eines einzelnen Futures-Kontrakts."""
    cache_path = _contract_history_cache_path(symbol, period)
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    payload = {
        "symbol": symbol,
        "period": period,
        "source": "yfinance",
        "contract_type": "single_expiry_month",
        "history": _history_rows(symbol, period),
    }
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return payload


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
        # Local dev server: force revalidation of static assets (HTML/JS/CSS) so an
        # edited frontend file shows up on a normal reload instead of being served
        # stale from the browser's heuristic cache. SimpleHTTPRequestHandler answers
        # If-Modified-Since with 304, so this stays cheap. The JSON API sets its own
        # Cache-Control (no-store) in _send_json, so skip that path to avoid a dupe.
        if urllib.parse.urlparse(self.path).path != "/api/contract-history":
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

        super().do_GET()


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
        write_refresh_state("refreshed")
    except SystemExit:
        pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--force-refresh", action="store_true")
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

    check_python()
    ensure_packages()
    if (args.refresh or not dashboard_exists()) and not (FROZEN and not dashboard_exists() and not args.refresh):
        if args.refresh and dashboard_exists() and not args.force_refresh:
            status = eod_refresh_status()
            if status["is_current"]:
                step("Prüfe EoD-Aktualisierung")
                ok(
                    "Yfinance EoD-Daten sind aktuell "
                    f"(Ziel {status['target'].isoformat()}, lokal bis {status['latest'].isoformat()})"
                )
                info("Kein neuer API-Download nötig")
                write_refresh_state("skipped_current")
            else:
                target = status["target"].isoformat()
                latest = status["latest"].isoformat() if status["latest"] else "keine Daten"
                info(f"EoD-Refresh nötig (Ziel {target}, lokal bis {latest})")
                clear_contract_history_cache()
                generate_dashboard()
                write_refresh_state("refreshed")
        else:
            if args.refresh and args.force_refresh:
                info("Force refresh: EoD-Skip-Regel wird ignoriert")
            if args.refresh:
                clear_contract_history_cache()
            generate_dashboard()
            write_refresh_state("refreshed")
    else:
        step("Nutze vorhandene Dashboard-Dateien")
        ok("Kein neuer Daten-Download nötig")
    if args.no_serve:
        step("Datenmodus abgeschlossen")
        ok("Webserver wurde nicht gestartet")
        return

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
