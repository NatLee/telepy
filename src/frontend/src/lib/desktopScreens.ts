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
    if (!placed) return [];
    const isWhole = (v: Viewport) => v.x === 0 && v.y === 0 && close(v.width, fb.width) && close(v.height, fb.height);
    return placed.map((viewport, i) => ({ id: `s${i}`, name: detected[i].name, viewport, primary: detected[i].primary })).filter((c) => !isWhole(c.viewport));
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
