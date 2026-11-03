// 裝成 app（PWA）用的圖示：從 src/app/icon.svg 產生 public/icons/ 的 192 / 512 與 Android 的 maskable 版。
// maskable：整張滿版漸層（系統會自己裁成圓形 / 圓角），圖案縮到中間 80% 的安全區內。圖示或品牌色改了就重跑：
//   cd src/frontend && node scripts/app-icons.mjs
// Icons for installing Telepy as an app (PWA): renders public/icons/ (192, 512 and Android's maskable one) from
// src/app/icon.svg. Maskable = a full-bleed gradient (the OS crops it to a circle / squircle) with the glyph shrunk into
// the central 80% safe zone. Re-run whenever the icon or the brand colours change.
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = readFileSync(`${root}src/app/icon.svg`, "utf8");
const out = `${root}public/icons`;
mkdirSync(out, { recursive: true });

// 圖案的外接框對角一半約 31 單位；安全區半徑 = 64 × 0.4 = 25.6，縮 0.72 倍後約 22.5，留一點邊。
// The glyph's half-diagonal is about 31 units; the safe zone's radius is 64 × 0.4 = 25.6, so 0.72 leaves ~22.5.
const glyphStart = svg.indexOf("<g ");
const glyphEnd = svg.lastIndexOf("</svg>");
if (glyphStart < 0 || !svg.includes('rx="15"')) throw new Error("icon.svg changed shape; update scripts/app-icons.mjs");
const maskable = svg.slice(0, glyphStart).replace(' rx="15"', "") + `<g transform="translate(32 32) scale(0.72) translate(-32 -32)">` + svg.slice(glyphStart, glyphEnd) + "</g></svg>";

const render = (source, size, file) => sharp(Buffer.from(source), { density: (72 * size) / 64 }).resize(size, size).png({ compressionLevel: 9 }).toFile(`${out}/${file}`);

await render(svg, 192, "icon-192.png");
await render(svg, 512, "icon-512.png");
await render(maskable, 512, "icon-maskable-512.png");
console.log("wrote public/icons/icon-192.png, icon-512.png, icon-maskable-512.png");
