"""PWA 用アイコンを frontend/favicon.png から生成する.

使い方: python scripts/gen-pwa-icons.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "favicon.png"
OUT_DIR = ROOT / "frontend"

# maskable 用の背景色（manifest の theme_color と一致）
MASKABLE_BG = (74, 94, 199, 255)  # #4a5ec7


def save_square(img: Image.Image, size: int, path: Path) -> None:
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({size}x{size})")


def save_maskable(img: Image.Image, size: int, path: Path) -> None:
    """セーフゾーン 80% を確保し、余白を theme_color で塗る."""
    canvas = Image.new("RGBA", (size, size), MASKABLE_BG)
    inner = int(size * 0.8)
    resized = img.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(resized, (offset, offset), resized if resized.mode == "RGBA" else None)
    canvas.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({size}x{size}, maskable)")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")
    img = Image.open(SRC).convert("RGBA")
    print(f"source: {SRC.relative_to(ROOT)} ({img.size[0]}x{img.size[1]})")
    save_square(img, 192, OUT_DIR / "icon-192.png")
    save_square(img, 512, OUT_DIR / "icon-512.png")
    save_square(img, 180, OUT_DIR / "apple-touch-icon.png")
    save_maskable(img, 512, OUT_DIR / "icon-maskable-512.png")
    print("done.")


if __name__ == "__main__":
    main()
