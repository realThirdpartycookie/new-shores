"""Turn raw diffusion output into game-ready sprites.

Objects:  flood-fill the near-white background from the borders -> alpha,
          decontaminate white fringes, trim, downscale to 2x logical size.
Textures: make seamless by wrap-shift + edge blend, downscale to 256.
Writes    ../../assets/*.png and ../../assets/manifest.json.
"""
import argparse
import json
import os
from collections import deque

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

from manifest import ASSETS, ICONS, TEXTURES

# (saturation, brightness) trims so the terrain doesn't overpower the sprites
TEX_ADJUST = {
    "tex_water": (0.62, 0.78),
    "tex_grass": (0.80, 0.92),
    "tex_deep": (0.90, 1.15),
    "tex_sand": (0.85, 0.97),
    "tex_dirt": (0.85, 1.0),
}


def strip_ground(img, frac=0.42, tol=85.0):
    """Amputate the baked ground pad under free-standing sprites (trees).

    The pad is an isometric diamond, so its bottom rows are a narrow tip —
    scanning up only while rows are wide stops at once. Instead find the
    pad's widest row in the bottom third (its left/right corners): clear
    everything below it, and above it clear only pad-coloured pixels inside
    the diamond's back half, which leaves the trunk standing."""
    a = np.array(img)
    alpha = a[..., 3]
    h, w = alpha.shape
    rows = np.nonzero(alpha.max(axis=1) > 40)[0]
    if rows.size == 0:
        return img
    top, bottom = int(rows[0]), int(rows[-1])
    spans = np.zeros(h)
    # bottom third only: a wide canopy higher up is not a ground pad
    for y in range(bottom - (bottom - top) // 3, bottom + 1):
        xs = np.nonzero(alpha[y] > 40)[0]
        if xs.size:
            spans[y] = xs[-1] - xs[0]
    ym = int(np.argmax(spans))
    # a pad tapers to its bottom tip; a canopy edge drops straight to a trunk
    mid = (ym + bottom) // 2
    xs_mid = np.nonzero(alpha[mid] > 40)[0]
    mid_span = xs_mid[-1] - xs_mid[0] if xs_mid.size else 0
    if spans[ym] <= w * frac or mid_span < spans[ym] * 0.3:
        return img  # no pad
    xs = np.nonzero(alpha[ym] > 40)[0]
    x0, x1 = xs[0], xs[-1]
    half_h = max(1, bottom - ym)
    # pad colour sampled just inside the two corners
    rgb = a[..., :3].astype(np.float32)
    k = max(2, (x1 - x0) // 12)
    samp = np.concatenate([rgb[ym - 2:ym + 3, x0 + 2:x0 + k].reshape(-1, 3),
                           rgb[ym - 2:ym + 3, x1 - k:x1 - 1].reshape(-1, 3)])
    pad = np.median(samp, axis=0)
    near_pad = np.sqrt(((rgb - pad) ** 2).sum(axis=2)) < tol
    cx = (x0 + x1) / 2
    yy, xx = np.mgrid[0:h, 0:w]
    in_back = (yy <= ym) & (np.abs(xx - cx) / ((x1 - x0) / 2) + (ym - yy) / half_h <= 1.05)
    a[ym:, :, 3] = 0
    a[in_back & near_pad, 3] = 0
    return Image.fromarray(a, "RGBA")

# sprites without a built footprint (nature, ships, people): nothing to fit
FREE_STANDING = ("tree", "rock", "ship", "pirateship", "boat", "peep")


def base_slopes(img):
    """Slopes of the lower-left and lower-right silhouette edges and the
    front corner's offset from centre (fraction of width). Translucent cast
    shadow is ignored."""
    a = np.asarray(img.getchannel("A")) > 160
    w = a.shape[1]
    has = a.any(axis=0)
    bot = np.where(has, a.shape[0] - 1 - np.argmax(a[::-1], axis=0), -1).astype(float)
    cols = np.nonzero(has)[0]
    x0, x1 = cols[0], cols[-1]
    vx = int(np.median(np.nonzero(bot >= bot.max() - 2)[0]))

    def slope(xa, xb):
        xs = np.arange(int(xa), int(xb))
        xs = xs[bot[xs] >= 0]
        return np.polyfit(xs, bot[xs], 1)[0] if xs.size > 4 else 0.5

    left = slope(x0 + (vx - x0) * 0.15, x0 + (vx - x0) * 0.85)
    right = -slope(vx + (x1 - vx) * 0.15, vx + (x1 - vx) * 0.85)
    return left, right, (vx - w / 2) / w


def iso_fit(img):
    """Vertical scale that lays the sprite's footprint onto the game's 2:1
    tile diamonds. FLUX's 'isometric' camera sits higher (base edges ~0.6-0.7
    instead of 0.5), so unfitted buildings poke out of their tiles."""
    left, right, _ = base_slopes(img)
    s = (left + right) / 2
    return float(np.clip(0.5 / s, 0.72, 1.0)) if s > 0.3 else 1.0


def centre_corner(img, max_off=0.12):
    """The renderer centres a sprite on its footprint, so pad one side until
    the front corner sits mid-image. Larger offsets mean the 'corner' is a
    stray prop rather than the footprint — leave those alone."""
    off = base_slopes(img)[2]
    if abs(off) < 0.015 or abs(off) > max_off:
        return img
    pad = round(abs(off) * img.width * 2)
    out = Image.new("RGBA", (img.width + pad, img.height), (0, 0, 0, 0))
    out.paste(img, (pad if off < 0 else 0, 0))
    return out


def clip_ground(img, size, oyk, tol=2):
    """Cut the painted ground (plinth, yard, cast shadow) back to the
    footprint diamond. The art's plot is a little wider than its tiles, and
    since buildings are drawn back to front, that spill would paint over the
    lower part of the neighbour behind. Only pixels below the side corners
    are touched, so eaves and roofs keep their overhang."""
    a = np.array(img)
    h, w = a.shape[:2]
    cx, ay = w / 2, h * oyk           # front corner = the renderer's anchor
    hw, hh = 64 * size, 32 * size     # half footprint, in 2x pixels
    yy, xx = np.mgrid[0:h, 0:w]
    dx = np.abs(xx + 0.5 - cx)
    outside = (dx > hw + tol) | (yy > ay - dx * hh / hw + tol)
    a[(yy > ay - hh) & outside, 3] = 0
    return Image.fromarray(a, "RGBA")


HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "..", "..", "assets")


def remove_background(img, tol=34.0, holes=False):
    """Flood-fill from the borders across near-background pixels.
    holes=True also clears enclosed background (gaps between branches)."""
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

    if holes:
        mask |= passable
    # The model paints soft grey cast shadows onto the white backdrop. Left
    # opaque they read as pale slabs on the terrain; keep them as translucent
    # dark shadow instead. Grow from the background across light, colourless
    # pixels so neutral areas inside the subject are never touched.
    bg_lum = float(bg.mean())
    lum = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    neutral = (chroma < 22) & (lum > 120) & ~mask
    shadow = np.zeros((h, w), dtype=bool)
    dq.extend(zip(*np.nonzero(mask & ndi_edge(mask))))
    while dq:
        y, x = dq.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and neutral[ny, nx] and not shadow[ny, nx]:
                shadow[ny, nx] = True
                dq.append((ny, nx))
    sh_a = np.where(shadow, np.clip((bg_lum - lum) / bg_lum * 2.2, 0, 0.55), 0)

    alpha = np.where(mask | shadow, 0, 255).astype(np.uint8)
    # soften the cut edge by one pixel
    a_img = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.7))
    alpha_f = np.asarray(a_img, dtype=np.float32) / 255.0
    # decontaminate: un-blend the background colour from semi-transparent edges
    a3 = alpha_f[..., None]
    safe = np.maximum(a3, 0.15)
    clean = np.clip((rgb - bg * (1 - a3)) / safe, 0, 255)
    # composite the shadow underneath (cool dark tone, soft edge)
    sh_a = np.asarray(Image.fromarray((sh_a * 255).astype(np.uint8), "L")
                      .filter(ImageFilter.GaussianBlur(1.5)), dtype=np.float32) / 255.0
    sh_a = sh_a * (1 - alpha_f)
    tot = alpha_f + sh_a
    col = (clean * alpha_f[..., None] + np.array([22, 26, 40]) * sh_a[..., None]) / np.maximum(tot, 1e-6)[..., None]
    out = np.dstack([col, tot[..., None] * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def ndi_edge(mask):
    """Pixels of `mask` with at least one 4-neighbour outside it."""
    m = np.pad(mask, 1, constant_values=True)
    inner = m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
    return ~inner


def trim(img, pad=3):
    """Crop to the subject (translucent cast shadow doesn't count, so it
    can't change the sprite's scale or centre); shadow running past the
    crop fades out over the pad instead of ending in a hard edge."""
    bbox = img.getchannel("A").point(lambda v: 255 if v > 160 else 0).getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    img = img.crop((max(0, l - pad), max(0, t - pad),
                    min(img.width, r + pad), min(img.height, b + pad)))
    a = np.array(img)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
    fade = np.clip(edge / max(1, pad), 0, 1)
    a[..., 3] = (a[..., 3] * np.where(a[..., 3] > 160, 1, fade)).astype(np.uint8)
    return Image.fromarray(a, "RGBA")


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None

    os.makedirs(OUT, exist_ok=True)
    manifest = {"objects": {}, "textures": {}}
    # previous manifest: preserves entries this run doesn't rebuild (see below)
    try:
        with open(os.path.join(OUT, "manifest.json")) as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}

    for a in ASSETS:
        if only and a["key"] not in only:
            continue
        src = os.path.join(RAW, a["key"] + ".png")
        if not os.path.exists(src):
            print(f"missing raw/{a['key']}.png — skipped")
            continue
        img = remove_background(Image.open(src), holes=a["key"].startswith("tree"))
        if a.get("strip"):
            img = strip_ground(img)
        img = trim(img)
        if "fith" in a:  # people: fit by height, width follows the figure
            scale = (a["fith"] * 2) / img.height
            target_w = max(2, round(img.width * scale))
        else:
            target_w = a["w"] * 2  # stored at 2x logical size
            scale = target_w / img.width
        sy = scale
        if not a["key"].startswith(FREE_STANDING):
            sy *= iso_fit(img)
        img = img.resize((target_w, max(2, round(img.height * sy))), Image.LANCZOS)
        if not a["key"].startswith(FREE_STANDING):
            img = centre_corner(img)
            img = clip_ground(img, 2 if a["w"] > 100 else 1, a.get("oyk", 0.96))
        img.save(os.path.join(OUT, a["key"] + ".png"))
        lw, lh = img.width / 2, img.height / 2
        oyk = a.get("oyk", 0.96)
        manifest["objects"][a["key"]] = {
            "file": a["key"] + ".png",
            "w": lw, "h": round(lh, 1), "oy": round(lh * oyk, 1),
        }
        print(f"ok  {a['key']}  {lw}x{round(lh)}")

    manifest["icons"] = {}
    for i in ICONS:
        if only and i["key"] not in only:
            continue
        src = os.path.join(RAW, i["key"] + ".png")
        if not os.path.exists(src):
            print(f"missing raw/{i['key']}.png — skipped")
            continue
        img = trim(remove_background(Image.open(src)), pad=6)
        side = max(img.width, img.height)  # pad to square, keep centred
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        sq = sq.resize((64, 64), Image.LANCZOS)
        sq.save(os.path.join(OUT, i["key"] + ".png"))
        manifest["icons"][i["key"]] = {"file": i["key"] + ".png"}
        print(f"ok  {i['key']}  64x64")

    for t in TEXTURES:
        if only and t["key"] not in only:
            continue
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

    # Merge back old entries this run didn't rebuild — slice_people.py's
    # animation frames, and any section skipped because its raw/ input was
    # absent — but only while the PNG still exists.
    for sec in ("objects", "textures", "icons"):
        for k, v in old.get(sec, {}).items():
            fn = v.get("file")
            if k not in manifest[sec] and fn and os.path.exists(os.path.join(OUT, fn)):
                manifest[sec][k] = v
    if old.get("peeps"):
        manifest["peeps"] = old["peeps"]

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    # file:// pages cannot fetch() JSON — ship the manifest as a script too
    with open(os.path.join(OUT, "manifest.js"), "w") as f:
        f.write("const ASSET_MANIFEST = " + json.dumps(manifest, indent=1) + ";\n")
    print("manifest.json + manifest.js written")


if __name__ == "__main__":
    main()
