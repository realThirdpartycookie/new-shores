"""Grid overview of all raw generations for quick visual review."""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")

CELL = 190
files = sorted(f for f in os.listdir(RAW) if f.endswith(".png"))
cols = 7
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * CELL, rows * (CELL + 16)), "#dddddd")
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    img = Image.open(os.path.join(RAW, f)).convert("RGB")
    img.thumbnail((CELL - 6, CELL - 6))
    x = (i % cols) * CELL, (i // cols) * (CELL + 16)
    sheet.paste(img, (x[0] + 3, x[1] + 3))
    d.text((x[0] + 5, x[1] + CELL - 2), f[:-4], fill="#222222")
out = os.path.join(HERE, "contactsheet.jpg")
sheet.save(out, quality=88)
print(out, f"({len(files)} images)")
