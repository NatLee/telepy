/**
 * 多螢幕桌面的「只看一個螢幕」（純函式，無 React）。VNC 伺服器把所有螢幕拼成一張畫面送來，guacd 沒有選螢幕的
 * 參數，所以這裡算出每個螢幕在那張畫面裡的矩形，由 viewer 裁切顯示。
 * 來源：後端 `GET …/desktop/screens` 問裝置得到的螢幕（Linux / Windows 有位置；macOS 只有大小 → 用整張畫面
 * 的大小推側排或疊排，高度不同時再用畫面裡的黑色區域判斷上下對齊）；問不到時依整張畫面的長寬比給「左半 /
 * 右半」這類預設切法。
 * One-screen-only view of a multi-monitor desktop: every screen becomes a rectangle inside the combined
 * framebuffer; the viewer crops to it. Positions come from the device when its OS reports them, are inferred
 * from the framebuffer size on macOS, and fall back to aspect-ratio presets.
 */

export interface DetectedScreen {
    name: string;
    x: number | null;
    y: number | null;
    width: number;
    height: number;
    primary: boolean;
}

export interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Framebuffer {
    width: number;
    height: number;
}

export interface ScreenChoice {
    id: string;
    /** 顯示名稱（偵測到的名稱，或預設切法的 key）。/ Name, or a preset key for the dictionary. */
    name: string;
    /** 預設切法時的翻譯 key。/ Set for presets. */
    preset?: "left" | "right" | "top" | "bottom" | "third1" | "third2" | "third3";
    viewport: Viewport;
    primary?: boolean;
    /** 只靠整張畫面的形狀推出來的（裝置沒回報螢幕）。/ Inferred from the framebuffer shape alone. */
    guessed?: boolean;
}

/** 像素大小相差 2%（至少 2px）以內算一樣（取整、工作列）。/ Pixel sizes within 2% (at least 2px) are equal. */
function close(a: number, b: number): boolean {
    return Math.abs(a - b) <= Math.max(2, 0.02 * Math.max(a, b));
}

/** 兩個縮放比例相差 3% 以內算一樣。/ Two scale factors within 3% are the same. */
function closeScale(a: number, b: number): boolean {
    return Math.abs(a - b) <= 0.03 * Math.max(a, b);
}

/** 某一列是不是「空的」（畫面裡沒有螢幕的區域是黑的）。/ Is this pixel outside every screen (black)? */
export type BlackProbe = (x: number, y: number) => boolean;

function toViewport(x: number, y: number, width: number, height: number, fb: Framebuffer): Viewport | null {
    const vx = Math.max(0, Math.round(x));
    const vy = Math.max(0, Math.round(y));
    const vw = Math.min(Math.round(width), fb.width - vx);
    const vh = Math.min(Math.round(height), fb.height - vy);
    if (vw < 64 || vh < 64) return null;
    return { x: vx, y: vy, width: vw, height: vh };
}

/**
 * 有位置的螢幕：平移到 (0,0)，整體和畫面大小不符但長寬比一樣時等比縮放（Windows 的 DPI 縮放）。
 * 放不進畫面就回 null。/ Positioned screens: normalise, scale uniformly if needed, null when they don't fit.
 */
export function placePositioned(screens: DetectedScreen[], fb: Framebuffer): Viewport[] | null {
    if (screens.length === 0 || screens.some((s) => s.x === null || s.y === null)) return null;
    const minX = Math.min(...screens.map((s) => s.x as number));
    const minY = Math.min(...screens.map((s) => s.y as number));
    const maxX = Math.max(...screens.map((s) => (s.x as number) + s.width));
    const maxY = Math.max(...screens.map((s) => (s.y as number) + s.height));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return null;
    let scale = 1;
    if (!close(w, fb.width) || !close(h, fb.height)) {
        const sx = fb.width / w;
        const sy = fb.height / h;
        if (!closeScale(sx, sy)) return null;
        scale = sx;
    }
    const out: Viewport[] = [];
    for (const s of screens) {
        const v = toViewport(((s.x as number) - minX) * scale, ((s.y as number) - minY) * scale, s.width * scale, s.height * scale, fb);
        if (!v) return null;
        out.push(v);
    }
    return out;
}

