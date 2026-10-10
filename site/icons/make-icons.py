"""Generate every SAM's Garage (Sg) image from one geometry: the site icons, the Windows .ico, and the branding/
set (marks, wordmarks, banner, social image, app icon).

Design: a navy rounded square ("blueprint" paper with a faint grid) with a roof line over a monoline "Sg"
monogram, the S in paper white and the g in teal. Every letter is a round-capped stroke drawn by the tiny monoline
alphabet below, which also sets the wordmark "SAM's Garage", so no font file is involved: the SVGs use the same
strokes (stroke-linecap="round") that the PNGs stamp with Pillow, and every machine produces the same images.

Small sizes (favicons, the header logo, icon.svg) use the compact mark: no roof and no grid, larger letters, so the
monogram stays legible at 16 px. The tagline on the banner and social image uses Pillow's bundled font.

Outputs: site/icons/ (icon.svg, PNGs, favicon.ico, icon.ico for the Windows build, social-1280x640.png for link
previews) and branding/svg, branding/png (marks, wordmarks, 1200x300 banner, 1280x640 social image, 1024 app icon).

Usage: python site/icons/make-icons.py      (needs Pillow 10.1+: pip install pillow)
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BRAND_SVG = ROOT / "branding" / "svg"
BRAND_PNG = ROOT / "branding" / "png"

NAVY = "#0c335b"       # the tile
DEEP = "#0b1118"       # the app's dark background
PAPER = "#e6ebf2"      # the S, the roof, light text
TEAL = "#1db3a9"       # the g, accents
INK = "#0c335b"        # wordmark text on light backgrounds
DIM = "#93a0b3"

NAME = "SAM's Garage"
TAGLINE = "Every open and upcoming SBIR/STTR topic, refreshed daily"
URL = "sg.luiscintron.com"

# ---------------------------------------------------------------------------------------------------------------
# Monoline alphabet. Units: cap height 100, x-height 70, descender 38, baseline y = 0, y grows downwards. A glyph is
# a list of primitives on its stroke's centre line, in a box whose left outer edge is x = 0:
#   ("L", x0, y0, x1, y1)              a straight stroke
#   ("A", cx, cy, rx, ry, a0, a1)       an elliptical arc from angle a0 to a1 (degrees; increasing = clockwise)
# Strokes are round-capped and round-joined, so a glyph is the union of its primitives.
CAP, XH, DESC, TRACK = 100.0, 70.0, 38.0, 11.0


def glyph(ch: str, w: float) -> tuple[list[tuple], float]:
    h = w / 2
    yt, yb, xt = -CAP + h, -h, -XH + h  # cap top, baseline and x-height on the centre line

    def s_shape(top: float, width: float) -> list[tuple]:
        rx, ry = (width - w) / 2, (yb - top) / 4
        cx = width / 2
        return [("A", cx, top + ry, rx, ry, -38, -270), ("A", cx, yb - ry, rx, ry, -90, 142)]

    if ch == "S":
        width = 64
        return s_shape(yt, width), width
    if ch == "s":
        width = 52
        return s_shape(xt, width), width
    if ch == "A":
        width = 74
        ax, lx, rx_ = width / 2, h, width - h
        bar = yb - 0.36 * (yb - yt)
        t = (yb - bar) / (yb - yt)
        return [("L", lx, yb, ax, yt), ("L", ax, yt, rx_, yb),
                ("L", lx + t * (ax - lx), bar, rx_ - t * (rx_ - ax), bar)], width
    if ch == "M":
        width = 84
        mid = yt + 0.64 * (yb - yt)
        return [("L", h, yb, h, yt), ("L", h, yt, width / 2, mid), ("L", width / 2, mid, width - h, yt),
                ("L", width - h, yt, width - h, yb)], width
    if ch == "'":
        return [("L", h, yt, h, yt + 24)], w
    if ch == "G":
        width = 88
        rx, ry = (width - w) / 2, (yb - yt) / 2
        cx, cy = width / 2, (yt + yb) / 2
        return [("A", cx, cy, rx, ry, -42, -360), ("L", cx + rx, cy + 4, cx + rx * 0.22, cy + 4)], width
    if ch in "ag":
        r = (yb - xt) / 2
        width = 2 * r + w
        cx, cy = width / 2, (xt + yb) / 2
        if ch == "a":
            return [("A", cx, cy, r, r, 0, 360), ("L", cx + r, xt, cx + r, yb)], width
        ys = DESC - h - r  # the hook's centre
        return [("A", cx, cy, r, r, 0, 360), ("L", cx + r, xt, cx + r, ys), ("A", cx, ys, r, r, 0, 152)], width
    if ch == "r":
        R = 25.0
        width = w + 1.5 * R
        return [("L", h, xt, h, yb), ("A", h + R, xt + R, R, R, 180, 300)], width
    if ch == "e":
        r = (yb - xt) / 2
        width = 2 * r + w
        cx, cy = width / 2, (xt + yb) / 2
        return [("L", cx - r, cy, cx + r, cy), ("A", cx, cy, r, r, 0, -318)], width
    if ch == " ":
        return [], 30 - TRACK
    raise ValueError(f"no glyph for {ch!r}")


def text(s: str, w: float, colors: list[str]) -> tuple[list[tuple[str, tuple]], float]:
    """Set a string: [(color, primitive)] in font units and the total width. colors[i] colors character i."""
    out, x = [], 0.0
    for i, ch in enumerate(s):
        prims, adv = glyph(ch, w)
        out += [(colors[i], move(p, 1, x, 0)) for p in prims]
        x += adv + TRACK
    return out, x - TRACK


def move(p: tuple, k: float, dx: float, dy: float) -> tuple:
    if p[0] == "L":
        return ("L", p[1] * k + dx, p[2] * k + dy, p[3] * k + dx, p[4] * k + dy)
    return ("A", p[1] * k + dx, p[2] * k + dy, p[3] * k, p[4] * k, p[5], p[6])


# ---------------------------------------------------------------------------------------------------------------
# The mark, on a 512 x 512 tile. A layer is (color, opacity, stroke width, [primitives]).
TILE, TILE_R = 512, 112
ROOF_UP = 118  # the roof's ridge above the cap height (tile units)


def mark_layers(compact: bool) -> list[tuple[str, float, float, list[tuple]]]:
    w = 21.0 if compact else 18.0                       # stroke, in font units
    k = 3.0 if compact else 2.05                        # font units -> tile units
    s_prims, s_w = glyph("S", w)
    g_prims, g_w = glyph("g", w)
    total = (s_w + TRACK * 0.6 + g_w) * k
    x0 = (TILE - total) / 2
    # baseline: the letters (cap top to descender) are centred; the full mark centres roof and letters together
    base = (TILE - (CAP + DESC) * k) / 2 + CAP * k if compact else TILE / 2 - (DESC * k - CAP * k - ROOF_UP - 13) / 2
    S = [move(p, k, x0, base) for p in s_prims]
    g = [move(p, k, x0 + (s_w + TRACK * 0.6) * k, base) for p in g_prims]
    layers = [(PAPER, 1.0, w * k, S), (TEAL, 1.0, w * k, g)]
    if not compact:
        eave, ridge, half = base - CAP * k - 44, base - CAP * k - ROOF_UP, 150
        roof = [("L", 256 - half, eave, 256, ridge), ("L", 256, ridge, 256 + half, eave)]
        layers.insert(0, (PAPER, 0.9, 26, roof))
    return layers


def grid_lines(step: int = 32) -> list[tuple]:
    return [("L", v, 0, v, TILE) for v in range(step, TILE, step)] + [("L", 0, v, TILE, v) for v in range(step, TILE, step)]


# ---------------------------------------------------------------------------------------------------------------
# SVG
def fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def arc_points(p: tuple, a: float) -> tuple[float, float]:
    _, cx, cy, rx, ry = p[:5]
    return cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a))


def svg_d(prims: list[tuple]) -> str:
    d = []
    for p in prims:
        if p[0] == "L":
            d.append(f"M{fmt(p[1])} {fmt(p[2])}L{fmt(p[3])} {fmt(p[4])}")
            continue
        a0, a1 = p[5], p[6]
        n = max(1, math.ceil(abs(a1 - a0) / 179.9))
        x, y = arc_points(p, a0)
        d.append(f"M{fmt(x)} {fmt(y)}")
        for i in range(1, n + 1):
            x, y = arc_points(p, a0 + (a1 - a0) * i / n)
            d.append(f"A{fmt(p[3])} {fmt(p[4])} 0 0 {1 if a1 > a0 else 0} {fmt(x)} {fmt(y)}")
    return "".join(d)


def svg_layers(layers, k: float = 1.0, dx: float = 0, dy: float = 0) -> str:
    out = ['<g fill="none" stroke-linecap="round" stroke-linejoin="round">']
    for color, opacity, width, prims in layers:
        op = f' stroke-opacity="{fmt(opacity)}"' if opacity < 1 else ""
        out.append(f'<path stroke="{color}"{op} stroke-width="{fmt(width * k)}" d="{svg_d([move(p, k, dx, dy) for p in prims])}"/>')
    out.append("</g>")
    return "".join(out)


def svg_tile(compact: bool, full_bleed: bool = False, k: float = 1.0, dx: float = 0, dy: float = 0, clip_id: str = "sgTile") -> str:
    """The tile's elements (no <svg> wrapper), scaled by k and moved by (dx, dy)."""
    size, r = TILE * k, (0 if full_bleed else TILE_R * k)
    rx = f' rx="{fmt(r)}"' if r else ""
    parts = [f'<rect x="{fmt(dx)}" y="{fmt(dy)}" width="{fmt(size)}" height="{fmt(size)}"{rx} fill="{NAVY}"/>']
    if not compact:
        parts.append(f'<clipPath id="{clip_id}"><rect x="{fmt(dx)}" y="{fmt(dy)}" width="{fmt(size)}" height="{fmt(size)}" rx="{fmt(r)}"/></clipPath>')
        parts.append(f'<g clip-path="url(#{clip_id})">' + svg_layers([(PAPER, 0.07, 2, grid_lines())], k, dx, dy) + "</g>")
    layers = mark_layers(compact)
    if full_bleed:  # maskable: the mark inside the 80 % safe zone
        layers = [(c, o, wd * 0.8, [move(p, 0.8, 51.2, 51.2) for p in prims]) for c, o, wd, prims in layers]
    parts.append(svg_layers(layers, k, dx, dy))
    return "".join(parts)


