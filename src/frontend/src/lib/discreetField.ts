/**
 * 低調登入頁背景（components/auth/DiscreetShell.tsx 的 canvas）的純數學：向日葵點陣上由中心往外的漣漪（每點一閃）、
 * 波前、兩條軌道、從「Telepy」送出的那圈波、滑鼠把點推開並點亮、以及平滑跟上的緩動。
 * 以前每個點各有一個 CSS 動畫（420 個合成圖層，設定頁的兩個預覽框再加倍），滑鼠一動又逐點改樣式，畫面因此不順；
 * 現在整個背景是一張 canvas、一個 requestAnimationFrame 迴圈，時間曲線照搬原本的 keyframes。
 * Pure maths for the discreet sign-in background (the canvas in components/auth/DiscreetShell.tsx): the ripple across
 * the sunflower field (one flash per dot), the wavefront, two orbits, the ring sent from the word, dots pushed and lit
 * by the pointer, and the easing that follows it. Every dot used to run its own CSS animation (420 composited layers,
 * doubled by the settings page's two preview frames) and the pointer restyled dots one by one, which is what made it
 * stutter; now the whole background is one canvas and one requestAnimationFrame loop, with the old keyframes' curves.
 */
import { sunflower } from "./signinLook.ts";

/** 點陣半徑與點數（px）。/ Field radius (px) and dot count. */
export const FIELD_RADIUS = 380;
export const FIELD_DOTS = 420;
/** 一輪漣漪多長；漣漪走完半徑要多久（秒）。/ One ripple cycle; how long the ripple takes to cross the radius (s). */
export const CYCLE_SECS = 6.5;
export const RIPPLE_SECS = 2.4;
/** 點陣轉一圈（秒）。/ One turn of the field (s). */
export const SPIN_SECS = 320;
/** 滑鼠推開點的範圍與力道（px）。/ How far from the pointer dots are pushed, and how hard (px). */
export const PUSH_RADIUS = 120;
export const PUSH = 26;
/** 碰到「Telepy」送出的那圈波：多久走完、多寬、把點往外推多少。/ The ring sent from the word: duration, band, push. */
export const BURST_SECS = 2.2;
export const BURST_BAND = 34;
export const BURST_PUSH = 9;
/** 視差：點陣、內外兩條軌道跟滑鼠反方向各移多少（px；軌道疊在點陣上）。/ Parallax per layer (px; orbits add to the field). */
export const DEPTH = { field: 10, inner: 7, outer: 15 } as const;
/** 兩條軌道：半徑、轉一圈幾秒（負 = 反轉）、軌道上那點的半徑、顏色。/ The orbits: radius, period (negative = reverse), dot radius, colour. */
export const ORBITS = [
    { r: 232, period: 38, dot: 3.5, color: "primary", depth: DEPTH.inner },
    { r: 318, period: -64, dot: 2.5, color: "foreground", depth: DEPTH.outer },
] as const;
/** 緩動的時間常數（秒）：點被推開 / 放回、視差。/ Easing time constants (s): dots pushed / released, parallax. */
export const PUSH_TAU = 0.11;
export const PARALLAX_TAU = 0.32;
/** canvas 的半邊（px）：點陣 + 推開 + 視差 + 放大的點，都畫得下。/ Half the canvas side: field + push + parallax + a grown dot. */
export const FIELD_HALF = FIELD_RADIUS + PUSH + DEPTH.field + 10;
/** canvas 的像素密度上限（再高看不出差別，只是更花力氣）。/ Backing-store density cap (more is invisible, just costlier). */
export const MAX_RATIO = 2;

