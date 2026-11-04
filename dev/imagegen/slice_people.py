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
    "peep_chop": (15, ["r5c1.png", "r5c2.png"]),          # raise / strike at the stump
    "peep_hammer": (16, ["r6c1.png", "r6c2.png", "r6c3.png", "r6c5.png"]),  # anvil + sparks
    "peep_bend": (15, ["r7c0.png", "r7c1.png", "r7c2.png", "r7c3.png"]),    # harvest loop
    "peep_build": (12, ["r8c0.png", "r8c1.png", "r8c2.png", "r8c3.png"]),   # kneeling crew
    "peep_idle": (15, ["r4c5.png"]),                       # neutral standing man
}


# Walkers: one Qwen-Image 2.1 sheet per character (raw/walk_<name>.png), made
# by editing that character's sheet cell into a row of strides in strict
# left-facing side profile. Qwen draws every figure of such a row mid-stride,
# so a separate edit of the widest stride into the passing pose (feet together,
# raw/walk_<name>_pass.png) supplies the contrast a gait needs: the cycle is
# stride, passing, other stride, passing. Roads run along the tile axes, which on screen are
# only ~27° off horizontal, so a profile reads right in all four directions
# (the renderer mirrors it for screen-right travel). The original sheet's
# near-frontal walkers looked like they were sidestepping.
WALK = {"peep_v0": 15, "peep_v1": 15, "peep_v2": 13, "peep_v3": 15, "peep_carrier": 15}


def walk_frames(path):
    """The four figures of a one-row sheet, left to right, trimmed."""
    rgba = remove_background(Image.open(path).convert("RGB"), tol=30.0)
    a = np.asarray(rgba)[..., 3]
    colmask = (a > 60).sum(axis=0) > 2
    runs, s = [], None
    for x, on in enumerate(list(colmask) + [False]):
        if on and s is None:
            s = x
        elif not on and s is not None:
            runs.append((s, x))
            s = None
    runs = sorted(sorted(runs, key=lambda r: (a[:, r[0]:r[1]] > 60).sum())[-4:])
    if len(runs) != 4:
        raise SystemExit(f"{path}: expected 4 figures, found {len(runs)}")
    return [trim(rgba.crop((x0, 0, x1, rgba.height)), pad=2) for x0, x1 in runs]


def leg_span(img):
    """Width of the opaque silhouette across the feet (bottom quarter)."""
    a = np.asarray(img.getchannel("A"))[img.height * 3 // 4:] > 100
    xs = np.nonzero(a.any(axis=0))[0]
    return int(xs[-1] - xs[0]) if xs.size else 0


def walk_cycle(name):
    strides = sorted(walk_frames(os.path.join(HERE, "raw", f"walk_{name}.png")), key=leg_span)[-2:]
    passing = trim(remove_background(Image.open(os.path.join(HERE, "raw", f"walk_{name}_pass.png")).convert("RGB"), tol=30.0), pad=2)
    # the passing edit started from the widest stride scaled to 640 px tall:
    # bring it back to the sheet's scale so the cycle shares one size
    k = strides[1].height / 640
    passing = passing.resize((max(2, round(passing.width * k)), round(passing.height * k)), Image.LANCZOS)
    return [strides[1], passing, strides[0], passing]


def emit():
    with open(os.path.join(OUT, "manifest.json")) as f:
        manifest = json.load(f)
    manifest["peeps"] = {}
    # every animation frame is rewritten below; drop the old ones so frames
    # of removed sets (e.g. the former single-frame back views) don't linger
    for k in [k for k in manifest["objects"] if k.startswith("peep_") and "_f" in k]:
        del manifest["objects"][k]
    # sheet cells: each frame fitted to the height; walk cycles: one scale for
    # the whole cycle (tallest frame = fith), so poses don't pulse in size
    jobs = [(n, fith, [Image.open(os.path.join(CELLS, fn)) for fn in files], False)
            for n, (fith, files) in MAPPING.items()]
    jobs += [(n, fith, walk_cycle(n[5:]), True) for n, fith in WALK.items()]
    for name, fith, imgs, shared in jobs:
        frames = []
        top = max(im.height for im in imgs)
        for i, img in enumerate(imgs):
            scale = (fith * 2) / (top if shared else img.height)
            h = max(2, round(img.height * scale))
            img = img.resize((max(2, round(img.width * scale)), h), Image.LANCZOS)
            key = f"{name}_f{i}"
            img.save(os.path.join(OUT, key + ".png"))
            manifest["objects"][key] = {
                "file": key + ".png",
                "w": round(img.width / 2, 1), "h": h / 2, "oy": h / 2,
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