def svg_doc(w: float, h: float, body: str, label: str = NAME) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" width="{fmt(w)}" height="{fmt(h)}" '
            f'role="img" aria-label="{label}">{body}</svg>\n')


# ---------------------------------------------------------------------------------------------------------------
# Raster: strokes are stamped as discs along their centre line on a supersampled canvas (the exact shape of a
# round-capped, round-joined stroke), then scaled down.
SS = 4


def _samples(p: tuple, step: float):
    if p[0] == "L":
        _, x0, y0, x1, y1 = p
        n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n + 1):
            yield x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n
        return
    a0, a1 = p[5], p[6]
    n = max(1, math.ceil(max(p[3], p[4]) * math.radians(abs(a1 - a0)) / step))
    for i in range(n + 1):
        yield arc_points(p, a0 + (a1 - a0) * i / n)


def stamp(img: Image.Image, layers, k: float, dx: float = 0, dy: float = 0, clip: Image.Image | None = None) -> None:
    """Draw layers onto img (RGBA, already supersampled); k, dx, dy map layer units to canvas pixels."""
    for color, opacity, width, prims in layers:
        mask = Image.new("L", img.size, 0)
        d = ImageDraw.Draw(mask)
        r = width * k / 2
        step = max(0.5, r / 6)
        for p in prims:
            for x, y in _samples(move(p, k, dx, dy), step):
                d.ellipse((x - r, y - r, x + r, y + r), fill=255)
        if opacity < 1:
            mask = mask.point(lambda v: round(v * opacity))
        if clip is not None:
            mask = ImageChops.multiply(mask, clip)
        img.paste(Image.new("RGBA", img.size, color), (0, 0), mask)