/**
 * CSS 的 cubic-bezier(x1, y1, x2, y2)：給時間比例 x（0–1），回傳進度 y。牛頓法，失敗時改二分法。
 * CSS cubic-bezier(x1, y1, x2, y2): time fraction x (0–1) → progress y. Newton's method, bisection as a fallback.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
    const sy = (s: number) => ((ay * s + by) * s + cy) * s;
    const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
    return (x: number) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let s = x;
        for (let i = 0; i < 8; i++) {
            const err = sx(s) - x;
            if (Math.abs(err) < 1e-6) return sy(s);
            const d = dx(s);
            if (Math.abs(d) < 1e-6) break;
            s -= err / d;
        }
        let lo = 0;
        let hi = 1;
        s = x;
        for (let i = 0; i < 40; i++) {
            const v = sx(s);
            if (Math.abs(v - x) < 1e-6) break;
            if (v < x) lo = s;
            else hi = s;
            s = (lo + hi) / 2;
        }
        return sy(s);
    };
}

const pulseEase = cubicBezier(0.22, 0.61, 0.36, 1);
const burstEase = cubicBezier(0.33, 1, 0.68, 1);

export interface FieldDot {
    x: number;
    y: number;
    /** 離中心多遠（0–1）。/ Distance from the centre (0–1). */
    t: number;
    /** 離中心幾 px。/ Distance from the centre in px. */
    r: number;
    /** 平常的不透明度：外圈淡出，中心被字蓋住的也淡一點。/ Resting opacity: fades toward the rim and under the word. */
    o: number;
    /** 漣漪到這點的延遲（秒）。/ When the ripple reaches it (s). */
    delay: number;
}

/** 平常的不透明度。/ A dot's resting opacity. */
export const dotOpacity = (t: number) => (t < 0.12 ? 0.35 : t > 0.6 ? Math.max(0, 1 - (t - 0.6) / 0.4) : 1);

/** 整個點陣（固定的，算一次就好）。/ The whole field (fixed, computed once). */
export function fieldDots(count = FIELD_DOTS, radius = FIELD_RADIUS): FieldDot[] {
    return sunflower(count, radius).map((d) => ({ ...d, r: Math.hypot(d.x, d.y), o: dotOpacity(d.t), delay: d.t * RIPPLE_SECS }));
}

/**
 * 一個點在漣漪經過時的閃光（原本的 dsc-pulse：5% 時亮到最滿、放大兩倍，22% 時熄掉）；延遲之前什麼都沒有。
 * A dot's flash as the ripple passes (the old dsc-pulse: brightest and twice the size at 5 %, gone by 22 %); nothing
 * before its delay.
 */
export function pulse(elapsed: number, delay: number): { alpha: number; scale: number } {
    const local = elapsed - delay;
    if (local < 0) return { alpha: 0, scale: 1 };
    const p = (local % CYCLE_SECS) / CYCLE_SECS;
    if (p < 0.05) {
        const e = pulseEase(p / 0.05);
        return { alpha: e, scale: 0.6 + 1.4 * e };
    }
    if (p < 0.22) {
        const e = pulseEase((p - 0.05) / 0.17);
        return { alpha: 1 - e, scale: 2 - 1.2 * e };
    }
    return { alpha: 0, scale: 0.8 };
}

/** 波前在點閃到最亮的那一刻出發（5% × 一輪）。/ The wavefront leaves when the centre dot peaks (5 % of a cycle). */
export const WAVE_DELAY = 0.05 * CYCLE_SECS;

/**
 * 波前（一條細圓圈）：半徑比例與不透明度；跟點的延遲一樣快（RIPPLE_SECS 走完半徑）。null = 這時看不到。
 * The wavefront: radius fraction and opacity, as fast as the dots' delays (crosses the radius in RIPPLE_SECS). null =
 * not visible now.
 */
export function wave(elapsed: number): { r: number; alpha: number } | null {
    const local = elapsed - WAVE_DELAY;
    if (local < 0) return null;
    const p = (local % CYCLE_SECS) / CYCLE_SECS;
    const span = RIPPLE_SECS / CYCLE_SECS;
    if (p >= span) return null;
    const k = p / span;
    return { r: 0.01 + 0.99 * k, alpha: 0.85 * (1 - k) };
}

/**
 * 碰到字送出的那圈波，出發 `age` 秒後：畫的半徑比例與不透明度，以及推點用的半徑比例和強度。null = 走完了。
 * The ring sent from the word, `age` seconds after it left: the drawn radius fraction and opacity, and the strength it
 * pushes dots with. null = finished.
 */
export function burst(age: number): { r: number; alpha: number; strength: number } | null {
    if (age < 0) return null;
    const p = age / BURST_SECS;
    if (p >= 1) return null;
    const e = burstEase(p);
    return { r: 0.02 + 0.98 * e, alpha: 0.9 * (1 - e), strength: 1 - p };
}

