/**
 * Tapi 版各頁背景的 canvas 畫法（components/auth/TapiShell.tsx 的 `runScene` 用；數學在 lib/tapiStage.ts）：
 * 珍奶的粉圓（登入）、紙飛機與虛線（應用程式連接）、往上飄的終端機字元（CLI）、格子紙與蓋下去的印章（授權）。
 * 每個畫法：`setup` 在尺寸 / 主題 / 解析度改變時、`draw` 每幀、`plop` = 點背景（或戳 Tapi）時的小驚喜。
 * The canvas painters behind each Tapi page (used by `runScene` in components/auth/TapiShell.tsx; maths in
 * lib/tapiStage.ts): tapioca pearls (sign-in), paper planes with dashed trails (app connection), terminal characters
 * drifting up (CLI), grid paper with stamps landing on it (approval). Each painter: `setup` when size / theme /
 * resolution change, `draw` every frame, `plop` = the little surprise on a background click (or a poke).
 */
import {
    GLYPHS,
    PEARL_LAYERS,
    PEARL_PALETTE,
    PEARL_SPRITE,
    PLANE_LAYERS,
    PLANE_PALETTE,
    PLANE_SPRITE,
    STAMP_CHECK,
    STAMP_OK,
    STAMP_SLOTS,
    glyphAt,
    makePearls,
    makePlanes,
    pearlAt,
    pearlCount,
    planeAt,
    planeCount,
    stampAt,
    type TapiScene,
} from "@/lib/tapiStage";

export interface SceneEnv {
    doc: Document;
    width: number;
    height: number;
    ratio: number;
    dark: boolean;
    /** 卡片、Tapi、對話框、頁首的位置（相對畫面）：蓋在這些後面的東西看不到。/ Where the card, Tapi, bubble and header are (things behind them are hidden). */
    avoid: { left: number; top: number; right: number; bottom: number }[];
}

export interface Painter {
    setup(env: SceneEnv): void;
    /** 畫一幀；`local` = 滑鼠在畫面裡的位置。回傳還要不要下一幀（減少動態時：只有點出來的東西還在動才要）。 */
    /** Draws a frame; `local` = the pointer in the page. Returns whether more frames are needed (for reduced motion). */
    draw(ctx: CanvasRenderingContext2D, t: number, dt: number, local: { x: number; y: number } | null, now: number): boolean;
    plop(x: number, y: number, now: number): void;
}

/** 把一張像素格先畫在小 canvas 上（每 px 幾個裝置像素）。/ Pre-draws a pixel grid on a small canvas. */
function sprite(doc: Document, rows: readonly string[], unit: number, ratio: number, palette: Record<string, string>): HTMLCanvasElement {
    const c = doc.createElement("canvas");
    const px = Math.max(1, Math.round(unit * ratio));
    c.width = Math.max(1, rows[0].length * px);
    c.height = Math.max(1, rows.length * px);
    const g = c.getContext("2d")!;
    rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
            const fill = palette[ch];
            if (!fill) return;
            g.fillStyle = fill;
            g.fillRect(x * px, y * px, px, px);
        }),
    );
    return c;
}

/** 滑鼠附近的東西被推開（緩動）。/ Things near the pointer are pushed aside (eased). */
function pushFrom(local: { x: number; y: number } | null, cx: number, cy: number, reach: number, strength: number): [number, number] {
    if (!local) return [0, 0];
    const dx = cx - local.x;
    const dy = cy - local.y;
    const d = Math.hypot(dx, dy);
    if (d >= reach || d < 0.01) return [0, 0];
    const k = ((reach - d) / reach) * strength;
    return [(dx / d) * k, (dy / d) * k];
}

const snapTo = (v: number, unit: number) => Math.round(v / unit) * unit;

interface Burst {
    x: number;
    y: number;
    vx: number;
    vy: number;
    born: number;
    layer: number;
    text?: string;
}

/* ── 珍奶 / Bubble tea ───────────────────────────────────────── */