/**
 * 只有大小的螢幕（macOS）：依整張畫面推排列 —— 寬相加等於畫面寬 = 側排（高度不同時用黑色區域判斷每個螢幕
 * 貼上緣還是下緣）；高相加等於畫面高 = 疊排。推不出來回 null。
 * Size-only screens: side by side when the widths add up, stacked when the heights do; the black area tells
 * whether a shorter screen sits at the top or the bottom. null when neither fits.
 */
export function arrangeBySize(screens: DetectedScreen[], fb: Framebuffer, probe?: BlackProbe): Viewport[] | null {
    if (screens.length === 0) return null;
    const sumW = screens.reduce((a, s) => a + s.width, 0);
    const sumH = screens.reduce((a, s) => a + s.height, 0);
    const maxW = Math.max(...screens.map((s) => s.width));
    const maxH = Math.max(...screens.map((s) => s.height));
    const tryScale = (lw: number, lh: number): number | null => {
        if (close(lw, fb.width) && close(lh, fb.height)) return 1;
        const sx = fb.width / lw;
        const sy = fb.height / lh;
        return closeScale(sx, sy) ? sx : null;
    };
    const side = tryScale(sumW, maxH);
    if (side !== null) {
        let x = 0;
        const out: Viewport[] = [];
        for (const s of screens) {
            const w = s.width * side;
            const h = s.height * side;
            const y = h < fb.height - 2 ? alignVertically(x, w, h, fb, probe) : 0;
            const v = toViewport(x, y, w, h, fb);
            if (!v) return null;
            out.push(v);
            x += w;
        }
        return out;
    }
    const stacked = screens.length > 1 ? tryScale(maxW, sumH) : null;
    if (stacked !== null) {
        let y = 0;
        const out: Viewport[] = [];
        for (const s of screens) {
            const w = s.width * stacked;
            const h = s.height * stacked;
            const x = w < fb.width - 2 ? alignHorizontally(y, h, w, fb, probe) : 0;
            const v = toViewport(x, y, w, h, fb);
            if (!v) return null;
            out.push(v);
            y += h;
        }
        return out;
    }
    return null;
}

/** 比較螢幕那一條裡上緣與下緣的黑色比例：上面黑得多 → 貼下緣。/ More black above than below: bottom-aligned. */
function alignVertically(x: number, w: number, h: number, fb: Framebuffer, probe?: BlackProbe): number {
    if (!probe) return 0;
    const gap = fb.height - h;
    if (gap <= 2) return 0;
    const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(x + w * f));
    const top = xs.filter((px) => probe(px, Math.round(gap * 0.5))).length;
    const bottom = xs.filter((px) => probe(px, Math.round(h + gap * 0.5))).length;
    return top > bottom ? gap : 0;
}

function alignHorizontally(y: number, h: number, w: number, fb: Framebuffer, probe?: BlackProbe): number {
    if (!probe) return 0;
    const gap = fb.width - w;
    if (gap <= 2) return 0;
    const ys = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(y + h * f));
    const left = ys.filter((py) => probe(Math.round(gap * 0.5), py)).length;
    const right = ys.filter((py) => probe(Math.round(w + gap * 0.5), py)).length;
    return left > right ? gap : 0;
}

/** 最小的可用區域（像素）。/ The smallest usable area. */
export const MIN_AREA = 64;

/**
 * 等分切法，不靠偵測、隨時可選：左 / 右半、三等分（夠寬時）、上 / 下半（夠高時）。
 * 螢幕一樣大並排的多螢幕桌面用這個就夠了。/ Even splits, always available: halves, thirds, top / bottom.
 */
