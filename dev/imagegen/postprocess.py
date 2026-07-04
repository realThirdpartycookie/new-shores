"""Turn raw diffusion output into game-ready sprites.

Objects:  flood-fill the near-white background from the borders -> alpha,
          decontaminate white fringes, trim, downscale to 2x logical size.
Textures: make seamless by wrap-shift + edge blend, downscale to 256.
Writes    ../../assets/*.png and ../../assets/manifest.json.
"""
import json
import os
from collections import deque

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

from manifest import ASSETS, TEXTURES

# (saturation, brightness) trims so the terrain doesn't overpower the sprites
TEX_ADJUST = {
    "tex_water": (0.62, 0.78),
    "tex_grass": (0.80, 0.92),
    "tex_deep": (0.90, 1.15),
    "tex_sand": (0.85, 0.97),
}


def strip_ground(img, frac=0.42):
    """Amputate the baked ground pad under free-standing sprites (trees):
    from the bottom up, clear rows while their opaque span is wider than
    `frac` of the image — the pad is much wider than the trunk."""
    a = np.array(img)
    alpha = a[..., 3]
    w = a.shape[1]
    for y in range(a.shape[0] - 1, -1, -1):
        row = alpha[y]
        xs = np.nonzero(row > 40)[0]
        if xs.size == 0:
            continue
        if xs[-1] - xs[0] > w * frac:
            a[y, :, 3] = 0
        else:
            break
    return Image.fromarray(a, "RGBA")

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "..", "..", "assets")


def remove_background(img, tol=34.0):
    """Flood-fill from the borders across near-background pixels."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    passable = dist < tol

    mask = np.zeros((h, w), dtype=bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if passable[y, x] and not mask[y, x]:
                mask[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if passable[y, x] and not mask[y, x]:
                mask[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and passable[ny, nx] and not mask[ny, nx]:
                mask[ny, nx] = True
                dq.append((ny, nx))

    alpha = np.where(mask, 0, 255).astype(np.uint8)
    # soften the cut edge by one pixel
    a_img = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.7))
    alpha_f = np.asarray(a_img, dtype=np.float32) / 255.0
    # decontaminate: un-blend the background colour from semi-transparent edges
    a3 = alpha_f[..., None]
    safe = np.maximum(a3, 0.15)
    clean = np.clip((rgb - bg * (1 - a3)) / safe, 0, 255)
    out = np.dstack([clean, alpha_f[..., None] * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def trim(img, pad=3):
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    return img.crop((max(0, l - pad), max(0, t - pad),
                     min(img.width, r + pad), min(img.height, b + pad)))


def make_seamless(img):
    """Offset by half and blend the seam cross for tileability."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape
    shifted = np.roll(np.roll(rgb, h // 2, axis=0), w // 2, axis=1)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = np.minimum(np.abs(xx - w / 2), np.minimum(xx, w - xx)) / (w / 4)
    dy = np.minimum(np.abs(yy - h / 2), np.minimum(yy, h - yy)) / (h / 4)
    blend = np.clip(1 - np.minimum(dx, dy), 0, 1) ** 2  # 1 near seam cross
    out = shifted * (1 - blend[..., None]) + np.roll(np.roll(shifted, 7, axis=0), 11, axis=1) * blend[..., None]
    return Image.fromarray(out.astype(np.uint8), "RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"objects": {}, "textures": {}}

    for a in ASSETS:
        src = os.path.join(RAW, a["key"] + ".png")
        if not os.path.exists(src):
            print(f"missing raw/{a['key']}.png — skipped")
            continue
        img = remove_background(Image.open(src))
        if a.get("strip"):
            img = strip_ground(img)
        img = trim(img)
        if "fith" in a:  # people: fit by height, width follows the figure
            scale = (a["fith"] * 2) / img.height
            target_w = max(2, round(img.width * scale))
        else:
            target_w = a["w"] * 2  # stored at 2x logical size
            scale = target_w / img.width
        img = img.resize((target_w, max(2, round(img.height * scale))), Image.LANCZOS)
        img.save(os.path.join(OUT, a["key"] + ".png"))
        lw, lh = img.width / 2, img.height / 2
        oyk = a.get("oyk", 0.96)
        manifest["objects"][a["key"]] = {
            "file": a["key"] + ".png",
            "w": lw, "h": round(lh, 1), "oy": round(lh * oyk, 1),
        }
        print(f"ok  {a['key']}  {lw}x{round(lh)}")

    for t in TEXTURES:
        src = os.path.join(RAW, t["key"] + ".png")
        if not os.path.exists(src):
            print(f"missing raw/{t['key']}.png — skipped")
            continue
        img = make_seamless(Image.open(src)).resize((256, 256), Image.LANCZOS)
        if t["key"] in TEX_ADJUST:
            sat, bri = TEX_ADJUST[t["key"]]
            img = ImageEnhance.Color(img).enhance(sat)
            img = ImageEnhance.Brightness(img).enhance(bri)
        img.save(os.path.join(OUT, t["key"] + ".png"))
        manifest["textures"][t["key"]] = {"file": t["key"] + ".png", "size": 256}
        print(f"ok  {t['key']}  256x256 seamless")

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    # file:// pages cannot fetch() JSON — ship the manifest as a script too
    with open(os.path.join(OUT, "manifest.js"), "w") as f:
        f.write("const ASSET_MANIFEST = " + json.dumps(manifest, indent=1) + ";\n")
    print("manifest.json + manifest.js written")


if __name__ == "__main__":
    main()
