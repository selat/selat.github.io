"""Generate Gym PWA icons. Phosphor-green "armed dot" — solid disc
inside a thin aim ring — on a near-black background. Mirrors the
RECORD tab glyph so the app icon and its primary action read as the
same thing.
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Palette matches theme.css.
DARK_BG   = (10, 11, 10)        # --bg
DARK_SURF = (15, 17, 16)        # --surface
INK       = (232, 240, 230)
LINE      = (42, 46, 42)
# Phosphor green: oklch(0.85 0.18 142) ≈ #6FE06B in sRGB
PHOSPHOR  = (111, 224, 107)
PHOSPHOR_DIM = (50, 110, 48)


def draw_icon(canvas_size, scale=0.78, bg=DARK_BG):
    """Draw the armed-dot motif. scale = outer-ring diameter as fraction
    of canvas. bg = opaque background color tuple, or None for transparent."""
    SS = 4  # supersample for AA
    s = canvas_size * SS
    bg_rgba = (bg[0], bg[1], bg[2], 255) if bg else (0, 0, 0, 0)
    img = Image.new("RGBA", (s, s), bg_rgba)
    d = ImageDraw.Draw(img)

    cx = cy = s / 2

    # Faint dot-grid backdrop (only when bg is opaque).
    if bg:
        grid_step = s // 18
        grid_color = (28, 36, 28, 70)
        for gx in range(0, s, grid_step):
            for gy in range(0, s, grid_step):
                d.point((gx, gy), fill=grid_color)

    R_outer = (s / 2) * scale            # outer aim ring
    R_inner = R_outer * 0.55             # solid disc
    rim_w   = max(3, int(s * 0.012))     # outer ring stroke width

    # Outer aim ring — thin stroke
    d.ellipse(
        [cx - R_outer, cy - R_outer, cx + R_outer, cy + R_outer],
        outline=PHOSPHOR_DIM, width=rim_w,
    )
    # Crosshair tick marks at N/E/S/W
    tick_len = R_outer * 0.18
    tick_w   = max(2, int(s * 0.010))
    for dx, dy in [(0, -1), (1, 0), (0, 1), (-1, 0)]:
        x1 = cx + dx * (R_outer - tick_len)
        y1 = cy + dy * (R_outer - tick_len)
        x2 = cx + dx * (R_outer + tick_len * 0.3)
        y2 = cy + dy * (R_outer + tick_len * 0.3)
        d.line([(x1, y1), (x2, y2)], fill=PHOSPHOR_DIM, width=tick_w)

    # Inner solid disc — the "armed" record indicator
    d.ellipse(
        [cx - R_inner, cy - R_inner, cx + R_inner, cy + R_inner],
        fill=PHOSPHOR,
    )

    # Subtle inner highlight ring inside the disc
    inner_hl = R_inner * 0.78
    d.ellipse(
        [cx - inner_hl, cy - inner_hl, cx + inner_hl, cy + inner_hl],
        outline=(150, 235, 145, 180), width=max(1, int(s * 0.004)),
    )

    return img.resize((canvas_size, canvas_size), Image.LANCZOS)


def main():
    # Standard icons — motif fills the canvas, transparent background.
    draw_icon(192, scale=0.86, bg=None).save(os.path.join(OUT_DIR, "icon-192.png"))
    draw_icon(512, scale=0.86, bg=None).save(os.path.join(OUT_DIR, "icon-512.png"))

    # Maskable — inside safe-zone circle, opaque dark background.
    draw_icon(512, scale=0.62, bg=DARK_BG).save(
        os.path.join(OUT_DIR, "icon-512-maskable.png"))

    # Apple touch — opaque (iOS strips alpha, applies its own rounded mask).
    draw_icon(180, scale=0.80, bg=DARK_BG).save(
        os.path.join(OUT_DIR, "icon-apple-180.png"))

    print("Wrote: icon-192.png, icon-512.png, icon-512-maskable.png, icon-apple-180.png")


if __name__ == "__main__":
    main()