def tile_image(size: int, compact: bool, full_bleed: bool = False, square: bool = False) -> Image.Image:
    """The tile at size x size px: rounded with transparent corners, or square (full_bleed / square)."""
    n = size * SS
    k = n / TILE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    bg = Image.new("L", (n, n), 0)
    if full_bleed or square:
        bg.paste(255, (0, 0, n, n))
    else:
        ImageDraw.Draw(bg).rounded_rectangle((0, 0, n - 1, n - 1), radius=TILE_R * k, fill=255)
    img.paste(Image.new("RGBA", (n, n), NAVY), (0, 0), bg)
    if not compact:
        stamp(img, [(PAPER, 0.07, 2, grid_lines())], k, clip=bg)
    layers = mark_layers(compact)
    if full_bleed:
        layers = [(c, o, wd * 0.8, [move(p, 0.8, 51.2, 51.2) for p in prims]) for c, o, wd, prims in layers]
    stamp(img, layers, k)
    return img.resize((size, size), Image.LANCZOS)


def mono_mark(color: str) -> list:
    """The roof and letters alone in one color (no tile)."""
    return [(color, 1.0, wd, prims) for _, _, wd, prims in mark_layers(False)]


# ---------------------------------------------------------------------------------------------------------------
# Wordmark: the tile, then "SAM's Garage" (SAM's in ink, Garage in teal), in font units with cap height 100.
WORD_W = 13.0


