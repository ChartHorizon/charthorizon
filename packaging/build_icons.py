from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # dashboard/
SRC = os.path.join(ROOT, "brand", "charthorizon_logo.png")
OUT = os.path.join(ROOT, "packaging", "icons")


def _square(img: "Image.Image") -> "Image.Image":
    side = max(img.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    base = _square(Image.open(SRC).convert("RGBA"))
    base.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    base.save(
        os.path.join(OUT, "icon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    if sys.platform == "darwin":
        with tempfile.TemporaryDirectory() as td:
            iconset = os.path.join(td, "icon.iconset")
            os.makedirs(iconset)
            for sz in (16, 32, 64, 128, 256, 512):
                base.resize((sz, sz), Image.LANCZOS).save(
                    os.path.join(iconset, f"icon_{sz}x{sz}.png"))
                base.resize((sz * 2, sz * 2), Image.LANCZOS).save(
                    os.path.join(iconset, f"icon_{sz}x{sz}@2x.png"))
            subprocess.run(
                ["iconutil", "-c", "icns", "-o",
                 os.path.join(OUT, "icon.icns"), iconset],
                check=True,
            )
    print("icons ->", OUT)


if __name__ == "__main__":
    main()
