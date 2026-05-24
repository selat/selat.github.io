"""Trace _reference.png into per-view SVG files with named muscle paths.

Pipeline:
1. Split image at the gap column between the two figures.
2. For each half:
   a. Body silhouette: all non-white pixels → outer contour → solid filled
      shape via potrace → smooth Bezier silhouette path (#body).
   b. Muscle mask: red pixels (the reference shows all muscles in red).
      Each connected component → one muscle path via potrace.
   c. Apply hand-curated FRONT_LABELS / BACK_LABELS table mapping the
      component index to a muscle key.
3. Emit body-front.svg + body-back.svg (production, class-tagged paths,
   no inline fills) and _trace-front.svg + _trace-back.svg (debug,
   each component in a distinct color + numeric labels) into OUT_DIR.

Setup:
    python3 -m venv .venv
    .venv/bin/pip install pillow opencv-python numpy
    brew install potrace
    .venv/bin/python gym/assets/_trace.py

Re-labeling after swapping the reference: regenerate, view the
_trace-*.svg debug files, then update FRONT_LABELS / BACK_LABELS below.
"""
import cv2
import numpy as np
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = str(HERE / "_reference.png")
OUT_DIR = HERE
OUT_DIR.mkdir(parents=True, exist_ok=True)

img = cv2.imread(SRC)
H, W = img.shape[:2]

# Color masks (BGR space) for the all-red reference. Red has strong contrast
# against white background, so anti-aliased edge pixels stay clearly inside
# the mask. Body silhouette is a thin gray outline + the muscles themselves.
g = img.astype(int)
nonwhite = (img.min(axis=2) < 230)
red = (g[:,:,2] > 140) & (g[:,:,1] < 160) & (g[:,:,0] < 160) & (g[:,:,2] - g[:,:,0] > 30)

muscle_mask = red.astype(np.uint8) * 255
body_mask   = nonwhite.astype(np.uint8) * 255

# --- Split front/back ---
col_density = nonwhite.sum(axis=0)
# Find the longest empty column run in the middle 50% of width
mid_lo = W // 3
mid_hi = 2 * W // 3
empty_cols = np.where(col_density[mid_lo:mid_hi] == 0)[0] + mid_lo
if len(empty_cols) == 0:
    raise SystemExit("No gap found between front/back figures")
SPLIT = int(np.median(empty_cols))
print(f"Split column: {SPLIT}")

# --- Crop each half to its bounding box ---
def bbox_of(mask):
    ys, xs = np.where(mask > 0)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

def crop_half(left, right):
    """Crop to the bbox of the body figure (the largest non-white component
    is the silhouette outline; its bbox encloses the whole figure). The full
    body mask within that bbox keeps muscle interiors AS PART OF the body."""
    bm = body_mask[:, left:right]
    mm = muscle_mask[:, left:right]
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bm, connectivity=8)
    if n < 2:
        raise SystemExit("No body found in half")
    # Largest = the dark-gray silhouette outline. Its bbox covers the figure.
    biggest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    x0 = stats[biggest, cv2.CC_STAT_LEFT]
    y0 = stats[biggest, cv2.CC_STAT_TOP]
    w  = stats[biggest, cv2.CC_STAT_WIDTH]
    h  = stats[biggest, cv2.CC_STAT_HEIGHT]
    x1, y1 = x0 + w, y0 + h
    # Union: outline + all muscle interior components, anything non-white inside
    # the figure bbox forms the silhouette. Components outside (legend) are
    # eliminated by the bbox crop.
    bm_cropped = bm[y0:y1, x0:x1]
    mm_cropped = mm[y0:y1, x0:x1]
    return bm_cropped, mm_cropped, (x0, y0, x1, y1)

front_body, front_muscle, front_bb = crop_half(0, SPLIT)
back_body, back_muscle, back_bb = crop_half(SPLIT, W)
print(f"Front: {front_body.shape}  bbox {front_bb}")
print(f"Back:  {back_body.shape}  bbox {back_bb}")


# --- Vectorize a binary mask via potrace ---
import subprocess, re, tempfile, os

POTRACE_RE = re.compile(r'<path[^>]*\sd="([^"]+)"', re.DOTALL)

