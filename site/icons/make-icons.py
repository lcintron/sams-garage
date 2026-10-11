"""Generate every SAM's Garage (Sg) image from the master logo, branding/svg/sg-logo.svg.

The master SVG is traced from the artwork (branding/source/sams-garage-logo.png) by branding/trace-logo.py: a dark
rounded tile holding a light "S", a teal garage door and a star (the mark, group "mark", whose tile box is in its
data-tile attribute), and the words "SAM's" (navy) and "Garage" (teal) (group "wordmark"). Edit or re-trace the SVG,
then run this script; nothing else is drawn by hand.

Outputs
  site/icons/      icon.svg (the mark), icon-192/512.png, icon-192/512-maskable.png (full-bleed, artwork inside
                   Android's 80 % safe circle), apple-touch-icon.png (180, opaque), favicon-32.png, favicon.ico
                   (16/32/48), icon.ico (16-256, Windows desktop build), social-1280x640.png (link previews)
  branding/svg/    sg-logo-on-dark.svg, sg-mark.svg, sg-mark-black.svg, sg-mark-white.svg (one-color marks: the
                   tile with the S, door and star cut out)
  branding/png/    sg-logo.png, sg-logo-on-dark.png, sg-app-icon-1024.png, sg-mark-black.png, sg-mark-white.png,
                   sg-banner-1200x300.png, sg-social-1280x640.png

The PNGs are rendered here, without an SVG library: the master's paths use only absolute M/L/C/Z commands, which
are flattened to polygons and filled even-odd with Pillow at 4x, then reduced.

Usage: python site/icons/make-icons.py      (needs Pillow 10.1+: pip install pillow)
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MASTER = ROOT / "branding" / "svg" / "sg-logo.svg"
BRAND_SVG = ROOT / "branding" / "svg"
BRAND_PNG = ROOT / "branding" / "png"

NAME = "SAM's Garage"
TAGLINE = "Every open and upcoming SBIR/STTR topic, refreshed daily"
URL = "sg.luiscintron.com"
LIGHT_BG = "#f4f7fb"   # banner and social image background
DIM = "#4b5b70"         # tagline on the light background
ON_DARK_TEXT = "#e8ecf3"  # "SAM's" on dark backgrounds (navy would vanish)
SS = 4                  # supersampling

Box = tuple[float, float, float, float]  # x, y, w, h


# ------------------------------------------------------------------------------------------------ master SVG


@dataclass
class Part:
    id: str
    fill: str
    d: str


@dataclass
class Logo:
    viewbox: Box
    tile: Box
    mark: list[Part]
    words: list[Part]

    def part(self, pid: str) -> Part:
        return next(p for p in self.mark + self.words if p.id == pid)


def load_master() -> Logo:
    s = MASTER.read_text(encoding="utf-8")
    vb = tuple(map(float, re.search(r'viewBox="([^"]+)"', s).group(1).split()))
    tile = tuple(map(float, re.search(r'data-tile="([^"]+)"', s).group(1).split()))
    mark_xml, words_xml = s.split('<g id="wordmark">', 1)
    parse = lambda xml: [Part(*m) for m in re.findall(r'<path id="(\w+)" fill="(#[0-9a-fA-F]{6})"[^>]* d="([^"]+)"', xml)]
    return Logo(vb, tile, parse(mark_xml), parse(words_xml))


# ------------------------------------------------------------------------------------------------ geometry

TOKEN = re.compile(r"[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?")


def subpaths(d: str) -> list[list[tuple[float, float]]]:
    """Flatten an absolute M/L/C/Z path into closed polygons (one per subpath)."""
    toks, i, out, pt = TOKEN.findall(d), 0, [], (0.0, 0.0)

    def num() -> float:
        nonlocal i
        i += 1
        return float(toks[i - 1])

    while i < len(toks):
        t = toks[i]
        i += 1
        if t == "M":
            pt = (num(), num())
            out.append([pt])
        elif t == "L":
            pt = (num(), num())
            out[-1].append(pt)
        elif t == "C":
            c1, c2, p3 = (num(), num()), (num(), num()), (num(), num())
            p0 = pt
            n = max(4, min(24, int(math.dist(p0, p3) / 4) + 4))
            for k in range(1, n + 1):
                u = k / n
                v = 1 - u
                out[-1].append((v**3 * p0[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u**3 * p3[0],
                                v**3 * p0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u**3 * p3[1]))
            pt = p3
    return out


def bounds(parts: list[Part]) -> Box:
    pts = [p for part in parts for sp in subpaths(part.d) for p in sp]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


@dataclass
class Place:
    """Maps master coordinates to output pixels: out = (v - origin) * k + offset."""
    ox: float
    oy: float
    k: float
    dx: float = 0
    dy: float = 0

    def __call__(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.ox) * self.k + self.dx, (y - self.oy) * self.k + self.dy


def fit(box: Box, w: float, h: float, scale: float = 1.0) -> Place:
    """Center `box` in a w x h area, scaled to fit, times `scale`."""
    k = min(w / box[2], h / box[3]) * scale
    return Place(box[0], box[1], k, (w - box[2] * k) / 2, (h - box[3] * k) / 2)


# ------------------------------------------------------------------------------------------------ raster


def coverage(d: str, size: tuple[int, int], place: Place) -> Image.Image:
    """Anti-aliased 'L' coverage of one path (even-odd)."""
    big = (size[0] * SS, size[1] * SS)
    acc = Image.new("1", big, 0)
    for sp in subpaths(d):
        if len(sp) < 3:
            continue
        m = Image.new("1", big, 0)
        ImageDraw.Draw(m).polygon([(x * SS, y * SS) for x, y in (place(*p) for p in sp)], fill=1)
        acc = ImageChops.logical_xor(acc, m)
    return acc.convert("L").resize(size, Image.LANCZOS)


def paint(img: Image.Image, parts: list[tuple[str, str]], place: Place) -> Image.Image:
    """Paint (fill, d) pairs onto img in order."""
    for fill, d in parts:
        layer = Image.new("RGBA", img.size, fill)
        layer.putalpha(coverage(d, img.size, place))
        img = Image.alpha_composite(img, layer)
    return img


def fills(parts: list[Part], recolor: dict[str, str] | None = None) -> list[tuple[str, str]]:
    return [((recolor or {}).get(p.id, p.fill), p.d) for p in parts]


def rounded_rect_path(x: float, y: float, w: float, h: float, r: float) -> str:
    k = r * (1 - 0.5523)
    x1, y1 = x + w, y + h
    return (f"M{x + r} {y}L{x1 - r} {y}C{x1 - k} {y} {x1} {y + k} {x1} {y + r}L{x1} {y1 - r}"
            f"C{x1} {y1 - k} {x1 - k} {y1} {x1 - r} {y1}L{x + r} {y1}C{x + k} {y1} {x} {y1 - k} {x} {y1 - r}"
            f"L{x} {y + r}C{x} {y + k} {x + k} {y} {x + r} {y}Z")


def mark_image(logo: Logo, size: int) -> Image.Image:
    """The mark (rounded tile and all), filling a transparent square."""
    tx, ty, tw, th = logo.tile
    side = max(tw, th)
    place = fit((tx - (side - tw) / 2, ty - (side - th) / 2, side, side), size, size)
    return paint(Image.new("RGBA", (size, size), (0, 0, 0, 0)), fills(logo.mark), place)


def full_bleed(logo: Logo, size: int, safe: float) -> Image.Image:
    """The tile color edge to edge with the S, door and star centered inside a circle of radius safe * size.

    Maskable icons (Android crops them to any shape) use safe = 0.38, just inside the spec's 0.40 safe zone; the apple-touch icon
    (iOS rounds the corners itself) uses a little more room."""
    tile = logo.part("tile")
    art = [p for p in logo.mark if p.id != "tile"]
    bx, by, bw, bh = bounds(art)
    cx, cy = bx + bw / 2, by + bh / 2
    reach = max(math.dist((cx, cy), pt) for p in art for sp in subpaths(p.d) for pt in sp)
    k = safe * size / reach
    place = Place(cx, cy, k, size / 2, size / 2)
    img = Image.new("RGBA", (size, size), tile.fill)
    return paint(img, fills(art), place)


def logo_image(logo: Logo, width: int, on_dark: bool = False, height: int | None = None, pad: float = 0.0) -> Image.Image:
    """The full horizontal logo, `width` pixels wide (content box plus `pad` x content height each side)."""
    box = bounds(logo.mark + logo.words)
    box = (box[0] - pad * box[3], box[1] - pad * box[3], box[2] + 2 * pad * box[3], box[3] + 2 * pad * box[3])
    h = height or round(width * box[3] / box[2])
    place = fit(box, width, h)
    recolor = {"sams": ON_DARK_TEXT} if on_dark else None
    return paint(Image.new("RGBA", (width, h), (0, 0, 0, 0)), fills(logo.mark + logo.words, recolor), place)


def mono_mask(logo: Logo, size: int) -> Image.Image:
    """One-color mark: the tile with the S, door and star cut out (as 'L' coverage)."""
    tx, ty, tw, th = logo.tile
    side = max(tw, th)
    place = fit((tx - (side - tw) / 2, ty - (side - th) / 2, side, side), size, size)
    m = coverage(logo.part("tile").d, (size, size), place)
    for p in logo.mark:
        if p.id != "tile":
            m = ImageChops.subtract(m, coverage(p.d, (size, size), place))
    return m


def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def poster(logo: Logo, width: int, height: int, logo_width: int, tag_size: int, url: bool) -> Image.Image:
    """Banner / social image: the logo centered on a light background, with the tagline (and URL) under it."""
    img = Image.new("RGBA", (width, height), LIGHT_BG)
    art = logo_image(logo, logo_width)
    lines = [(TAGLINE, tag_size, DIM)] + ([(URL, int(tag_size * 0.8), "#00838a")] if url else [])
    draw = ImageDraw.Draw(img)
    gap = int(tag_size * 0.9)
    text_h = sum(int(s * 1.35) for _, s, _ in lines)
    top = (height - (art.height + gap + text_h)) // 2
    img.alpha_composite(art, ((width - art.width) // 2, top))
    y = top + art.height + gap
    for text, size, color in lines:
        f = font(size)
        w = draw.textlength(text, font=f)
        draw.text(((width - w) / 2, y), text, fill=color, font=f)
        y += int(size * 1.35)
    return img


# ------------------------------------------------------------------------------------------------ SVG outputs


def svg_doc(box: Box, body: str, label: str) -> str:
    vb = " ".join(f"{v:g}" for v in box)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{label}">\n'
            f"{body}\n</svg>\n")


def svg_paths(parts: list[tuple[str, str]]) -> str:
    return "\n".join(f'  <path fill="{f}" fill-rule="evenodd" d="{d}"/>' for f, d in parts)


def mark_box(logo: Logo) -> Box:
    tx, ty, tw, th = logo.tile
    side = max(tw, th)
    return tx - (side - tw) / 2, ty - (side - th) / 2, side, side


def write_svgs(logo: Logo) -> None:
    mark_svg = svg_doc(mark_box(logo), svg_paths(fills(logo.mark)), NAME)
    (HERE / "icon.svg").write_text(mark_svg, encoding="utf-8", newline="\n")
    (BRAND_SVG / "sg-mark.svg").write_text(mark_svg, encoding="utf-8", newline="\n")
    master = MASTER.read_text(encoding="utf-8")
    sams = logo.part("sams").fill
    on_dark = master.replace(f'id="sams" fill="{sams}"', f'id="sams" fill="{ON_DARK_TEXT}"')
    (BRAND_SVG / "sg-logo-on-dark.svg").write_text(on_dark, encoding="utf-8", newline="\n")
    cutouts = "".join(p.d for p in logo.mark if p.id != "tile")
    for name, color in (("black", "#000000"), ("white", "#ffffff")):
        # a mask keeps the cut-outs transparent whatever the background
        body = (f'  <defs><mask id="cut" maskUnits="userSpaceOnUse">\n'
                f'    <path fill="#fff" d="{logo.part("tile").d}"/>\n'
                f'    <path fill="#000" fill-rule="evenodd" d="{cutouts}"/>\n'
                f"  </mask></defs>\n"
                f'  <path fill="{color}" mask="url(#cut)" d="{logo.part("tile").d}"/>')
        (BRAND_SVG / f"sg-mark-{name}.svg").write_text(svg_doc(mark_box(logo), body, NAME), encoding="utf-8", newline="\n")


# ------------------------------------------------------------------------------------------------ main


def main() -> None:
    logo = load_master()
    BRAND_SVG.mkdir(parents=True, exist_ok=True)
    BRAND_PNG.mkdir(parents=True, exist_ok=True)
    write_svgs(logo)

    # PWA and page icons
    for size in (192, 512):
        mark_image(logo, size).save(HERE / f"icon-{size}.png", optimize=True)
        full_bleed(logo, size, safe=0.38).save(HERE / f"icon-{size}-maskable.png", optimize=True)
    full_bleed(logo, 180, safe=0.42).convert("RGB").save(HERE / "apple-touch-icon.png", optimize=True)
    small = {s: mark_image(logo, s) for s in (16, 24, 32, 48, 64, 128, 256)}
    small[32].save(HERE / "favicon-32.png", optimize=True)
    small[48].save(HERE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[small[16], small[32]])
    ico = sorted(small)
    small[256].save(HERE / "icon.ico", sizes=[(s, s) for s in ico], append_images=[small[s] for s in ico if s != 256])
    social = poster(logo, 1280, 640, 940, 34, True)
    social.convert("RGB").save(HERE / "social-1280x640.png", optimize=True)

    # branding set
    logo_image(logo, 1600).save(BRAND_PNG / "sg-logo.png", optimize=True)
    logo_image(logo, 1600, on_dark=True).save(BRAND_PNG / "sg-logo-on-dark.png", optimize=True)
    mark_image(logo, 1024).save(BRAND_PNG / "sg-app-icon-1024.png", optimize=True)
    for name, color in (("black", (0, 0, 0)), ("white", (255, 255, 255))):
        img = Image.new("RGBA", (512, 512), (*color, 0))
        img.putalpha(mono_mask(logo, 512))
        img.save(BRAND_PNG / f"sg-mark-{name}.png", optimize=True)
    poster(logo, 1200, 300, 560, 20, False).convert("RGB").save(BRAND_PNG / "sg-banner-1200x300.png", optimize=True)
    social.convert("RGB").save(BRAND_PNG / "sg-social-1280x640.png", optimize=True)

    for f in sorted([*HERE.glob("*.png"), *HERE.glob("*.ico"), *HERE.glob("*.svg"), *BRAND_SVG.glob("*.svg"), *BRAND_PNG.glob("*.png")]):
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size:,} B")


if __name__ == "__main__":
    main()