function teaPainter(): Painter {
    let env: SceneEnv | null = null;
    let pearls = makePearls(0);
    let push = new Float32Array(0);
    let images: HTMLCanvasElement[] = [];
    let counted = "";
    const bursts: Burst[] = [];
    return {
        setup(e) {
            env = e;
            const palette = PEARL_PALETTE[e.dark ? "dark" : "light"];
            images = PEARL_LAYERS.map((l) => sprite(e.doc, PEARL_SPRITE, l.unit, e.ratio, palette));
            const size = `${e.width}x${e.height}`;
            if (size !== counted) {
                counted = size;
                pearls = makePearls(pearlCount(e.width, e.height));
                push = new Float32Array(pearls.length * 2);
            }
        },
        draw(ctx, t, dt, local, now) {
            if (!env) return false;
            const { width, height, ratio } = env;
            const ease = 1 - Math.exp(-dt / 0.25);
            for (const layer of [0, 1, 2] as const) {
                const l = PEARL_LAYERS[layer];
                ctx.globalAlpha = l.alpha;
                pearls.forEach((p, i) => {
                    if (p.layer !== layer) return;
                    const at = pearlAt(p, t, width, height);
                    const [gx, gy] = pushFrom(local, at.x + at.size / 2, at.y + at.size / 2, 130, 46 * (0.5 + layer * 0.35));
                    push[i * 2] += (gx - push[i * 2]) * ease;
                    push[i * 2 + 1] += (gy - push[i * 2 + 1]) * ease;
                    ctx.drawImage(images[layer], Math.round(snapTo(at.x + push[i * 2], l.unit) * ratio), Math.round(snapTo(at.y + push[i * 2 + 1], l.unit) * ratio));
                });
            }
            for (let i = bursts.length - 1; i >= 0; i--) {
                const b = bursts[i];
                const age = (now - b.born) / 1000;
                if (age > 2.4) {
                    bursts.splice(i, 1);
                    continue;
                }
                b.vy -= 60 * dt;
                b.vx *= 1 - dt * 1.5;
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                const l = PEARL_LAYERS[b.layer];
                ctx.globalAlpha = Math.max(0, Math.min(1, 1.4 - age / 1.7)) * l.alpha;
                ctx.drawImage(images[b.layer], Math.round(snapTo(b.x, l.unit) * ratio), Math.round(snapTo(b.y, l.unit) * ratio));
            }
            return bursts.length > 0;
        },
        plop(x, y, now) {
            for (let k = 0; k < 9; k++) {
                const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
                const speed = 90 + Math.random() * 120;
                bursts.push({ x: x - 16, y: y - 16, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, born: now, layer: Math.random() < 0.5 ? 1 : 2 });
            }
            if (bursts.length > 60) bursts.splice(0, bursts.length - 60);
        },
    };
}

/* ── 紙飛機 / Paper planes ───────────────────────────────────── */

function mailPainter(): Painter {
    let env: SceneEnv | null = null;
    let planes = makePlanes(0);
    let push = new Float32Array(0);
    let images: HTMLCanvasElement[] = [];
    let ink = "#4a2026";
    let counted = "";
    const launched: Burst[] = [];
    return {
        setup(e) {
            env = e;
            const palette = PLANE_PALETTE[e.dark ? "dark" : "light"];
            ink = e.dark ? "#f6efe3" : "#4a2026";
            images = PLANE_LAYERS.map((l) => sprite(e.doc, PLANE_SPRITE, l.unit, e.ratio, palette));
            const size = `${e.width}x${e.height}`;
            if (size !== counted) {
                counted = size;
                planes = makePlanes(planeCount(e.width, e.height));
                push = new Float32Array(planes.length * 2);
            }
        },
        draw(ctx, t, dt, local, now) {
            if (!env) return false;
            const { width, height, ratio } = env;
            const ease = 1 - Math.exp(-dt / 0.3);
            ctx.fillStyle = ink;
            for (const layer of [0, 1, 2] as const) {
                const l = PLANE_LAYERS[layer];
                planes.forEach((p, i) => {
                    if (p.layer !== layer) return;
                    const at = planeAt(p, t, width, height);
                    const [gx, gy] = pushFrom(local, at.x + at.size / 2, at.y + at.size / 3, 140, 40 * (0.5 + layer * 0.35));
                    push[i * 2] += (gx - push[i * 2]) * ease;
                    push[i * 2 + 1] += (gy - push[i * 2 + 1]) * ease;
                    const ox = push[i * 2];
                    const oy = push[i * 2 + 1];
                    // 後面的虛線：越遠越淡。/ The dashed trail, fainter further back.
                    at.trail.forEach((d, k) => {
                        ctx.globalAlpha = l.alpha * 0.5 * (1 - k / at.trail.length);
                        ctx.fillRect(Math.round(snapTo(d.x + ox, l.unit) * ratio), Math.round(snapTo(d.y + oy, l.unit) * ratio), Math.round(l.unit * 2 * ratio), Math.round(l.unit * ratio));
                    });
                    ctx.globalAlpha = l.alpha;
                    ctx.drawImage(images[layer], Math.round(snapTo(at.x + ox, l.unit) * ratio), Math.round(snapTo(at.y + oy, l.unit) * ratio));
                });
            }
            // 點出來的那幾架：從那裡斜斜往右上飛走。/ The launched ones fly off up and to the right.
            for (let i = launched.length - 1; i >= 0; i--) {
                const b = launched[i];
                const age = (now - b.born) / 1000;
                if (age > 3) {
                    launched.splice(i, 1);
                    continue;
                }
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                b.vy += 18 * dt;
                const l = PLANE_LAYERS[b.layer];
                ctx.globalAlpha = Math.max(0, Math.min(1, 1.6 - age / 1.9)) * l.alpha;
                ctx.drawImage(images[b.layer], Math.round(snapTo(b.x, l.unit) * ratio), Math.round(snapTo(b.y, l.unit) * ratio));
            }
            return launched.length > 0;
        },
        plop(x, y, now) {
            for (let k = 0; k < 3; k++) {
                launched.push({ x: x - 20, y: y - 14 + k * 10, vx: 160 + k * 60, vy: -70 - k * 30, born: now + k * 90, layer: k === 0 ? 2 : 1 });
            }
            if (launched.length > 24) launched.splice(0, launched.length - 24);
        },
    };
}

