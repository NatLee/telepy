"""
產生 docs/brand/ 的品牌素材：logo.svg（= app/icon.svg）、logo-lockup(-dark).svg、banner.svg 與 banner.png（1280×640，
GitHub social preview 的尺寸）。字用 jf-openhuninn 轉成路徑，GitHub 與任何看圖軟體都不需要字型。
Builds the brand assets in docs/brand/ with the text converted to outlines from jf-openhuninn.

用法 / Usage:  python3 scripts/brand-assets.py      (run from src/frontend; needs Collecting fonttools
  Downloading fonttools-4.67.0-cp312-cp312-macosx_10_13_universal2.whl.metadata (137 kB)
Downloading fonttools-4.67.0-cp312-cp312-macosx_10_13_universal2.whl (3.1 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 3.1/3.1 MB 14.7 MB/s eta 0:00:00
Installing collected packages: fonttools
Successfully installed fonttools-4.67.0 and the
               frontend's node_modules for sharp, which renders banner.png)
"""
import shutil
import subprocess
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

W = str(Path(__file__).resolve().parents[3])
Path(f"{W}/docs/brand").mkdir(exist_ok=True)
font = TTFont(f"{W}/src/frontend/src/fonts/jf-openhuninn-2.1.ttf")
gs = font.getGlyphSet()
cmap = font.getBestCmap()
upem = font["head"].unitsPerEm

def text_path(s, x, baseline, size, tracking=0.0):
    """路徑 d 與寬度。/ Path data and advance width."""
    scale = size / upem
    pen = SVGPathPen(gs)
    cx = 0.0
    for ch in s:
        g = cmap.get(ord(ch))
        if g is None:
            raise SystemExit(f"missing glyph {ch!r}")
        tp = TransformPen(pen, (scale, 0, 0, -scale, x + cx, baseline))
        gs[g].draw(tp)
        cx += gs[g].width * scale + tracking * size
    return pen.getCommands(), cx - tracking * size

GRAD = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00a368"/><stop offset="1" stop-color="#00a5c3"/></linearGradient>'
GLYPH = '<g fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16H38a12 12 0 0 1 0 24H20"/><path d="M26 32l-8 8 8 8"/></g><circle cx="16" cy="16" r="7" fill="#fff"/>'

def mark(x, y, size):
    s = size / 64
    return f'<g transform="translate({x} {y}) scale({s:.5f})"><rect width="64" height="64" rx="15" fill="url(#g)"/>{GLYPH}</g>'

# 標誌 + 字標（淺色 / 深色）。/ Lockups for light and dark backgrounds.
for name, ink in [("logo-lockup.svg", "#0f172a"), ("logo-lockup-dark.svg", "#f8fafc")]:
    d, w = text_path("Telepy", 84, 52, 54)
    width = int(84 + w + 4)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="72" viewBox="0 0 {width} 72" role="img" aria-label="Telepy"><defs>{GRAD}</defs>{mark(4, 4, 64)}<path d="{d}" fill="{ink}"/></svg>\n'
    open(f"{W}/docs/brand/{name}", "w").write(svg)

# 1280×640 橫幅（GitHub social preview 的尺寸）。/ 1280×640 banner (GitHub social preview size).
title_d, title_w = text_path("Telepy", 300, 318, 132)
tag_d, _ = text_path("Reach every device from your browser.", 132, 430, 40)
feat_d, _ = text_path("Reverse SSH tunnels  ·  Web terminal  ·  Files  ·  LAN jump hosts  ·  MCP", 134, 486, 25)
dots = "".join(f'<circle cx="{x}" cy="{y}" r="1.6"/>' for x in range(40, 1280, 40) for y in range(40, 640, 40))
banner = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="Telepy: reach every device from your browser">
  <defs>
    {GRAD}
    <radialGradient id="glow1" cx="0.18" cy="0.35" r="0.55"><stop offset="0" stop-color="#00a368" stop-opacity="0.28"/><stop offset="1" stop-color="#00a368" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow2" cx="0.85" cy="0.75" r="0.5"><stop offset="0" stop-color="#00a5c3" stop-opacity="0.22"/><stop offset="1" stop-color="#00a5c3" stop-opacity="0"/></radialGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2ee6a6"/><stop offset="1" stop-color="#36c8e8"/></linearGradient>
  </defs>
  <rect width="1280" height="640" fill="#0b1220"/>
  <rect width="1280" height="640" fill="url(#glow1)"/>
  <rect width="1280" height="640" fill="url(#glow2)"/>
  <g fill="#ffffff" fill-opacity="0.06">{dots}</g>
  <g transform="translate(840 150) scale(5.6)" opacity="0.16" fill="none" stroke="url(#line)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 16H38a12 12 0 0 1 0 24H20"/><path d="M26 32l-8 8 8 8"/><circle cx="16" cy="16" r="5" fill="url(#line)" stroke="none"/>
  </g>
  {mark(128, 196, 144)}
  <path d="{title_d}" fill="#f8fafc"/>
  <path d="{tag_d}" fill="#e2e8f0"/>
  <path d="{feat_d}" fill="#94a3b8"/>
  <rect x="132" y="540" width="120" height="6" rx="3" fill="url(#g)"/>
</svg>
'''
open(f"{W}/docs/brand/banner.svg", "w").write(banner)
shutil.copy(f"{W}/src/frontend/src/app/icon.svg", f"{W}/docs/brand/logo.svg")
subprocess.run(
    ["node", "-e", "require('sharp')('../../docs/brand/banner.svg',{density:144}).resize(1280,640).png({compressionLevel:9}).toFile('../../docs/brand/banner.png').then(()=>console.log('banner.png'))"],
    cwd=f"{W}/src/frontend",
    check=True,
)
print("docs/brand updated")