def _potrace_mask(mask):
    """Run potrace on a binary mask and return the SVG path d-string in
    mask pixel coordinates. potrace flips y, so we flip back before returning."""
    h, w = mask.shape
    with tempfile.TemporaryDirectory() as td:
        pbm_path = os.path.join(td, "in.pbm")
        svg_path = os.path.join(td, "out.svg")
        # Potrace PBM: 1 = black (foreground), 0 = white. We want muscle pixels
        # as foreground.
        with open(pbm_path, "wb") as f:
            f.write(f"P4\n{w} {h}\n".encode())
            # Pack bits row-major, MSB first.
            packed = np.packbits((mask > 0).astype(np.uint8), axis=1, bitorder="big")
            f.write(packed.tobytes())
        # --turdsize: ignore specks; -O: optimization tolerance; -u: units per pixel
        # so output coords map 1:1 to source pixels. -a: corner sensitivity.
        subprocess.run(
            ["potrace", pbm_path, "--svg", "-o", svg_path,
             "--turdsize", "2", "-O", "0.2", "-u", "1", "-a", "1"],
            check=True, capture_output=True,
        )
        svg_text = open(svg_path).read()
    m = POTRACE_RE.search(svg_text)
    if not m:
        return None
    d = m.group(1)
    # Potrace emits a transform="translate(0,H) scale(0.1,-0.1)" — coords are in
    # tenths of a pixel and the y axis is flipped. Reparse and undo that.
    return _renormalize_potrace_path(d, h)

# Path token regex: command letter or signed decimal number.
_TOK = re.compile(r'[MmLlCcZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?')

def _renormalize_potrace_path(d, height_px):
    """Potrace outputs in pixel units (we passed -u 1) with y growing UP
    around (0, H) (its transform="translate(0,H) scale(1,-1)"). Convert to
    pixel coords with y growing DOWN, expand relative commands to absolute,
    and expand implicit command continuation (e.g. `c 6coords 6coords 6coords`
    is three curves)."""
    tokens = _TOK.findall(d)
    i = 0
    cmd = None
    cur_x = cur_y = 0.0
    start_x = start_y = 0.0
    out = []
    def emit_pt(x, y):
        return f"{x:.3f} {(height_px - y):.3f}"

    while i < len(tokens):
        tok = tokens[i]
        if tok in "MmLlCcZz":
            cmd = tok
            i += 1
            if cmd in "Zz":
                out.append("Z")
                cur_x, cur_y = start_x, start_y
                cmd = None
                continue
        if cmd is None:
            i += 1
            continue
        # Consume operand(s) for the current command.
        if cmd in "Mm":
            x = float(tokens[i]); y = float(tokens[i+1]); i += 2
            if cmd == "m":
                x += cur_x; y += cur_y
            cur_x, cur_y = x, y
            start_x, start_y = x, y
            out.append(f"M{emit_pt(x, y)}")
            # Per SVG spec: subsequent pairs after M/m are implicit L/l.
            cmd = "L" if cmd == "M" else "l"
        elif cmd in "Ll":
            x = float(tokens[i]); y = float(tokens[i+1]); i += 2
            if cmd == "l":
                x += cur_x; y += cur_y
            cur_x, cur_y = x, y
            out.append(f"L{emit_pt(x, y)}")
        elif cmd in "Cc":
            coords = [float(tokens[i+k]) for k in range(6)]; i += 6
            if cmd == "c":
                base = [cur_x, cur_y] * 3
                coords = [c + b for c, b in zip(coords, base)]
            out.append(f"C{emit_pt(coords[0], coords[1])} {emit_pt(coords[2], coords[3])} {emit_pt(coords[4], coords[5])}")
            cur_x, cur_y = coords[4], coords[5]
    return " ".join(out)


def mask_to_path(mask, scale_x, scale_y):
    """Run potrace on a single-component mask and return an SVG d string in
    viewBox coordinates. Coords get scaled to fit the target viewBox."""
    raw = _potrace_mask(mask)
    if not raw:
        return ""
    # Now scale every numeric coord by (scale_x, scale_y).
    def scale_pair(m):
        x = float(m.group(1)); y = float(m.group(2))
        return f"{x*scale_x:.3f} {y*scale_y:.3f}"
    return re.sub(r'(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', scale_pair, raw)