export function splitChoices(fb: Framebuffer): ScreenChoice[] {
    if (fb.width < MIN_AREA * 2 || fb.height < MIN_AREA) return [];
    const out: ScreenChoice[] = [];
    const half = Math.floor(fb.width / 2);
    out.push({ id: "left", name: "left", preset: "left", viewport: { x: 0, y: 0, width: half, height: fb.height } });
    out.push({ id: "right", name: "right", preset: "right", viewport: { x: half, y: 0, width: fb.width - half, height: fb.height } });
    if (fb.width >= MIN_AREA * 3) {
        const third = Math.floor(fb.width / 3);
        out.push({ id: "third1", name: "third1", preset: "third1", viewport: { x: 0, y: 0, width: third, height: fb.height } });
        out.push({ id: "third2", name: "third2", preset: "third2", viewport: { x: third, y: 0, width: third, height: fb.height } });
        out.push({ id: "third3", name: "third3", preset: "third3", viewport: { x: 2 * third, y: 0, width: fb.width - 2 * third, height: fb.height } });
    }
    if (fb.height >= MIN_AREA * 2) {
        const h = Math.floor(fb.height / 2);
        out.push({ id: "top", name: "top", preset: "top", viewport: { x: 0, y: 0, width: fb.width, height: h } });
        out.push({ id: "bottom", name: "bottom", preset: "bottom", viewport: { x: 0, y: h, width: fb.width, height: fb.height - h } });
    }
    return out;
}

/**
 * 偵測到的螢幕（放得進畫面的）→ 每個一項；蓋住整張畫面的那個就是「整個桌面」，不另外列（Xvfb 這類 X server
 * 會多列一個涵蓋全部的 monitor）。推不出排列、或沒偵測到 → 空（選單還有等分切法與自訂區域）。
 * Detected screens that fit, one choice each; a screen covering the whole framebuffer is the "whole desktop"
 * entry (Xvfb lists one next to the real ones). Empty when nothing was detected or nothing fits.
 */
export function screenChoices(detected: DetectedScreen[], fb: Framebuffer, probe?: BlackProbe): ScreenChoice[] {
    if (fb.width <= 0 || fb.height <= 0) return [];
    const placed = placePositioned(detected, fb) ?? arrangeBySize(detected, fb, probe);
    const isWhole = (v: Viewport) => v.x === 0 && v.y === 0 && close(v.width, fb.width) && close(v.height, fb.height);
    const real = placed ? placed.map((viewport, i) => ({ id: `s${i}`, name: detected[i].name, viewport, primary: detected[i].primary })).filter((c) => !isWhole(c.viewport)) : [];
    if (real.length > 0) return real;
    // 裝置沒回報、推不出排列、或只回報了一顆蓋住整張的（區網主機、偵測失敗、Xvfb）→ 靠形狀猜。
    // Nothing usable reported (LAN host, failed detection, one whole-picture monitor): guess from the shape.
    return guessScreens(fb, probe).map((g, i) => ({ id: `g${i}`, name: g.name, viewport: { x: g.x as number, y: g.y as number, width: g.width, height: g.height }, guessed: true }));
}

/**
 * 常見的螢幕比例。超寬（21:9）實際有 2.33 / 2.37 / 2.39 / 2.40 幾種，用一個值配上寬一點的容忍度；
 * MacBook 的 1728×1117、1512×982、2560×1664 都約 1.54。/ Common monitor aspect ratios.
 */
export const SCREEN_RATIOS: { name: string; value: number }[] = [
    { name: "16:9", value: 16 / 9 },
    { name: "16:10", value: 1.6 },
    { name: "MacBook", value: 1.545 },
    { name: "3:2", value: 1.5 },
    { name: "4:3", value: 4 / 3 },
    { name: "5:4", value: 1.25 },
    { name: "21:9", value: 2.37 },
];

/** 單顆比例比對的容忍度（相對）。/ Relative tolerance when naming one screen's ratio. */
const RATIO_TOLERANCE = 0.015;
/** 幾顆加起來要多準。/ How closely the screens must add up to the picture. */
const SUM_TOLERANCE = 0.005;
/** 同一列最多猜幾顆。/ Most screens guessed in a row. */
const MAX_GUESSED = 4;

function ratioName(width: number, height: number): string | null {
    const r = width / height;
    const hit = SCREEN_RATIOS.find((c) => Math.abs(r - c.value) <= c.value * (c.name === "21:9" ? 0.03 : RATIO_TOLERANCE));
    return hit ? hit.name : null;
}

/** 所有 k 個比例的組合（可重複、不分順序）。/ Multisets of k ratios. */
function combos(k: number): number[][] {
    const out: number[][] = [];
    const walk = (start: number, acc: number[]) => {
        if (acc.length === k) {
            out.push([...acc]);
            return;
        }
        for (let i = start; i < SCREEN_RATIOS.length; i += 1) {
            acc.push(i);
            walk(i, acc);
            acc.pop();
        }
    };
    walk(0, []);
    return out;
}

