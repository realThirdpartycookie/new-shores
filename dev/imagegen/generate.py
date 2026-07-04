"""Batch-generate all game assets with FLUX.1-schnell via mflux.

Usage: .venv/bin/python generate.py [--only key1,key2] [--force]
Raw images land in raw/, ready for postprocess.py.
"""
import argparse
import os
import subprocess
import sys

from manifest import ASSETS, TEXTURES, STYLE, TEXTURE_STYLE

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
MFLUX = os.path.join(HERE, ".venv", "bin", "mflux-generate")
MODEL_ARGS = ["--model", "dhairyashil/FLUX.1-schnell-mflux-4bit", "--base-model", "schnell"]


def gen(key, prompt, seed, size, force):
    out = os.path.join(RAW, f"{key}.png")
    if os.path.exists(out) and not force:
        print(f"skip {key} (exists)")
        return True
    cmd = [MFLUX, *MODEL_ARGS, "--steps", "4",
           "--width", str(size), "--height", str(size),
           "--seed", str(seed), "--prompt", prompt, "--output", out]
    print(f"gen  {key} …", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        print(f"FAIL {key}\n{r.stdout[-800:]}\n{r.stderr[-800:]}")
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None

    os.makedirs(RAW, exist_ok=True)
    fails = []
    for a in ASSETS:
        if only and a["key"] not in only:
            continue
        if not gen(a["key"], STYLE.format(desc=a["desc"]), a["seed"], 768, args.force):
            fails.append(a["key"])
    for t in TEXTURES:
        if only and t["key"] not in only:
            continue
        if not gen(t["key"], TEXTURE_STYLE.format(desc=t["desc"]), t["seed"], 512, args.force):
            fails.append(t["key"])

    print(f"\ndone, {len(fails)} failures" + (": " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
