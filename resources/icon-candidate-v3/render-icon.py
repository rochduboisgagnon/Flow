"""AGR Flow bespoke app icon (v3 chantier 7) - Apple-style squircle, premium depth.
Inspired by the AGR family (deep-green squircle + mint accent) but distinct: the
static mic becomes the FLOW listening ribbon/waveform, the motif used everywhere the
app listens. Pure Pillow (no SVG rasterizer available), supersampled x4 for clean AA.
"""
import math, sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024          # final size
SS = 4            # supersample factor
W = S * SS

def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t): return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(len(c1)))

# ---- superellipse (squircle) mask, Apple-like continuous corner ----
def squircle_mask(size, n=5.0, inset=0):
    m = Image.new("L", (size, size), 0)
    px = m.load()
    cx = cy = (size - 1) / 2.0
    r = (size - 1) / 2.0 - inset
    # signed coverage via a small analytic AA: sample the superellipse value
    for y in range(size):
        ny = (y - cy) / r
        for x in range(size):
            nx = (x - cx) / r
            v = abs(nx) ** n + abs(ny) ** n
            if v <= 1.0:
                px[x, y] = 255
    return m.filter(ImageFilter.GaussianBlur(size / 900.0))

# ---- vertical gradient fill ----
def vgrad(size, top, bot):
    g = Image.new("RGB", (1, size))
    gp = g.load()
    for y in range(size):
        gp[0, y] = mix(top, bot, y / (size - 1))
    return g.resize((size, size))

def radial_glow(size, color, cx, cy, radius, max_alpha):
    g = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(g)
    steps = 60
    for i in range(steps, 0, -1):
        t = i / steps
        rr = radius * t
        a = int(max_alpha * (1 - t) ** 1.6)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=a)
    glow = Image.new("RGB", (size, size), color)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(glow, (0, 0), g)
    return out

# ---- build background ----
bg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
EMERALD_TOP = (0x14, 0x40, 0x35)     # rich emerald
GRAPHITE_BOT = (0x08, 0x16, 0x12)    # deep graphite-green
grad = vgrad(W, EMERALD_TOP, GRAPHITE_BOT).convert("RGBA")
bg = Image.alpha_composite(bg, grad)
# upper soft brand glow
bg = Image.alpha_composite(bg, radial_glow(W, (0x34, 0xE3, 0xA0), W * 0.5, W * 0.34, W * 0.55, 60))
# subtle darkening vignette at the very bottom for depth
bg = Image.alpha_composite(bg, radial_glow(W, (0x00, 0x0A, 0x08), W * 0.5, W * 1.02, W * 0.7, 90))

# ---- the FLOW waveform glyph ----
glyph = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glyph)
bars = [0.34, 0.56, 0.80, 1.0, 0.80, 0.56, 0.34]   # symmetric envelope, tall center
n = len(bars)
bar_w = W * 0.072
gap = W * 0.038
total = n * bar_w + (n - 1) * gap
x0 = (W - total) / 2.0
cy = W * 0.50
max_h = W * 0.44
MINT_TOP = (0x8B, 0xF3, 0xCE)
MINT_BOT = (0x25, 0xCF, 0x95)
bar_grad = vgrad(W, MINT_TOP, MINT_BOT).convert("RGBA")
mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
for i, h in enumerate(bars):
    bx = x0 + i * (bar_w + gap)
    bh = max_h * h
    r = bar_w / 2.0
    md.rounded_rectangle([bx, cy - bh / 2, bx + bar_w, cy + bh / 2], radius=r, fill=255)
glyph = Image.new("RGBA", (W, W), (0, 0, 0, 0))
glyph.paste(bar_grad, (0, 0), mask)

# glow behind the glyph (blurred brighter copy)
glow_src = Image.new("RGBA", (W, W), (0, 0, 0, 0))
glow_src.paste(Image.new("RGBA", (W, W), (0x5A, 0xF0, 0xC0, 255)), (0, 0), mask)
glow = glow_src.filter(ImageFilter.GaussianBlur(W * 0.020))
glow.putalpha(glow.getchannel("A").point(lambda a: int(a * 0.55)))

# ---- compose ----
comp = Image.alpha_composite(bg, glow)
comp = Image.alpha_composite(comp, glyph)

# top specular highlight for glassy Apple depth
spec = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sd = ImageDraw.Draw(spec)
sd.ellipse([W * 0.10, -W * 0.42, W * 0.90, W * 0.30], fill=(255, 255, 255, 26))
spec = spec.filter(ImageFilter.GaussianBlur(W * 0.02))
comp = Image.alpha_composite(comp, spec)

# inner rim light on the squircle edge
rim = squircle_mask(W, n=5.0, inset=0)
rim_inner = squircle_mask(W, n=5.0, inset=int(W * 0.006))
rim_edge = Image.new("L", (W, W), 0)
rim_edge.paste(rim, (0, 0))
from PIL import ImageChops
rim_edge = ImageChops.subtract(rim, rim_inner).point(lambda a: int(a * 0.5))
rim_img = Image.new("RGBA", (W, W), (0xBF, 0xFF, 0xE6, 255))
comp = Image.alpha_composite(comp, Image.merge("RGBA", (*rim_img.split()[:3], rim_edge)))

# apply the squircle mask
final = Image.new("RGBA", (W, W), (0, 0, 0, 0))
final.paste(comp, (0, 0), squircle_mask(W, n=5.0, inset=0))

# downsample to final size with high-quality AA
final = final.resize((S, S), Image.LANCZOS)

out_dir = sys.argv[1]
final.save(out_dir + "/agr-flow-icon-1024.png")
for sz in (512, 256, 180, 128, 64, 32):
    final.resize((sz, sz), Image.LANCZOS).save(out_dir + f"/agr-flow-icon-{sz}.png")
# a .ico bundle
final.resize((256, 256), Image.LANCZOS).save(
    out_dir + "/agr-flow-icon.ico",
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("rendered AGR Flow icon set ->", out_dir)
