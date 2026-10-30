#!/usr/bin/env python3
"""Pixel diff helper for UI preview screenshots.

Requires Pillow: python3 -m pip install Pillow

Usage:
  python3 pixel-diff.py before.png after.png --out diff.png
  python3 pixel-diff.py before.png after.png --threshold 16 --json
"""
import argparse
import json
import sys

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two PNG screenshots")
    parser.add_argument("before")
    parser.add_argument("after")
    parser.add_argument("--out", help="write a red-overlay diff image here")
    parser.add_argument("--threshold", type=int, default=12, help="per-channel tolerance (0-255)")
    parser.add_argument("--json", action="store_true", help="print JSON")
    parser.add_argument("--max-report", type=int, default=8, help="max diff regions to report")
    args = parser.parse_args()

    before = Image.open(args.before).convert("RGB")
    after = Image.open(args.after).convert("RGB")

    size_mismatch = before.size != after.size
    width = max(before.width, after.width)
    height = max(before.height, after.height)
    if size_mismatch:
        canvas_before = Image.new("RGB", (width, height), (255, 255, 255))
        canvas_after = Image.new("RGB", (width, height), (255, 255, 255))
        canvas_before.paste(before, (0, 0))
        canvas_after.paste(after, (0, 0))
        before, after = canvas_before, canvas_after

    diff = ImageChops.difference(before, after).convert("L")
    # Treat small anti-aliasing differences as equal.
    threshold = max(0, min(255, args.threshold))
    mask = diff.point(lambda value: 255 if value > threshold else 0)

    pixels = mask.get_flattened_data() if hasattr(mask, "get_flattened_data") else mask.getdata()
    changed = sum(1 for value in pixels if value)
    total = width * height
    percentage = (changed / total * 100) if total else 0
    bbox = mask.getbbox()

    if args.out:
        overlay = after.copy()
        draw = ImageDraw.Draw(overlay)
        if bbox:
            # Tint changed pixels red without touching unchanged areas.
            red = Image.new("RGB", overlay.size, (220, 20, 30))
            overlay = Image.composite(red, overlay, mask)
        overlay.save(args.out)

    report = {
        "before": args.before,
        "after": args.after,
        "same_size": not size_mismatch,
        "size_before": list(Image.open(args.before).size),
        "size_after": list(Image.open(args.after).size),
        "changed_pixels": changed,
        "total_pixels": total,
        "changed_percent": round(percentage, 4),
        "threshold": threshold,
        "bbox": list(bbox) if bbox else None,
        "diff_image": args.out,
    }

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        status = "IDENTICAL" if changed == 0 else f"{percentage:.4f}% changed"
        print(f"{status} · {changed}/{total} px · threshold {threshold}")
        if bbox:
            print(f"changed region: x={bbox[0]} y={bbox[1]} w={bbox[2] - bbox[0]} h={bbox[3] - bbox[1]}")
        if size_mismatch:
            print("warning: screenshot sizes differ; compared on a padded canvas")
        if args.out:
            print(f"diff image: {args.out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