/**
 * 在 [lo, hi) 之間找「非黑」的範圍：沿著 `along` 軸每 8px 採樣，兩端再逐像素收斂。
 * 回 null = 全黑或讀不到。/ The non-black extent along one axis, sampled every 8px then refined.
 */
function nonBlackExtent(isBlack: (p: number) => boolean, lo: number, hi: number): { from: number; to: number } | null {
    const step = 8;
    let from = -1;
    for (let p = lo; p < hi; p += step) {
        if (!isBlack(p)) { from = p; break; }
    }
    if (from < 0) return null;
    while (from > lo && !isBlack(from - 1)) from -= 1;
    let to = -1;
    for (let p = hi - 1; p >= from; p -= step) {
        if (!isBlack(p)) { to = p; break; }
    }
    if (to < 0) to = from;
    while (to < hi - 1 && !isBlack(to + 1)) to += 1;
    return { from, to: to + 1 };
}

/** 量黑色區域時取幾欄（列）。/ Columns (rows) sampled when measuring the black area. */
const PROBE_LINES = 9;

/**
 * 沿著一段的寬（高）取幾條線，每條找非黑範圍；全部一致（相差 ≤ 8px）才算真的有一條黑邊，否則 null
 * （黑色桌布、或這一段其實跨了兩顆螢幕時，各條線量到的會不一樣）。
 * Sample several lines across a segment; only a band consistent across all of them counts.
 */
function consistentExtent(lines: number[], extentAt: (line: number) => { from: number; to: number } | null): { from: number; to: number } | null {
    let first: { from: number; to: number } | null = null;
    for (const line of lines) {
        const ext = extentAt(line);
        if (!ext) return null;
        if (!first) first = ext;
        else if (Math.abs(ext.from - first.from) > 8 || Math.abs(ext.to - first.to) > 8) return null;
    }
    return first;
}

function sampleLines(start: number, length: number): number[] {
    return Array.from({ length: PROBE_LINES }, (_, i) => Math.round(start + ((i + 0.5) / PROBE_LINES) * length));
}

/**
 * 並排猜出來的一顆若比整張畫面矮（筆電＋外接螢幕），用黑色區域量出它真正的高度與位置；量到的高度要和寬度
 * 湊成常見比例才採用（黑色桌布會騙人）。/ A side-by-side screen shorter than the picture, measured from the black area.
 */
function refineHeight(seg: { x: number; width: number }, fb: Framebuffer, probe: BlackProbe): { y: number; height: number } | null {
    const ext = consistentExtent(sampleLines(seg.x, seg.width), (x) => nonBlackExtent((y) => probe(x, y), 0, fb.height));
    if (!ext) return null;
    const height = ext.to - ext.from;
    if (fb.height - height < 32 || height < MIN_AREA) return null;
    return ratioName(seg.width, height) ? { y: ext.from, height } : null;
}

function refineWidth(seg: { y: number; height: number }, fb: Framebuffer, probe: BlackProbe): { x: number; width: number } | null {
    const ext = consistentExtent(sampleLines(seg.y, seg.height), (y) => nonBlackExtent((x) => probe(x, y), 0, fb.width));
    if (!ext) return null;
    const width = ext.to - ext.from;
    if (fb.width - width < 32 || width < MIN_AREA) return null;
    return ratioName(width, seg.height) ? { x: ext.from, width } : null;
}

/**
 * 只靠整張畫面的寬高猜螢幕：把寬度拆成 2–4 顆等高螢幕（每顆都是常見比例），或把高度拆成疊放的；
 * 最準（像素誤差最小）優先，其次同比例、再其次少顆。單一常見比例的畫面（含 21:9 超寬）就是一顆，不猜；
 * 3840×1080 這種 32:9 當成兩顆 16:9（裁切用途下這樣比較有用）。有 probe 時再用黑色區域修正比整張畫面矮
 * （或窄）的那顆。
 * Guess screens from the framebuffer size alone: 2–4 equal-height screens of common ratios side by side, or
 * stacked; the closest fit wins, then equal ratios, then fewer screens. A single common-ratio picture is one
 * screen (32:9 counts as two 16:9). With a probe, a screen shorter (or narrower) than the picture is measured
 * from the black area.
 */
