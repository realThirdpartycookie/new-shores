"""Slice the Nano-Banana character sheet into per-cell sprites.

Pass 1 (--cells): background-remove the whole sheet, detect the 9 row bands
and the figure clusters inside each, save every cell to raw_people/ and a
labelled contact sheet for review.
Pass 2 (--emit): apply MAPPING (curated after review) to write animation
frames into ../../assets/ and extend the manifest with a "peeps" section.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

from postprocess import remove_background, trim

HERE = os.path.dirname(os.path.abspath(__file__))
SHEET = os.path.join(HERE, "raw", "peoplesheet.png")
CELLS = os.path.join(HERE, "raw_people")
OUT = os.path.join(HERE, "..", "..", "assets")

LABEL_MARGIN = 0.085  # left strip with the row labels, cropped away


def detect_cells():
    img = Image.open(SHEET).convert("RGB")
    img = img.crop((int(img.width * LABEL_MARGIN), 0, img.width, img.height))
    rgba = remove_background(img, tol=30.0)
    a = np.asarray(rgba)[..., 3]

    # rows: bands of consecutive lines that contain any figure pixels
    rowmask = (a > 60).sum(axis=1) > 3
    bands, start = [], None
    for y, on in enumerate(rowmask):
        if on and start is None:
            start = y
        elif not on and start is not None:
            if y - start > 40:
                bands.append((start, y))
            start = None
    if start is not None:
        bands.append((start, len(rowmask)))

    cells = {}
    for ri, (y0, y1) in enumerate(bands):
        colmask = (a[y0:y1] > 60).sum(axis=0) > 2
        runs, s = [], None
        for x, on in enumerate(colmask):
            if on and s is None:
                s = x
            elif not on and s is not None:
                if x - s > 18:
                    runs.append((s, x))
                s = None
        if s is not None:
            runs.append((s, len(colmask)))
        for ci, (x0, x1) in enumerate(runs):
            cell = rgba.crop((x0, y0, x1, y1))
            cell = trim(cell, pad=2)
            cells[(ri, ci)] = cell
    return cells


def save_cells(cells):
    os.makedirs(CELLS, exist_ok=True)
    for (ri, ci), img in sorted(cells.items()):
        img.save(os.path.join(CELLS, f"r{ri}c{ci}.png"))
    # contact sheet
    CW, CH = 120, 150
    rows = max(r for r, _ in cells) + 1
    cols = max(c for _, c in cells) + 1
    sheet = Image.new("RGB", (cols * CW, rows * CH), "#cccccc")
    d = ImageDraw.Draw(sheet)
    for (ri, ci), img in cells.items():
        t = img.copy()
        t.thumbnail((CW - 8, CH - 22))
        sheet.paste(t, (ci * CW + 4, ri * CH + 4), t)
        d.text((ci * CW + 6, ri * CH + CH - 16), f"r{ri}c{ci} {img.width}x{img.height}", fill="#111111")
    p = os.path.join(HERE, "people-cells.jpg")
    sheet.save(p, quality=90)
    print(p, f"({len(cells)} cells)")


# name -> (target logical height, [cell files in frame order])
# Curated from people-cells.jpg. Ping-pong frame orders dodge the sheet's
# mid-row drift (skin/outfit changes in later columns).
MAPPING = {
    "peep_v0": (15, ["r0c0.png", "r0c1.png", "r0c2.png", "r0c1.png"]),
    "peep_v1": (15, ["r1c0.png", "r1c1.png", "r1c2.png", "r1c3.png"]),
    "peep_v2": (13, ["r2c0.png", "r2c1.png", "r2c2.png", "r2c3.png"]),
    "peep_v3": (15, ["r3c0.png", "r3c1.png", "r3c2.png", "r3c1.png"]),
    "peep_carrier": (15, ["r4c0.png", "r4c1.png", "r4c2.png", "r4c1.png"]),
    "peep_chop": (15, ["r5c1.png", "r5c2.png"]),          # raise / strike at the stump
    "peep_hammer": (16, ["r6c1.png", "r6c2.png", "r6c3.png", "r6c5.png"]),  # anvil + sparks
    "peep_bend": (15, ["r7c0.png", "r7c1.png", "r7c2.png", "r7c3.png"]),    # harvest loop
    "peep_build": (12, ["r8c0.png", "r8c1.png", "r8c2.png", "r8c3.png"]),   # kneeling crew
    "peep_idle": (15, ["r4c5.png"]),                       # neutral standing man
    # interim back views (single frame from the sheet's 7th column) — replaced
    # with real back-view walk cycles when a second sheet is generated
    "peep_v0_back": (15, ["r0c6.png"]),
    "peep_v1_back": (15, ["r1c6.png"]),
    "peep_v2_back": (13, ["r2c6.png"]),
    "peep_v3_back": (15, ["r3c6.png"]),
    "peep_carrier_back": (15, ["r4c6.png"]),
}


def emit():
    with open(os.path.join(OUT, "manifest.json")) as f:
        manifest = json.load(f)
    manifest["peeps"] = {}
    for name, (fith, files) in MAPPING.items():
        frames = []
        for i, fn in enumerate(files):
            img = Image.open(os.path.join(CELLS, fn))
            scale = (fith * 2) / img.height
            img = img.resize((max(2, round(img.width * scale)), fith * 2), Image.LANCZOS)
            key = f"{name}_f{i}"
            img.save(os.path.join(OUT, key + ".png"))
            manifest["objects"][key] = {
                "file": key + ".png",
                "w": round(img.width / 2, 1), "h": fith, "oy": fith,
            }
            frames.append(key)
        manifest["peeps"][name] = frames
        print(f"ok  {name}: {len(frames)} frames @ h{fith}")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    with open(os.path.join(OUT, "manifest.js"), "w") as f:
        f.write("const ASSET_MANIFEST = " + json.dumps(manifest, indent=1) + ";\n")
    print("manifest updated")


if __name__ == "__main__":
    if "--emit" in sys.argv:
        emit()
    else:
        save_cells(detect_cells())
