"""Trace the SAM's Garage logo (branding/source/sams-garage-logo.png) into the master vector, branding/svg/sg-logo.svg.

Run it once when the source artwork changes; everything else (site icons, favicons, the Windows .ico, the
branding set) is generated from the SVG by site/icons/make-icons.py, so the SVG is the file to edit afterwards.

How: every opaque pixel is labelled with the logo part it belongs to (by its color, and by position for the two
pairs of parts that share a color: the tile vs the "SAM's" text, and the S vs the star). Each part's mask is
upsampled 2x and traced with potrace into smooth curves, and each part is written as one even-odd path filled with
the mean color of its pixels. Layers stack in paint order: tile, mark teal, S, star, then the two text colors.

Output paths use only absolute M / L / C / Z commands, which make-icons.py rasterizes without an SVG library.

Usage: python branding/trace-logo.py      (needs numpy, Pillow and the potrace bindings: pip install potracer
                                           or pypotrace)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import potrace
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "branding" / "source" / "sams-garage-logo.png"
OUT = ROOT / "branding" / "svg" / "sg-logo.svg"

SCALE = 2           # trace at 2x for smoother curves
SMOOTH = 2.0        # Gaussian blur (2x pixels) before thresholding: irons out the source's noisy edges
OPTTOLERANCE = 0.6  # potrace curve optimization: higher merges more segments
MARK_MAX_X = 690    # source pixels: the icon tile ends at x=670, the text starts at x=722
STAR_BOX = (480, 270, 615, 395)  # x0, y0, x1, y1: the star (same color family as the S)

# Reference colors per part (measured from the source); a pixel takes the nearest one in its region.
MARK_REFS = {"tile": (3, 23, 39), "teal": (19, 190, 185), "light": (231, 236, 243)}
TEXT_REFS = {"navy": (1, 35, 63), "textteal": (2, 176, 176)}
# Paint order and SVG ids.
LAYERS = ["tile", "teal", "s", "star", "navy", "textteal"]
IDS = {"tile": "tile", "teal": "door", "s": "s", "star": "star", "navy": "sams", "textteal": "garage"}


def nearest(rgb: np.ndarray, refs: dict[str, tuple[int, int, int]]) -> np.ndarray:
    names = list(refs)
    ref = np.array([refs[n] for n in names], float)
    d = ((rgb[..., None, :] - ref[None, None]) ** 2).sum(-1)
    return np.array(names)[d.argmin(-1)]


def label(img: np.ndarray) -> tuple[dict[str, np.ndarray], dict[str, str]]:
    rgb, alpha = img[..., :3].astype(float), img[..., 3]
    h, w = alpha.shape
    solid = alpha >= 128
    xs = np.broadcast_to(np.arange(w), (h, w))
    ys = np.broadcast_to(np.arange(h)[:, None], (h, w))
    in_mark = xs < MARK_MAX_X
    in_star = (xs >= STAR_BOX[0]) & (xs < STAR_BOX[2]) & (ys >= STAR_BOX[1]) & (ys < STAR_BOX[3])

    mark_lab = nearest(rgb, MARK_REFS)
    text_lab = nearest(rgb, TEXT_REFS)
    masks = {
        # the tile is the whole rounded square: the other mark parts are painted over it
        "tile": solid & in_mark,
        "teal": solid & in_mark & (mark_lab == "teal"),
        "s": solid & in_mark & ~in_star & (mark_lab == "light"),
        "star": solid & in_mark & in_star & (mark_lab == "light"),
        "navy": solid & ~in_mark & (text_lab == "navy"),
        "textteal": solid & ~in_mark & (text_lab == "textteal"),
    }
    colors = {}
    for name, m in masks.items():
        # the color of the part's own pixels (for the tile: only where the tile shows, not the parts painted on it)
        own = m & (mark_lab == "tile") if name == "tile" else m
        core = own & (alpha >= 250)
        mean = rgb[core].mean(0) if core.any() else rgb[own].mean(0)
        colors[name] = "#%02x%02x%02x" % tuple(int(round(v)) for v in mean)
    return masks, colors


def fmt(v: float) -> str:
    return f"{v:.1f}".removesuffix(".0")


def rounded_rect(mask: np.ndarray) -> tuple[str, tuple[int, int, int, int, float]]:
    """The tile as an exact rounded square: box from the mask, corner radius from the area the corners cut off
    (a w x h box with radius r loses (4 - pi) r^2)."""
    ys, xs = np.where(mask)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    cut = (x1 - x0) * (y1 - y0) - mask.sum()
    r = float(np.sqrt(max(cut, 0) / (4 - np.pi)))
    k = r * (1 - 0.5523)  # cubic Bezier quarter-circle handle offset
    d = (f"M{fmt(x0 + r)} {y0}L{fmt(x1 - r)} {y0}C{fmt(x1 - k)} {y0} {x1} {fmt(y0 + k)} {x1} {fmt(y0 + r)}"
         f"L{x1} {fmt(y1 - r)}C{x1} {fmt(y1 - k)} {fmt(x1 - k)} {y1} {fmt(x1 - r)} {y1}"
         f"L{fmt(x0 + r)} {y1}C{fmt(x0 + k)} {y1} {x0} {fmt(y1 - k)} {x0} {fmt(y1 - r)}"
         f"L{x0} {fmt(y0 + r)}C{x0} {fmt(y0 + k)} {fmt(x0 + k)} {y0} {fmt(x0 + r)} {y0}Z")
    return d, (int(x0), int(y0), int(x1 - x0), int(y1 - y0), r)


def star(mask: np.ndarray) -> str:
    """The star as an exact five-point star fitted to the mask: center at the centroid, outer radius at the
    tips, inner radius at the notches, rotation from the tip nearest straight up."""
    ys, xs = np.where(mask)
    cx, cy = xs.mean(), ys.mean()
    # the boundary: mask pixels with a non-mask 4-neighbour
    m = np.pad(mask, 1)
    edge = mask & ~(m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:])
    ey, ex = np.where(edge)
    ang = np.arctan2(ey - cy, ex - cx)
    rad = np.hypot(ex - cx, ey - cy)
    # radius profile in 360 one-degree bins
    bins = ((np.degrees(ang) + 360) % 360).astype(int)
    prof = np.zeros(360)
    np.maximum.at(prof, bins, rad)
    outer = np.percentile(prof[prof > 0], 97)
    tip = float(np.radians(np.argmax(prof)))  # the angle of a tip
    # the five tips are 72 degrees apart; choose the one nearest straight up (-90 degrees)
    tips = [tip + i * 2 * np.pi / 5 for i in range(5)]
    top = min(tips, key=lambda a: abs(((a + np.pi / 2 + np.pi) % (2 * np.pi)) - np.pi))
    notch_bins = [int((np.degrees(t + np.pi / 5) + 360) % 360) for t in tips]
    inner = float(np.median([prof[b] for b in notch_bins if prof[b] > 0]))
    pts = []
    for i in range(10):
        a = top + i * np.pi / 5
        rr = outer if i % 2 == 0 else inner
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    return "M" + "L".join(f"{fmt(x)} {fmt(y)}" for x, y in pts) + "Z"


def upsample(mask: np.ndarray) -> np.ndarray:
    im = Image.fromarray((mask * 255).astype(np.uint8)).resize((mask.shape[1] * SCALE, mask.shape[0] * SCALE), Image.LANCZOS)
    im = im.filter(ImageFilter.GaussianBlur(SMOOTH))
    return np.asarray(im) >= 128


def trace(mask: np.ndarray) -> str:
    bm = potrace.Bitmap(~mask)  # these bindings trace the False pixels
    path = bm.trace(turdsize=8, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=1.0, opticurve=True, opttolerance=OPTTOLERANCE)
    f = lambda p: f"{p.x / SCALE:.1f} {p.y / SCALE:.1f}".replace(".0 ", " ").removesuffix(".0")
    parts = []
    for curve in path:
        sp = curve.start_point
        d = [f"M{f(sp)}"]
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f"L{f(seg.c)}L{f(seg.end_point)}")
            else:
                d.append(f"C{f(seg.c1)} {f(seg.c2)} {f(seg.end_point)}")
        parts.append("".join(d) + "Z")
    return "".join(parts)


def main() -> None:
    img = np.asarray(Image.open(SOURCE).convert("RGBA"))
    masks, colors = label(img)
    ys, xs = np.where(img[..., 3] >= 128)
    pad = 24
    x0, y0, x1, y1 = xs.min() - pad, ys.min() - pad, xs.max() + 1 + pad, ys.max() + 1 + pad
    tile_d, (tx, ty, tw, th, tr) = rounded_rect(masks["tile"])
    tb = (tx, ty, tx + tw, ty + th)

    body = []
    for name in LAYERS:
        d = tile_d if name == "tile" else star(masks[name]) if name == "star" else trace(upsample(masks[name]))
        body.append(f'    <path id="{IDS[name]}" fill="{colors[name]}" fill-rule="evenodd" d="{d}"/>')
        if name == "star":
            body.append("  </g>")
            body.append('  <g id="wordmark">')
    svg = "\n".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0} {y0} {x1 - x0} {y1 - y0}" role="img" aria-labelledby="t">',
        "  <title id=\"t\">SAM's Garage</title>",
        f"  <!-- Traced from branding/source/sams-garage-logo.png by branding/trace-logo.py. The mark's tile is the box",
        f'       {tb[0]} {tb[1]} {tb[2] - tb[0]} {tb[3] - tb[1]} (data-tile on the mark group); make-icons.py reads it. -->',
        f'  <g id="mark" data-tile="{tb[0]} {tb[1]} {tb[2] - tb[0]} {tb[3] - tb[1]}">',
        *body,
        "  </g>",
        "</svg>",
        "",
    ])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(svg):,} bytes); colors {colors}; tile {tw}x{th} at {tx},{ty} radius {tr:.1f}")


if __name__ == "__main__":
    main()