export function guessScreens(fb: Framebuffer, probe?: BlackProbe): DetectedScreen[] {
    if (fb.width < MIN_AREA * 2 || fb.height < MIN_AREA) return [];
    if (ratioName(fb.width, fb.height)) return [];
    // 只容忍 0.5%（至少 4px）：真實螢幕的比例都很準，鬆了會把怪形狀湊成兩顆，也會把「一顆等高、一顆較矮」
    // 誤判成兩顆等高的。/ Only 0.5% (at least 4px): real screens are exact; a loose fit invents screens.
    const tol = (n: number) => Math.max(4, SUM_TOLERANCE * n);
    type Hit = { k: number; same: boolean; residual: number; sizes: number[]; names: string[] };
    const better = (a: Hit, b: Hit | null) => !b || a.residual < b.residual - 0.5 || (Math.abs(a.residual - b.residual) <= 0.5 && ((a.same && !b.same) || (a.same === b.same && a.k < b.k)));
    // `size(i)` = 第 i 種比例的那顆在這個方向的長度。/ `size(i)` = the extent of ratio i along the axis being split.
    const solve = (total: number, size: (i: number) => number, maxK: number): Hit | null => {
        let best: Hit | null = null;
        for (let k = 2; k <= maxK; k += 1) {
            for (const combo of combos(k)) {
                const same = combo.every((i) => i === combo[0]);
                const sum = combo.reduce((a, i) => a + size(i), 0);
                const residual = Math.abs(sum - total);
                if (residual > tol(total)) continue;
                const hit: Hit = { k, same, residual, sizes: combo.map((i) => Math.round(size(i))), names: combo.map((i) => SCREEN_RATIOS[i].name) };
                if (better(hit, best)) best = hit;
            }
        }
        return best;
    };
    // 比例不同的幾顆誰左誰右（誰上誰下）看不出來：每種排列都排一次，用黑色區域修正後，比例越常見的排列越可信；
    // 平手取寬的在前。/ Mixed ratios: try every order, refine with the probe, prefer the commonest final ratios.
    const rank = (w: number, h: number) => {
        const n = ratioName(w, h);
        const i = n ? SCREEN_RATIOS.findIndex((r) => r.name === n) : -1;
        return i < 0 ? SCREEN_RATIOS.length + 2 : i;
    };
    const assemble = (hit: Hit, axis: "row" | "col"): DetectedScreen[] => {
        const order = hit.sizes.map((s, i) => ({ s, n: hit.names[i] })).sort((a, b) => b.s - a.s);
        let best: { screens: DetectedScreen[]; score: number } | null = null;
        for (const perm of permutations(order, (o) => `${o.s}`)) {
            const screens: DetectedScreen[] = [];
            let pos = 0;
            perm.forEach((p, i) => {
                const total = axis === "row" ? fb.width : fb.height;
                const len = i === perm.length - 1 ? total - pos : p.s;
                let x = axis === "row" ? pos : 0;
                let y = axis === "row" ? 0 : pos;
                let width = axis === "row" ? len : fb.width;
                let height = axis === "row" ? fb.height : len;
                if (probe) {
                    if (axis === "row") {
                        const fixed = refineHeight({ x, width }, fb, probe);
                        if (fixed) { y = fixed.y; height = fixed.height; }
                    } else {
                        const fixed = refineWidth({ y, height }, fb, probe);
                        if (fixed) { x = fixed.x; width = fixed.width; }
                    }
                }
                screens.push({ name: `${ratioName(width, height) ?? p.n} · ${width}×${height}`, x, y, width, height, primary: i === 0 });
                pos += len;
            });
            const score = screens.reduce((a, s) => a + rank(s.width, s.height), 0);
            if (!best || score < best.score) best = { screens, score };
        }
        return best ? best.screens : [];
    };
    // 並排：寬度 = Σ 比例 × 高度；疊放：高度 = Σ 寬度 ÷ 比例。/ Side by side, then stacked.
    const row = solve(fb.width, (i) => SCREEN_RATIOS[i].value * fb.height, MAX_GUESSED);
    if (row) return assemble(row, "row");
    const col = solve(fb.height, (i) => fb.width / SCREEN_RATIOS[i].value, 3);
    if (col) return assemble(col, "col");
    // 一顆和畫面等高、另一顆比較矮（筆電 + 外接螢幕，筆電的寬 ÷ 畫面高不是任何比例）：等高的那顆先定，
    // 剩下那段用黑色區域量真正的高度，量出來是常見比例才算。/ One full-height screen plus a shorter one, measured.
    if (probe) {
        let best: { screens: DetectedScreen[]; score: number } | null = null;
        for (const [ri, r] of SCREEN_RATIOS.entries()) {
            const w = Math.round(r.value * fb.height);
            const rest = fb.width - w;
            if (w < MIN_AREA || rest < MIN_AREA) continue;
            for (const fullLeft of [true, false]) {
                const full = { x: fullLeft ? 0 : rest, width: w };
                const other = { x: fullLeft ? w : 0, width: rest };
                const fixed = refineHeight(other, fb, probe);
                if (!fixed) continue;
                const a: DetectedScreen = { name: `${r.name} · ${w}×${fb.height}`, x: full.x, y: 0, width: w, height: fb.height, primary: fullLeft };
                const b: DetectedScreen = { name: `${ratioName(rest, fixed.height)} · ${rest}×${fixed.height}`, x: other.x, y: fixed.y, width: rest, height: fixed.height, primary: !fullLeft };
                const screens = fullLeft ? [a, b] : [b, a];
                const score = ri + rank(rest, fixed.height);
                if (!best || score < best.score) best = { screens, score };
            }
        }
        if (best) return best.screens;
    }
    return [];
}