def wordmark_layers(ink: str) -> tuple[list, float]:
    colors = [ink] * 6 + [TEAL] * 6
    prims, width = text(NAME, WORD_W, colors)
    layers = []
    for color in (ink, TEAL):
        layers.append((color, 1.0, WORD_W, [p for c, p in prims if c == color]))
    return layers, width


def wordmark(ink: str, height: float = 256) -> tuple[str, Image.Image]:
    """Horizontal wordmark: tile (height x height) + text. Returns (svg, png)."""
    layers, tw = wordmark_layers(ink)
    k = height * 0.42 / CAP                      # text cap height = 42 % of the tile
    gap = height * 0.22
    width = height + gap + tw * k + height * 0.06
    base = height / 2 + CAP * k / 2
    tx = height + gap
    svg = svg_doc(width, height, svg_tile(False, k=height / TILE, clip_id="sgWm") + svg_layers(layers, k, tx, base))
    n = SS
    img = Image.new("RGBA", (math.ceil(width * n), round(height * n)), (0, 0, 0, 0))
    img.alpha_composite(tile_image(round(height * n), False))
    stamp(img, layers, k * n, tx * n, base * n)
    return svg, img.resize((math.ceil(width), round(height)), Image.LANCZOS)


# ---------------------------------------------------------------------------------------------------------------
# Banner and social image: dark blueprint background, the tile, the wordmark, the tagline.
def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size=size)


def poster(width: int, height: int, tile: int, cap: int, tag_size: int, url: bool) -> Image.Image:
    n = SS
    img = Image.new("RGBA", (width * n, height * n), DEEP)
    step = 32
    grid = [("L", x, 0, x, height) for x in range(step, width, step)] + [("L", 0, y, width, y) for y in range(step, height, step)]
    stamp(img, [(NAVY, 0.55, 1.5, grid)], n)
    layers, tw = wordmark_layers(PAPER)
    k = cap / CAP
    gap = tile * 0.2
    block_w = tile + gap + tw * k
    x0 = (width - block_w) / 2
    y0 = (height - tile) / 2 - (tag_size * 0.9 if url else tag_size * 0.6)
    img.alpha_composite(tile_image(tile * n, False), (round(x0 * n), round(y0 * n)))
    tx = x0 + tile + gap
    base = y0 + tile / 2 + cap * 0.32
    stamp(img, layers, k * n, tx * n, base * n)
    out = img.resize((width, height), Image.LANCZOS)
    d = ImageDraw.Draw(out)
    f = font(tag_size)
    d.text((tx, base + cap * 0.62), TAGLINE, font=f, fill=DIM)
    if url:
        d.text((tx, base + cap * 0.62 + tag_size * 1.7), URL, font=font(round(tag_size * 0.9)), fill=TEAL)
    return out.convert("RGB")


