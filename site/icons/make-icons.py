"""Generate the SBIR Portal icons from one geometry: icon.svg plus PNG/ICO rasters drawn with Pillow.

Design (512-unit grid): navy rounded square, a light document with three text lines, and a teal magnifier over its
lower-right corner. Maskable variants use a full-bleed square with the mark scaled into the 80 % safe zone.

Usage: python site/icons/make-icons.py      (needs Pillow: pip install pillow)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
NAVY = "#0c335b"
NAVY_DEEP = "#0b1118"
PAPER = "#e6ebf2"
LINE = "#0c335b"
TEAL = "#1db3a9"

# Geometry in a 512 x 512 box.
BG_RADIUS = 112
DOC = (132, 84, 336, 360)          # x0, y0, x1, y1
DOC_RADIUS = 24
LINES = [(166, 136, 300), (166, 180, 300), (166, 224, 250)]  # x0, y, x1 (stroke 20, round caps)
LINE_W = 20
LENS_C = (322, 326)
LENS_R = 80
LENS_W = 34
HANDLE = ((382, 386), (436, 440))
HANDLE_W = 46


def svg(maskable: bool = False) -> str:
    s = 0.72 if maskable else 1.0
    off = 256 * (1 - s)
    bg = f'<rect width="512" height="512" fill="{NAVY}"/>' if maskable else \
        f'<rect width="512" height="512" rx="{BG_RADIUS}" fill="{NAVY}"/>'
    lines = "".join(f'<path d="M{x0} {y}H{x1}"/>' for x0, y, x1 in LINES)
    (hx0, hy0), (hx1, hy1) = HANDLE
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="SBIR Portal">'
        f"{bg}<g transform=\"translate({off:g} {off:g}) scale({s:g})\">"
        f'<rect x="{DOC[0]}" y="{DOC[1]}" width="{DOC[2] - DOC[0]}" height="{DOC[3] - DOC[1]}" rx="{DOC_RADIUS}" fill="{PAPER}"/>'
        f'<g stroke="{LINE}" stroke-width="{LINE_W}" stroke-linecap="round" opacity=".55">{lines}</g>'
        f'<path d="M{hx0} {hy0}L{hx1} {hy1}" stroke="{TEAL}" stroke-width="{HANDLE_W}" stroke-linecap="round"/>'
        f'<circle cx="{LENS_C[0]}" cy="{LENS_C[1]}" r="{LENS_R}" fill="{NAVY}" stroke="{TEAL}" stroke-width="{LENS_W}"/>'
        f'<path d="M{LENS_C[0] - 38} {LENS_C[1] - 12}a40 40 0 0 1 30-28" fill="none" stroke="{PAPER}" stroke-width="12" stroke-linecap="round" opacity=".7"/>'
        "</g></svg>\n"
    )


def _blend(hex_color: str, opacity: float, under: str) -> tuple[int, int, int]:
    a = [int(hex_color[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(under[i:i + 2], 16) for i in (1, 3, 5)]
    return tuple(round(x * opacity + y * (1 - opacity)) for x, y in zip(a, b))


def raster(size: int, maskable: bool = False, transparent_corners: bool = True) -> Image.Image:
    ss = 4  # supersample for anti-aliasing
    n = size * ss
    k = n / 512
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable or not transparent_corners:
        d.rectangle((0, 0, n, n), fill=NAVY)
    else:
        d.rounded_rectangle((0, 0, n - 1, n - 1), radius=BG_RADIUS * k, fill=NAVY)

    s = 0.72 if maskable else 1.0
    off = 256 * (1 - s)

    def P(x: float, y: float) -> tuple[float, float]:
        return ((off + x * s) * k, (off + y * s) * k)

    def W(w: float) -> float:
        return w * s * k

    def round_line(p0, p1, w, color):
        d.line((P(*p0), P(*p1)), fill=color, width=round(W(w)))
        r = W(w) / 2
        for p in (p0, p1):
            cx, cy = P(*p)
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)

    x0, y0 = P(DOC[0], DOC[1])
    x1, y1 = P(DOC[2], DOC[3])
    d.rounded_rectangle((x0, y0, x1, y1), radius=W(DOC_RADIUS), fill=PAPER)
    line_color = _blend(LINE, 0.55, PAPER)
    for lx0, ly, lx1 in LINES:
        round_line((lx0, ly), (lx1, ly), LINE_W, line_color)
    round_line(*HANDLE, HANDLE_W, TEAL)
    cx, cy = P(*LENS_C)
    r_out = W(LENS_R + LENS_W / 2)
    r_in = W(LENS_R - LENS_W / 2)
    d.ellipse((cx - r_out, cy - r_out, cx + r_out, cy + r_out), fill=TEAL)
    d.ellipse((cx - r_in, cy - r_in, cx + r_in, cy + r_in), fill=NAVY)
    # glint
    gl = W(40)
    d.arc((cx - gl, cy - gl, cx + gl, cy + gl), start=195, end=265, fill=_blend(PAPER, 0.7, NAVY), width=round(W(12)))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    (HERE / "icon.svg").write_text(svg(), encoding="utf-8")
    raster(192).save(HERE / "icon-192.png", optimize=True)
    raster(512).save(HERE / "icon-512.png", optimize=True)
    raster(192, maskable=True).save(HERE / "icon-192-maskable.png", optimize=True)
    raster(512, maskable=True).save(HERE / "icon-512-maskable.png", optimize=True)
    # iOS draws its own rounded corners and shows transparency as black: full-bleed square
    raster(180, transparent_corners=False).convert("RGB").save(HERE / "apple-touch-icon.png", optimize=True)
    raster(32).save(HERE / "favicon-32.png", optimize=True)
    big = raster(256)
    big.save(HERE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("icons written to", HERE)


if __name__ == "__main__":
    main()