/** 不重複的排列（同樣大小的顆視為相同）。/ Distinct permutations (equal-size items count as the same). */
function permutations<T>(items: T[], key: (t: T) => string): T[][] {
    const out: T[][] = [];
    const seen = new Set<string>();
    const walk = (rest: T[], acc: T[]) => {
        if (rest.length === 0) {
            const k = acc.map(key).join("|");
            if (!seen.has(k)) {
                seen.add(k);
                out.push([...acc]);
            }
            return;
        }
        for (let i = 0; i < rest.length; i += 1) {
            walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
        }
    };
    walk(items, []);
    return out;
}

/**
 * 使用者在整張畫面上拖出的矩形（畫面座標的兩個角）→ 區域：取整、夾進畫面、太小就 null。
 * A rectangle the user dragged over the whole desktop (two corners in framebuffer coordinates).
 */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, fb: Framebuffer): Viewport | null {
    const clampX = (v: number) => Math.min(fb.width, Math.max(0, Math.round(v)));
    const clampY = (v: number) => Math.min(fb.height, Math.max(0, Math.round(v)));
    const x1 = clampX(Math.min(a.x, b.x));
    const x2 = clampX(Math.max(a.x, b.x));
    const y1 = clampY(Math.min(a.y, b.y));
    const y2 = clampY(Math.max(a.y, b.y));
    if (x2 - x1 < MIN_AREA || y2 - y1 < MIN_AREA) return null;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** localStorage 裡存的自訂區域 → 區域；壞資料或超出畫面 → null。/ A stored custom area; null when invalid or outside. */
export function parseStoredArea(json: string | null, fb: Framebuffer): Viewport | null {
    if (!json) return null;
    let v: unknown;
    try {
        v = JSON.parse(json);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.round(o[k] as number) : null);
    const x = n("x");
    const y = n("y");
    const width = n("width");
    const height = n("height");
    if (x === null || y === null || width === null || height === null) return null;
    if (x < 0 || y < 0 || width < MIN_AREA || height < MIN_AREA || x + width > fb.width || y + height > fb.height) return null;
    return { x, y, width, height };
}

/** 縮放比例：整個 viewport 放進框，不放大超過 maxScale。/ Fit the viewport into the box, never above maxScale. */
export function fitScale(box: { width: number; height: number }, viewport: Viewport, maxScale = 1): number {
    if (viewport.width <= 0 || viewport.height <= 0 || box.width <= 0 || box.height <= 0) return maxScale;
    return Math.min(box.width / viewport.width, box.height / viewport.height, maxScale);
}