# --- Trace a half ---
def trace_half(body_mask, muscle_mask, view_w=200, view_h=520, name=""):
    h, w = body_mask.shape
    # Scale factors to map source pixels into the chosen viewBox
    sx = view_w / w
    sy = view_h / h

    # Body silhouette: the union mask has white separator-line holes everywhere
    # (which would each become their own potrace path). Fill the outer
    # contour to get a solid figure shape, then trace.
    cnts, _ = cv2.findContours(body_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    solid = np.zeros_like(body_mask)
    cv2.drawContours(solid, cnts, -1, 255, thickness=cv2.FILLED)
    body_path = mask_to_path(solid, sx, sy)

    # Muscle components: each isolated blob in muscle_mask. Use 4-connectivity
    # so muscles touching only at single diagonal pixels stay separate.
    num, labels, stats, centroids = cv2.connectedComponentsWithStats(muscle_mask, connectivity=4)
    muscles = []
    for label in range(1, num):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < 200:
            continue
        x = stats[label, cv2.CC_STAT_LEFT]
        y = stats[label, cv2.CC_STAT_TOP]
        bw = stats[label, cv2.CC_STAT_WIDTH]
        bh = stats[label, cv2.CC_STAT_HEIGHT]
        cx, cy = centroids[label]
        comp_mask = (labels == label).astype(np.uint8) * 255
        path = mask_to_path(comp_mask, sx, sy)
        if not path:
            continue
        muscles.append({
            "label": label,
            "area": int(area),
            "bbox": [int(x), int(y), int(bw), int(bh)],
            "cx_norm": cx / w,
            "cy_norm": cy / h,
            "cx_view": cx * sx,
            "cy_view": cy * sy,
            "path": path,
        })
    # Sort by cy then cx for stable iteration
    muscles.sort(key=lambda m: (m["cy_norm"], m["cx_norm"]))
    return body_path, muscles, (sx, sy)


# Component index → muscle key (None = drop).
# Indices are stable as long as the tracer's filtering and sort order don't
# change. If component count drifts, re-run with PALETTE-colored numbers and
# revise this map.
FRONT_LABELS = {
    # 0-6: face/clavicle small bits — drop
    7: 'delts', 8: 'delts',
    9: 'chest', 10: 'chest',
    11: 'biceps', 12: 'biceps',
    13: 'core', 14: 'core',          # top ab cells
    15: 'core', 16: 'core',
    17: 'core', 18: 'core',          # serratus/oblique tall slabs
    19: 'core', 20: 'core',
    21: 'forearm', 22: 'forearm',    # upper forearm
    23: 'forearm', 24: 'forearm',    # lower forearm
    25: 'core', 26: 'core',          # lower abs
    # 27, 28: TFL / hip — drop
    29: 'quads', 30: 'quads',        # adductors → quads (grouped with leg muscles)
    31: 'quads', 32: 'quads',        # main quad bellies (rectus femoris + vastus lateralis)
    33: 'quads', 34: 'quads',        # vastus medialis teardrops
    35: 'calves', 36: 'calves',      # tibialis anterior
    37: 'calves', 38: 'calves',      # peroneus / outer gastroc
    # 39-43: feet/toes — drop
}

BACK_LABELS = {
    0: 'traps', 1: 'traps',          # trap descending diamond, both halves
    2: 'delts', 3: 'delts',          # rear delts
    4: 'back', 5: 'back',            # infraspinatus / teres area
    6: 'triceps', 7: 'triceps',      # triceps lateral head
    8: 'lats', 9: 'lats',            # main lat wings
    10: 'back', 11: 'back',          # lower lat fragment / serratus posterior
    12: 'forearm', 13: 'forearm',    # upper forearm
    14: 'forearm', 15: 'forearm',    # lower forearm
    16: 'back',                       # central lower back (erector spinae)
    17: 'back', 18: 'back',          # back side bits
    19: 'glutes', 20: 'glutes',      # gluteus medius (smaller upper)
    21: 'glutes', 22: 'glutes',      # main gluteus maximus
    23: 'hams', 24: 'hams',          # IT band / outer thigh
    25: 'hams', 26: 'hams',          # inner upper hams
    27: 'hams', 28: 'hams',          # main hamstring bellies
    # 29: tiny detail — drop
    30: 'calves', 31: 'calves',
    32: 'calves', 33: 'calves',
    34: 'calves', 35: 'calves',      # lower calf / soleus
    36: 'calves', 37: 'calves',      # achilles tendon area
}


def emit_svg(out_path, view_w, view_h, body_path, muscles, labels):
    """Production output: silhouette path + class-tagged muscle paths.
    No inline fills — the runtime sets them based on recovery state."""
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view_w} {view_h}">']
    parts.append(f'  <path id="body" d="{body_path}"/>')
    parts.append('  <g id="muscles">')
    kept = 0
    by_key = {}
    for i, m in enumerate(muscles):
        key = labels.get(i)
        if key is None:
            continue
        kept += 1
        by_key[key] = by_key.get(key, 0) + 1
        parts.append(f'    <path class="muscle muscle-{key}" d="{m["path"]}"/>')
    parts.append('  </g>')
    parts.append('</svg>')
    Path(out_path).write_text("\n".join(parts))
    print(f"Wrote {out_path}: kept {kept}/{len(muscles)} components")
    for k in sorted(by_key):
        print(f"    {k}: {by_key[k]} path(s)")


