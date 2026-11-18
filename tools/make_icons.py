"""Regenerate the checked-in desktop icons with Pillow (artwork tool only)."""

from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
assets = root / "assets"
assets.mkdir(exist_ok=True)
im = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(im)
draw.rounded_rectangle((44, 44, 980, 980), radius=210, fill="#15383b")
draw.polygon([(390, 180), (634, 180), (844, 390), (844, 634),
              (634, 844), (390, 844), (180, 634), (180, 390)], fill="#245256")
points = [(244, 644), (430, 456), (547, 555), (773, 329)]
draw.line(points, fill="#93e6be", width=46, joint="curve")
for x, y in points:
    draw.ellipse((x - 24, y - 24, x + 24, y + 24), fill="#93e6be")
im.save(assets / "octogens.ico", sizes=[(v, v) for v in (16, 24, 32, 48, 64, 128, 256)])
im.save(assets / "octogens.icns")
im.resize((96, 96), Image.Resampling.LANCZOS).save(root / "octogens/icon.png")