# ---------------------------------------------------------------------------------------------------------------
def main() -> None:
    BRAND_SVG.mkdir(parents=True, exist_ok=True)
    BRAND_PNG.mkdir(parents=True, exist_ok=True)

    # site icons
    (HERE / "icon.svg").write_text(svg_doc(TILE, TILE, svg_tile(True)), encoding="utf-8", newline="\n")
    tile_image(192, False).save(HERE / "icon-192.png", optimize=True)
    tile_image(512, False).save(HERE / "icon-512.png", optimize=True)
    tile_image(192, False, full_bleed=True).save(HERE / "icon-192-maskable.png", optimize=True)
    tile_image(512, False, full_bleed=True).save(HERE / "icon-512-maskable.png", optimize=True)
    # iOS rounds the corners itself and shows transparency as black: a full square
    tile_image(180, False, square=True).convert("RGB").save(HERE / "apple-touch-icon.png", optimize=True)
    tile_image(32, True).save(HERE / "favicon-32.png", optimize=True)
    small = {s: tile_image(s, True) for s in (16, 24, 32, 48)}
    large = {s: tile_image(s, False) for s in (64, 128, 256)}
    small[48].save(HERE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[small[16], small[32]])
    sizes = sorted({**small, **large})
    large[256].save(HERE / "icon.ico", sizes=[(s, s) for s in sizes], append_images=[{**small, **large}[s] for s in sizes if s != 256])
    social = poster(1280, 640, 236, 96, 28, True)
    social.save(HERE / "social-1280x640.png", optimize=True)

    # branding/
    (BRAND_SVG / "sg-mark.svg").write_text(svg_doc(TILE, TILE, svg_tile(False)), encoding="utf-8", newline="\n")
    (BRAND_SVG / "sg-mark-compact.svg").write_text(svg_doc(TILE, TILE, svg_tile(True)), encoding="utf-8", newline="\n")
    for name, color in (("white", "#ffffff"), ("black", "#000000")):
        (BRAND_SVG / f"sg-mark-{name}.svg").write_text(svg_doc(TILE, TILE, svg_layers(mono_mark(color))), encoding="utf-8", newline="\n")
        img = Image.new("RGBA", (TILE * SS, TILE * SS), (0, 0, 0, 0))
        stamp(img, mono_mark(color), SS)
        img.resize((TILE, TILE), Image.LANCZOS).save(BRAND_PNG / f"sg-mark-{name}.png", optimize=True)
    tile_image(512, False).save(BRAND_PNG / "sg-mark-color.png", optimize=True)
    tile_image(1024, False).save(BRAND_PNG / "sg-app-icon-1024.png", optimize=True)
    for suffix, ink in (("", INK), ("-on-dark", PAPER)):
        svg, png = wordmark(ink)
        (BRAND_SVG / f"sg-wordmark-horizontal{suffix}.svg").write_text(svg, encoding="utf-8", newline="\n")
        png.save(BRAND_PNG / f"sg-wordmark-horizontal{suffix}.png", optimize=True)
    poster(1200, 300, 168, 70, 22, False).save(BRAND_PNG / "sg-banner-1200x300.png", optimize=True)
    social.save(BRAND_PNG / "sg-social-1280x640.png", optimize=True)
    print("icons written to", HERE, "and branding to", BRAND_SVG.parent)


if __name__ == "__main__":
    main()
