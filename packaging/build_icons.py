#!/usr/bin/env python3
"""Generate the app icons for all three installers from the brand sun-logo.

Source:  brand/charthorizon_logo.png (square, dark-navy, sunrise mark)
Output:  packaging/icons/charthorizon.icns  (macOS .app)
         packaging/icons/charthorizon.ico   (Windows .exe)
         packaging/icons/charthorizon.png    (Linux AppImage, 512px)
         packaging/icons/icon_1024.png       (master, the rounded-square artwork)

The artwork is given the macOS "icon grid" treatment: the square logo is placed in
an 824x824 rounded rectangle (Apple's continuous-corner radius approximation) centred
on a transparent 1024x1024 canvas, so it sits as a native-looking rounded app tile
instead of a sharp full-bleed square.

Dev tool — needs Pillow (`pip install pillow`) + macOS `iconutil` for the .icns.
Re-run after changing the brand logo:  python3 packaging/build_icons.py
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "brand", "charthorizon_logo.png")
OUT = os.path.join(REPO, "packaging", "icons")

CANVAS = 1024          # full icon canvas
TILE = 824             # rounded-square artwork size within the canvas (Apple grid)
RADIUS = 185           # ~0.2237 * TILE — continuous-corner squircle approximation
MARGIN = (CANVAS - TILE) // 2


def build_master():
    """The rounded-square 1024 master used to derive every other size."""
    src = Image.open(SRC).convert("RGBA").resize((TILE, TILE), Image.LANCZOS)
    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=RADIUS, fill=255)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(src, (MARGIN, MARGIN), mask)
    canvas.save(os.path.join(OUT, "icon_1024.png"))
    return canvas


def build_icns(master):
    """macOS .icns via an .iconset + iconutil (mac-only tool)."""
    if sys.platform != "darwin":
        print("  · skipping .icns (iconutil is macOS-only)")
        return
    iconset = os.path.join(OUT, "charthorizon.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]
    for size, name in specs:
        master.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.check_call(["iconutil", "-c", "icns", iconset,
                           "-o", os.path.join(OUT, "charthorizon.icns")])
    for name in os.listdir(iconset):
        os.remove(os.path.join(iconset, name))
    os.rmdir(iconset)
    print("  ✓ charthorizon.icns")


def build_ico(master):
    """Windows .ico (PIL packs the multi-size icon; .ico maxes at 256)."""
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(os.path.join(OUT, "charthorizon.ico"), sizes=sizes)
    print("  ✓ charthorizon.ico")


def build_linux_png(master):
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "charthorizon.png"))
    print("  ✓ charthorizon.png (512)")


def main():
    os.makedirs(OUT, exist_ok=True)
    master = build_master()
    build_icns(master)
    build_ico(master)
    build_linux_png(master)
    print("Done — icons in packaging/icons/")


if __name__ == "__main__":
    main()
