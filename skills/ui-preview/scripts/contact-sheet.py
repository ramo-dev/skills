#!/usr/bin/env python3
"""Build a labelled contact sheet from UI screenshots.

Requires Pillow: python3 -m pip install Pillow

Examples:
  python3 contact-sheet.py desktop.png mobile.png --labels "Desktop,Mobile" \
    --out /tmp/ui-preview/preview-sheet.png

  python3 contact-sheet.py shots/*.png --columns 3 --width 700 \
    --out /tmp/ui-preview/sheet.png --json
"""
import argparse
import glob
import json
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")


def load_font(size: int):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a labelled UI screenshot contact sheet")
    parser.add_argument("images", nargs="+", help="image paths or globs")
    parser.add_argument("--out", required=True)
    parser.add_argument("--labels", default="", help="comma-separated labels")
    parser.add_argument("--title", default="")
    parser.add_argument("--columns", type=int, default=2)
    parser.add_argument("--width", type=int, default=900, help="max cell width")
    parser.add_argument("--max-height", type=int, default=1600, help="max cell image height")
    parser.add_argument("--gap", type=int, default=24)
    parser.add_argument("--padding", type=int, default=32)
    parser.add_argument("--background", default="#ffffff")
    parser.add_argument("--label-color", default="#22262a")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    paths = []
    for pattern in args.images:
        matches = glob.glob(pattern)
        paths.extend(matches if matches else [pattern])
    paths = [path for path in paths if path]
    if not paths:
        sys.exit("No images found")

    labels = [label.strip() for label in args.labels.split(",") if label.strip()]
    if labels and len(labels) != len(paths):
        sys.exit(f"{len(labels)} labels for {len(paths)} images")

    font = load_font(max(14, args.width // 40))
    title_font = load_font(max(20, args.width // 28))
    font_size = getattr(font, "size", 14)
    title_size = getattr(title_font, "size", 20)
    cells = []
    for index, path in enumerate(paths):
        image = Image.open(path).convert("RGB")
        fitted = ImageOps.contain(image, (args.width, args.max_height), Image.LANCZOS)
        cells.append(
            {
                "path": path,
                "image": fitted,
                "label": labels[index] if labels else path.rsplit("/", 1)[-1],
                "original": image.size,
            }
        )

    columns = max(1, args.columns)
    rows = (len(cells) + columns - 1) // columns
    cell_width = max(cell["image"].width for cell in cells)
    cell_height = max(cell["image"].height for cell in cells) + font_size + 14
    title_height = (title_size + 20) if args.title else 0
    sheet_width = args.padding * 2 + columns * cell_width + (columns - 1) * args.gap
    sheet_height = (
        args.padding * 2
        + title_height
        + rows * cell_height
        + (rows - 1) * args.gap
    )

    sheet = Image.new("RGB", (sheet_width, sheet_height), args.background)
    draw = ImageDraw.Draw(sheet)
    if args.title:
        draw.text((args.padding, args.padding), args.title, font=title_font, fill=args.label_color)

    for index, cell in enumerate(cells):
        column = index % columns
        row = index // columns
        x = args.padding + column * (cell_width + args.gap)
        y = args.padding + title_height + row * (cell_height + args.gap)
        image = cell["image"]
        image_x = x + (cell_width - image.width) // 2
        sheet.paste(image, (image_x, y))
        draw.rectangle(
            [image_x, y, image_x + image.width - 1, y + image.height - 1],
            outline="#e3e5e8",
            width=1,
        )
        draw.text(
            (x, y + cell_height - font_size - 2),
            cell["label"][:120],
            font=font,
            fill=args.label_color,
        )

    sheet.save(args.out)
    report = {
        "out": args.out,
        "size": list(sheet.size),
        "columns": columns,
        "cells": [
            {
                "path": cell["path"],
                "label": cell["label"],
                "source_size": list(cell["original"]),
                "rendered_size": list(cell["image"].size),
            }
            for cell in cells
        ],
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"contact sheet: {args.out} ({sheet.width}x{sheet.height})")
        for cell in report["cells"]:
            print(f"  {cell['label']}: {cell['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
