#!/bin/zsh

# Diagnostic: does yfinance return historical single contracts?
# This script determines why the rollover markers stay empty.
# It does NOT reload any dashboard data — it only tests a few symbols.

cd "$(dirname "$0")/app" || exit 1
clear
echo "============================================================"
echo "  Chart Horizon – yfinance diagnostic"
echo "============================================================"
echo "Test: does yfinance return current AND older WTI contracts?"
echo "This only takes a few seconds."
echo

python3 - <<'PYEOF'
try:
    import yfinance as yf
except Exception as e:
    print("yfinance is not installed:", e)
    print("Please run once:  python3 -m pip install --user yfinance")
    raise SystemExit(1)

# A chain of consecutive WTI contracts over ~3 years.
# Month codes: F G H J K M N Q U V X Z = Jan..Dec
symbols = [
    # newest (should definitely have data)
    "CLN26.NYM", "CLQ26.NYM", "CLU26.NYM",
    # ~1 year old
    "CLN25.NYM", "CLM25.NYM", "CLH25.NYM", "CLF25.NYM",
    # ~2 years old
    "CLN24.NYM", "CLH24.NYM", "CLF24.NYM",
    # ~3 years old
    "CLN23.NYM", "CLF23.NYM",
]

print(f"{'Symbol':14s} {'Bars':>6s} {'with volume':>12s}  Range")
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
            span = "(no data)"
        print(f"{s:14s} {n:>6d} {nv:>12d}  {span}")
    except Exception as e:
        print(f"{s:14s} {'ERR':>6s} {'-':>12s}  {e}")

print("-" * 60)
print(f"Result: {have} of {len(symbols)} contracts return data.")
print()
if have <= 4:
    print(">> yfinance returns almost ONLY the newest contracts.")
    print("   That explains the missing rollover markers:")
    print("   without older contracts there is no rollover chain.")
    print("   -> Fix: derive rollover markers from expiry dates")
    print("      (instead of from real contract volumes).")
else:
    print(">> yfinance also returns older contracts.")
    print("   Then the rollover markers should appear after a normal")
    print("   UPDATE_DATA run. If not, please check the")
    print("   console line 'chart bars: X (Y volume-led)'.")
PYEOF

echo
echo "You can close this window now."
read -r "?Press Enter to close..."
