from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageOps


ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def rounded_square(source: Path, size: int, radius_ratio: float, zoom: float) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    fitted = ImageOps.fit(
        image,
        (size, size),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    if zoom > 1:
        zoomed_size = round(size * zoom)
        fitted = fitted.resize((zoomed_size, zoomed_size), Image.Resampling.LANCZOS)
        left = (zoomed_size - size) // 2
        top = (zoomed_size - size) // 2
        fitted = fitted.crop((left, top, left + size, top + size))

    scale = 4
    mask_size = size * scale
    radius = int(size * radius_ratio) * scale
    mask = Image.new("L", (mask_size, mask_size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, mask_size, mask_size), radius=radius, fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)

    fitted.putalpha(ImageChops.multiply(fitted.getchannel("A"), mask))
    return fitted


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a rounded PNG and ICO from an image.")
    parser.add_argument("source", type=Path, help="Source image path.")
    parser.add_argument("--png-out", type=Path, default=Path("resources/icon.png"))
    parser.add_argument("--ico-out", type=Path, default=Path("resources/icon.ico"))
    parser.add_argument("--variant-out", type=Path, default=Path("resources/app-icons/soft.png"))
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--radius-ratio", type=float, default=0.23)
    parser.add_argument("--zoom", type=float, default=1.0, help="Center zoom before applying rounded corners.")
    args = parser.parse_args()

    icon = rounded_square(args.source, args.size, args.radius_ratio, max(args.zoom, 1.0))

    for output in (args.png_out, args.ico_out, args.variant_out):
        output.parent.mkdir(parents=True, exist_ok=True)

    icon.save(args.png_out)
    icon.save(args.ico_out, sizes=[(size, size) for size in ICO_SIZES])
    icon.save(args.variant_out)

    print(f"Wrote {args.png_out}")
    print(f"Wrote {args.ico_out}")
    print(f"Wrote {args.variant_out}")
    print(f"ICO sizes: {', '.join(f'{size}x{size}' for size in ICO_SIZES)}")


if __name__ == "__main__":
    main()
