"""Render the minimal bscan launch card with the original header wordmark."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "social"
SOURCE = OUT / "bscan-launch-background.png"
TARGET = OUT / "bscan-launch-post.png"
HEADER = ROOT / "public" / "social" / "bscan-x-header.png"
ICON = ROOT / "public" / "bscan-mark.png"
FONT_DIR = Path("C:/Windows/Fonts")
REGULAR = FONT_DIR / "segoeui.ttf"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def gold_cutout(source: Image.Image) -> Image.Image:
    result = source.convert("RGBA")
    pixels = result.load()
    for y in range(result.height):
        for x in range(result.width):
            r, g, b, original_alpha = pixels[x, y]
            gold_alpha = max(0, min(255, round((r - b - 9) * 1.4)))
            pixels[x, y] = (r, g, b, min(original_alpha, gold_alpha))
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE).convert("RGBA")

    # Reuse the gold wordmark from the existing X header to preserve its exact letterforms.
    wordmark = gold_cutout(Image.open(HEADER).convert("RGB").crop((560, 158, 915, 256)))
    wordmark = wordmark.resize((550, 152), Image.Resampling.LANCZOS)
    image.alpha_composite(wordmark, (105, 215))

    icon = gold_cutout(Image.open(ICON))
    icon = icon.crop(icon.getchannel("A").getbbox())
    icon_width = round(icon.width * 125 / icon.height)
    icon = icon.resize((icon_width, 125), Image.Resampling.LANCZOS)
    image.alpha_composite(icon, (105 + (550 - icon_width) // 2, 64))

    draw = ImageDraw.Draw(image)
    draw.text((107, 403), "KOL trades on BNB Chain", font=font(REGULAR, 43), fill=(245, 247, 247, 255))

    image.convert("RGB").save(TARGET, "PNG", optimize=True)
    print(TARGET)


if __name__ == "__main__":
    main()