/** 點陣轉了多少（弧度）。/ How far the field has turned (radians). */
export const spinAngle = (elapsed: number) => ((elapsed / SPIN_SECS) % 1) * Math.PI * 2;

/** 軌道上那點的位置（從正上方開始，順時針；period < 0 = 逆時針）。/ An orbit's dot (starts at the top; period < 0 = reverse). */
export function orbitPoint(r: number, period: number, elapsed: number): { x: number; y: number } {
    const a = ((elapsed / period) % 1) * Math.PI * 2;
    return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

/** 螢幕上相對中心的位移 → 點陣自己的座標（點陣轉了 `angle`）。/ A screen offset from the centre → the turned field's frame. */
export function toField(dx: number, dy: number, angle: number): { x: number; y: number } {
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/**
 * 一個點此刻該被推到哪、多亮：滑鼠附近的推開（越近越多）加上經過的波往外推。`pointer` 在點陣座標裡；`rings` = 每圈波的
 * 半徑（px）與強度。
 * Where a dot should be pushed and how lit: away from a nearby pointer (more when closer) plus outward by passing rings.
 * `pointer` is in the field's frame; `rings` = each ring's radius (px) and strength.
 */
export function dotTarget(dot: { x: number; y: number; r: number }, pointer: { x: number; y: number } | null, rings: { r: number; strength: number }[]): { x: number; y: number; heat: number } {
    let x = 0;
    let y = 0;
    let heat = 0;
    if (pointer) {
        const ox = dot.x - pointer.x;
        const oy = dot.y - pointer.y;
        const dist = Math.hypot(ox, oy);
        if (dist < PUSH_RADIUS) {
            const f = 1 - dist / PUSH_RADIUS;
            const k = (PUSH * f * f) / Math.max(dist, 0.001);
            x += ox * k;
            y += oy * k;
            heat = f;
        }
    }
    if (dot.r >= 1) {
        for (const ring of rings) {
            const g = Math.max(0, 1 - Math.abs(dot.r - ring.r) / BURST_BAND) * ring.strength;
            if (g <= 0) continue;
            x += (dot.x / dot.r) * BURST_PUSH * g;
            y += (dot.y / dot.r) * BURST_PUSH * g;
            heat = Math.max(heat, g);
        }
    }
    return { x, y, heat };
}

/**
 * 平滑地往目標靠（指數緩動，跟幀率無關）：`tau` 秒內走完約 63%。目標每一幀都在變也不會一頓一頓（CSS transition
 * 每次重設都會從頭緩動，這就是以前 hover 時卡卡的原因之一）。
 * Ease toward a target, frame-rate independent (about 63 % of the way per `tau` seconds). A target that changes every
 * frame stays fluid, unlike a CSS transition restarted on every pointer move (part of the old hover stutter).
 */
export function approach(current: number, target: number, dt: number, tau: number): number {
    if (dt <= 0) return current;
    return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * canvas 的像素密度：裝置像素比 × 外層 iframe 的縮放（設定頁的預覽框把整頁縮小），夾在 0.25–MAX_RATIO。照實際
 * 螢幕像素畫，縮小的預覽裡點才不會糊、不會閃。
 * The canvas's backing density: device pixel ratio × the scale of enclosing iframes (the settings preview shrinks the
 * whole page), clamped to 0.25–MAX_RATIO. Drawing at real screen pixels keeps the shrunken preview's dots crisp and
 * free of shimmer.
 */
export function backingRatio(dpr: number, frameScales: number[]): number {
    const r = frameScales.reduce((acc, s) => (s > 0 && Number.isFinite(s) ? acc * s : acc), dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
    return Math.min(MAX_RATIO, Math.max(0.25, r));
}

/** 不透明度分成幾階一起畫（少很多次繪圖，肉眼看不出差別）。/ Opacity steps drawn together (far fewer draws, no visible change). */
export const ALPHA_STEPS = 32;
export const alphaStep = (alpha: number) => Math.max(0, Math.min(ALPHA_STEPS, Math.round(alpha * ALPHA_STEPS)));