/* ── 終端機 / Terminal ───────────────────────────────────────── */

const TERM_SIZES = [12, 16, 22];
const TERM_ALPHA = [0.22, 0.4, 0.7];
const TERM_COLORS = ["#8de6cf", "#f28a38", "#f2e6da"];

function terminalPainter(): Painter {
    let env: SceneEnv | null = null;
    let bits = makePearls(0, 23);
    let push = new Float32Array(0);
    let counted = "";
    const bursts: Burst[] = [];
    const font = (size: number) => `${size}px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
    return {
        setup(e) {
            env = e;
            const size = `${e.width}x${e.height}`;
            if (size !== counted) {
                counted = size;
                bits = makePearls(Math.round(pearlCount(e.width, e.height) * 1.6), 23);
                push = new Float32Array(bits.length * 2);
            }
        },
        draw(ctx, t, dt, local, now) {
            if (!env) return false;
            const { width, height, ratio } = env;
            const ease = 1 - Math.exp(-dt / 0.25);
            ctx.textBaseline = "top";
            bits.forEach((p, i) => {
                // 位置沿用粉圓的「往上浮」；大小與顏色照層。/ Rises like the pearls; size and colour by layer.
                const at = pearlAt(p, t, width, height);
                const size = TERM_SIZES[p.layer];
                const [gx, gy] = pushFrom(local, at.x + size / 2, at.y + size / 2, 120, 36 * (0.5 + p.layer * 0.35));
                push[i * 2] += (gx - push[i * 2]) * ease;
                push[i * 2 + 1] += (gy - push[i * 2 + 1]) * ease;
                ctx.font = font(size * ratio);
                ctx.globalAlpha = TERM_ALPHA[p.layer];
                ctx.fillStyle = TERM_COLORS[i % 3 === 0 ? 1 : p.layer === 2 ? 2 : 0];
                ctx.fillText(glyphAt(i, t), Math.round(snapTo(at.x + push[i * 2], 2) * ratio), Math.round(snapTo(at.y + push[i * 2 + 1], 2) * ratio));
            });
            for (let i = bursts.length - 1; i >= 0; i--) {
                const b = bursts[i];
                const age = (now - b.born) / 1000;
                if (age > 2) {
                    bursts.splice(i, 1);
                    continue;
                }
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                ctx.font = font(18 * ratio);
                ctx.globalAlpha = Math.max(0, 1 - age / 2);
                ctx.fillStyle = TERM_COLORS[1];
                ctx.fillText(b.text ?? "$", Math.round(b.x * ratio), Math.round(b.y * ratio));
            }
            return bursts.length > 0;
        },
        plop(x, y, now) {
            "ok!".split("").forEach((ch, k) => {
                const a = -Math.PI / 2 + (k - 1) * 0.5;
                bursts.push({ x, y, vx: Math.cos(a) * 110, vy: Math.sin(a) * 110, born: now, layer: 2, text: ch });
            });
            for (let k = 0; k < 4; k++) {
                const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
                bursts.push({ x, y, vx: Math.cos(a) * 140, vy: Math.sin(a) * 140, born: now, layer: 1, text: GLYPHS[Math.floor(Math.random() * GLYPHS.length)] });
            }
            if (bursts.length > 40) bursts.splice(0, bursts.length - 40);
        },
    };
}

/* ── 審核櫃台 / The counter ──────────────────────────────────── */

const GRID = 24;

function deskPainter(): Painter {
    let env: SceneEnv | null = null;
    let ok: HTMLCanvasElement | null = null;
    let check: HTMLCanvasElement | null = null;
    let line = "#4a2026";
    const pressed: { x: number; y: number; born: number; tilt: number }[] = [];
    return {
        setup(e) {
            env = e;
            ok = sprite(e.doc, STAMP_OK, 6, e.ratio, { B: "#e8433a" });
            check = sprite(e.doc, STAMP_CHECK, 8, e.ratio, { B: "#1f9d7a" });
            line = e.dark ? "#f2e6da" : "#4a2026";
        },
        draw(ctx, t, _dt, _local, now) {
            if (!env || !ok || !check) return false;
            const { width, height, ratio } = env;
            // 格子紙。/ Grid paper.
            ctx.globalAlpha = env.dark ? 0.05 : 0.06;
            ctx.fillStyle = line;
            for (let x = GRID; x < width; x += GRID) ctx.fillRect(Math.round(x * ratio), 0, Math.max(1, Math.round(ratio)), Math.round(height * ratio));
            for (let y = GRID; y < height; y += GRID) ctx.fillRect(0, Math.round(y * ratio), Math.round(width * ratio), Math.max(1, Math.round(ratio)));
            const stampOne = (img: HTMLCanvasElement, cx: number, cy: number, scale: number, tilt: number, alpha: number) => {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.translate(Math.round(cx * ratio), Math.round(cy * ratio));
                ctx.rotate(tilt);
                ctx.scale(scale, scale);
                ctx.drawImage(img, -img.width / 2, -img.height / 2);
                ctx.restore();
            };
            // 印子落在卡片 / Tapi 後面就換個地方（同一輪結果固定）。/ A mark behind the card / Tapi moves elsewhere (stable per round).
            const hidden = (x: number, y: number) => env!.avoid.some((r) => x > r.left - 40 && x < r.right + 40 && y > r.top - 40 && y < r.bottom + 40);
            for (let s = 0; s < STAMP_SLOTS; s++) {
                let m = stampAt(s, t);
                for (let k = 1; m && hidden(m.x * width, m.y * height) && k < 8; k++) m = stampAt(s, t, 3 + k * 101);
                if (!m || hidden(m.x * width, m.y * height)) continue;
                stampOne(m.kind === "ok" ? ok : check, m.x * width, m.y * height, m.scale, m.tilt, m.alpha * (env.dark ? 0.34 : 0.3));
            }
            // 點背景蓋的章：先重重地蓋下去，留一下再淡掉。/ Stamps from clicks: landing hard, staying, then fading.
            for (let i = pressed.length - 1; i >= 0; i--) {
                const p = pressed[i];
                const age = (now - p.born) / 1000;
                if (age > 3.5) {
                    pressed.splice(i, 1);
                    continue;
                }
                const settle = Math.min(1, age / 0.15);
                stampOne(ok, p.x, p.y, 1.6 - 0.6 * settle, p.tilt, (age > 2.5 ? Math.max(0, 3.5 - age) : settle) * 0.55);
            }
            return pressed.length > 0;
        },
        plop(x, y, now) {
            pressed.push({ x, y, born: now, tilt: (Math.random() - 0.5) * 0.6 });
            if (pressed.length > 12) pressed.splice(0, pressed.length - 12);
        },
    };
}

export function painterFor(scene: TapiScene): Painter {
    return scene === "mail" ? mailPainter() : scene === "terminal" ? terminalPainter() : scene === "desk" ? deskPainter() : teaPainter();
}
