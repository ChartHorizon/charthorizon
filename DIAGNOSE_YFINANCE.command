#!/bin/zsh

# Diagnose: Liefert yfinance historische Einzelkontrakte?
# Dieses Skript stellt fest, warum die Rollover-Marker leer bleiben.
# Es laedt KEINE Dashboard-Daten neu, sondern testet nur ein paar Symbole.

cd "$(dirname "$0")/app" || exit 1
clear
echo "============================================================"
echo "  Chart Horizon – yfinance Diagnose"
echo "============================================================"
echo "Test: liefert yfinance aktuelle UND aeltere WTI-Kontrakte?"
echo "Das dauert nur ein paar Sekunden."
echo

python3 - <<'PYEOF'
try:
    import yfinance as yf
except Exception as e:
    print("yfinance ist nicht installiert:", e)
    print("Bitte einmal:  python3 -m pip install --user yfinance")
    raise SystemExit(1)

# Eine Kette aufeinanderfolgender WTI-Kontrakte ueber ~3 Jahre.
# Monatscodes: F G H J K M N Q U V X Z = Jan..Dez
symbols = [
    # juengste (sollten sicher Daten haben)
    "CLN26.NYM", "CLQ26.NYM", "CLU26.NYM",
    # ~1 Jahr alt
    "CLN25.NYM", "CLM25.NYM", "CLH25.NYM", "CLF25.NYM",
    # ~2 Jahre alt
    "CLN24.NYM", "CLH24.NYM", "CLF24.NYM",
    # ~3 Jahre alt
    "CLN23.NYM", "CLF23.NYM",
]

print(f"{'Symbol':14s} {'Bars':>6s} {'mit Volumen':>12s}  Zeitraum")
print("-" * 60)
have = 0
for s in symbols:
    try:
        h = yf.Ticker(s).history(period="5y", interval="1d")
        n = len(h)
        nv = int((h["Volume"] > 0).sum()) if n and "Volume" in h else 0
        if n:
            have += 1
            span = f"{h.index.min().date()} .. {h.index.max().date()}"
        else:
            span = "(keine Daten)"
        print(f"{s:14s} {n:>6d} {nv:>12d}  {span}")
    except Exception as e:
        print(f"{s:14s} {'ERR':>6s} {'-':>12s}  {e}")

print("-" * 60)
print(f"Ergebnis: {have} von {len(symbols)} Kontrakten liefern Daten.")
print()
if have <= 4:
    print(">> yfinance liefert fast NUR die juengsten Kontrakte.")
    print("   Das erklaert die fehlenden Rollover-Marker:")
    print("   ohne aeltere Kontrakte gibt es keine Wechsel-Kette.")
    print("   -> Loesung: Rollover-Marker aus den Verfallsdaten ableiten")
    print("      (statt aus echten Kontrakt-Volumina).")
else:
    print(">> yfinance liefert auch aeltere Kontrakte.")
    print("   Dann sollten die Rollover-Marker nach einem normalen")
    print("   DATEN_AKTUALISIEREN erscheinen. Falls nicht, bitte die")
    print("   Konsolenzeile 'chart bars: X (Y volume-led)' pruefen.")
PYEOF

echo
echo "Dieses Fenster kann jetzt geschlossen werden."
read -r "?Enter druecken zum Schliessen..."