PALETTE = [
    "#e74c3c","#2ecc71","#3498db","#f39c12","#9b59b6","#1abc9c",
    "#e67e22","#16a085","#2980b9","#c0392b","#27ae60","#8e44ad",
    "#d35400","#f1c40f","#34495e","#7f8c8d","#e84393","#00b894",
    "#fdcb6e","#6c5ce7","#fab1a0","#55efc4","#ffeaa7","#a29bfe",
    "#74b9ff","#ff7675","#81ecec","#dfe6e9","#fd79a8","#00cec9",
    "#b2bec3","#636e72","#d63031","#0984e3","#e17055","#00b894",
]


def emit_debug_svg(out_path, view_w, view_h, body_path, muscles):
    """Debug-only: every component in its own color + numeric label so the
    label mapping above can be revised against the screenshot."""
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view_w} {view_h}">']
    parts.append(f'  <path id="body" d="{body_path}" fill="#3a3e3a"/>')
    parts.append('  <g class="muscles">')
    for i, m in enumerate(muscles):
        color = PALETTE[i % len(PALETTE)]
        parts.append(f'    <path data-idx="{i}" d="{m["path"]}" fill="{color}"/>')
    parts.append('  </g>')
    parts.append('  <g class="labels" font-family="monospace" font-size="8" font-weight="bold" fill="#000" stroke="#fff" stroke-width="0.3" paint-order="stroke" text-anchor="middle">')
    for i, m in enumerate(muscles):
        parts.append(f'    <text x="{m["cx_view"]:.1f}" y="{m["cy_view"]:.1f}">{i}</text>')
    parts.append('  </g>')
    parts.append('</svg>')
    Path(out_path).write_text("\n".join(parts))


# --- Run for both views ---
view_w, view_h = 200, 520
front_body_path, front_muscles, _ = trace_half(front_body, front_muscle, view_w, view_h, "front")
back_body_path, back_muscles, _ = trace_half(back_body, back_muscle, view_w, view_h, "back")

emit_svg(OUT_DIR / "body-front.svg", view_w, view_h, front_body_path, front_muscles, FRONT_LABELS)
emit_svg(OUT_DIR / "body-back.svg",  view_w, view_h, back_body_path,  back_muscles,  BACK_LABELS)
emit_debug_svg(OUT_DIR / "_trace-front.svg", view_w, view_h, front_body_path, front_muscles)
emit_debug_svg(OUT_DIR / "_trace-back.svg",  view_w, view_h, back_body_path,  back_muscles)

# Dump the muscle metadata so we can review centers and decide on labels.
def dump_meta(muscles, name):
    print(f"\n--- {name} ({len(muscles)} components) ---")
    print(f"{'idx':>3}  {'cx%':>5}  {'cy%':>5}  {'area':>6}  {'w':>3}x{'h':>3}")
    for i, m in enumerate(muscles):
        print(f"{i:>3}  {m['cx_norm']*100:>5.1f}  {m['cy_norm']*100:>5.1f}  "
              f"{m['area']:>6}  {m['bbox'][2]:>3}x{m['bbox'][3]:>3}")

dump_meta(front_muscles, "FRONT")
dump_meta(back_muscles, "BACK")

# Save metadata as JSON for future labeling pass.
meta = {
    "view_w": view_w, "view_h": view_h,
    "front": [{k: m[k] for k in ["cx_norm","cy_norm","area","bbox","cx_view","cy_view"]} for m in front_muscles],
    "back":  [{k: m[k] for k in ["cx_norm","cy_norm","area","bbox","cx_view","cy_view"]} for m in back_muscles],
}
Path("/tmp/trace-meta.json").write_text(json.dumps(meta, indent=2))
