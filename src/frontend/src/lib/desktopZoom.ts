/**
 * 遠端桌面的縮放與平移（純函式）。比例是絕對的「遠端像素 → CSS px」，由模式決定：
 * - fit = 塞進框裡（比框小的畫面也放大）；shrink = 只縮不放（太小的畫面維持 1:1）；
 * - actual = 1:1（一個遠端像素 = 一個 CSS px，HiDPI 時一個裝置像素），放不下就平移；
 * - scale = 使用者自己調過的比例（按鈕、捏合、自訂百分比）。
 * 模式會「黏著」：視窗變大變小時 fit 重新塞、actual 維持 1:1；只有 scale 是固定的數字。
 * 內容置中於框內；比框大時框就是裁切框，`ox` / `oy` = 內容左上角往左 / 上捲了多少（CSS px，夾在 0 ~ 內容 − 框）。
 * Zoom and pan for the remote desktop (pure). The scale is absolute (remote px → CSS px) and comes from a mode:
 * fit (fills the frame, small pictures grow), shrink (never above 1:1), actual (1:1, pan to see the rest) or
 * scale (a number the user chose). Modes stick across frame resizes; only `scale` is a fixed number.
 */

export type ZoomMode = "fit" | "shrink" | "actual" | "scale";

export interface ZoomState {
    mode: ZoomMode;
    /** 只有 mode = scale 時用：絕對比例。/ Absolute scale, used when mode = scale. */
    scale: number;
    ox: number;
    oy: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

/**
 * 這張畫面在這個框裡的兩個基準：`fit` = 剛好塞進框的比例（不設上限），`unit` = 1:1 的比例
 * （1，或 HiDPI 時 1 / devicePixelRatio）。/ The two references: the fit-to-frame scale and the 1:1 scale.
 */
export interface Bounds {
    fit: number;
    unit: number;
}

export interface ZoomLayout {
    /** 最後的顯示比例（遠端像素 → CSS px）。/ Final scale, remote px → CSS px. */
    scale: number;
    /** 裁切框（內容比框小時就是內容大小）。/ The clip box (the content size while it fits). */
    hostWidth: number;
    hostHeight: number;
    /** 夾過的平移量。/ The clamped pan. */
    ox: number;
    oy: number;
}

export const FIT: ZoomState = { mode: "fit", scale: 1, ox: 0, oy: 0 };

/** 「+ / −」會停的百分比（相對 1:1），「塞進框裡」也是一站。/ The button stops, in percent of 1:1 (fit is a stop too). */
export const PERCENT_STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 600, 800];

/** 手機上被縮小的畫面一打開的倍率（相對塞進框裡）。/ The phone default: 1.5× the fit scale. */
export const PHONE_ZOOM = 1.5;

/** 「塞進框裡」的比例：整張畫面剛好放進框。/ The scale that fits the content into the frame. */
export function fitScale(frame: Size, content: Size): number {
    if (content.width <= 0 || content.height <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
    return Math.min(frame.width / content.width, frame.height / content.height);
}

/** 可用的比例範圍：最小到「塞進框」與 25% 較小者，最大到「塞進框」與 1:1 較大者的 4 倍。/ The allowed scale range. */
export function scaleRange(b: Bounds): { min: number; max: number } {
    const fit = b.fit > 0 ? b.fit : b.unit;
    return { min: Math.min(fit, b.unit * 0.25), max: Math.max(fit, b.unit) * 4 };
}

export function clampScale(scale: number, b: Bounds): number {
    const { min, max } = scaleRange(b);
    if (!Number.isFinite(scale) || scale <= 0) return Math.min(Math.max(b.unit, min), max);
    return Math.min(Math.max(scale, min), max);
}

/** 模式 → 比例。/ The scale a mode gives in these bounds. */
export function modeScale(st: Pick<ZoomState, "mode" | "scale">, b: Bounds): number {
    switch (st.mode) {
        case "fit":
            return clampScale(b.fit, b);
        case "shrink":
            return clampScale(Math.min(b.fit, b.unit), b);
        case "actual":
            return clampScale(b.unit, b);
        default:
            return clampScale(st.scale, b);
    }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** 依狀態排版。/ Lay out the content for a zoom state. */
export function zoomLayout(frame: Size, content: Size, b: Bounds, st: ZoomState): ZoomLayout {
    const scale = modeScale(st, b);
    const cw = content.width * scale;
    const ch = content.height * scale;
    const hostWidth = Math.min(cw, frame.width);
    const hostHeight = Math.min(ch, frame.height);
    return { scale, hostWidth, hostHeight, ox: clamp(st.ox, 0, cw - hostWidth), oy: clamp(st.oy, 0, ch - hostHeight) };
}

/** 框內一點 → 遠端座標。/ A frame point → remote coordinates. */
export function remoteAt(frame: Size, content: Size, b: Bounds, st: ZoomState, p: Point): Point {
    const l = zoomLayout(frame, content, b, st);
    return {
        x: (p.x - (frame.width - l.hostWidth) / 2 + l.ox) / l.scale,
        y: (p.y - (frame.height - l.hostHeight) / 2 + l.oy) / l.scale,
    };
}

/**
 * 換到 `target` 這個狀態（模式或比例），讓 `from` 底下的遠端點落到 `to`。
 * Move to `target`, keeping the remote point under `from` under `to` (a moving point pans).
 */
function moveTo(frame: Size, content: Size, b: Bounds, start: ZoomState, from: Point, to: Point, target: Pick<ZoomState, "mode" | "scale">): ZoomState {
    const r = remoteAt(frame, content, b, start, from);
    const scale = modeScale(target, b);
    const hostWidth = Math.min(content.width * scale, frame.width);
    const hostHeight = Math.min(content.height * scale, frame.height);
    const ox = r.x * scale - (to.x - (frame.width - hostWidth) / 2);
    const oy = r.y * scale - (to.y - (frame.height - hostHeight) / 2);
    const st: ZoomState = { mode: target.mode, scale: target.mode === "scale" ? scale : start.scale, ox, oy };
    const l = zoomLayout(frame, content, b, st);
    return { ...st, ox: l.ox, oy: l.oy };
}

/**
 * 雙指：手勢開始時 `from` 底下的遠端點，縮放 `factor` 倍後要落在 `to`（兩指中點會移動 = 平移）。結果一律是 scale 模式。
 * Pinch / two-finger pan; the result is always a chosen scale.
 */
export function pinchZoom(frame: Size, content: Size, b: Bounds, start: ZoomState, from: Point, to: Point, factor: number): ZoomState {
    const scale = clampScale(modeScale(start, b) * factor, b);
    return moveTo(frame, content, b, start, from, to, { mode: "scale", scale });
}

/** 以框內某點為中心換到某個比例或模式（按鈕用框的中心）。/ Change scale or mode around a frame point. */
export function zoomAround(frame: Size, content: Size, b: Bounds, st: ZoomState, p: Point, target: Pick<ZoomState, "mode" | "scale">): ZoomState {
    return moveTo(frame, content, b, st, p, p, target);
}

/** 下一站（dir = 1）或上一站（dir = -1）的比例：百分比站 + 「塞進框裡」。/ The next stop up or down. */
export function stepScale(scale: number, dir: 1 | -1, b: Bounds): number {
    const { min, max } = scaleRange(b);
    const stops = [...PERCENT_STEPS.map((p) => (p / 100) * b.unit), b.fit, min, max]
        .filter((s) => s >= min - 1e-9 && s <= max + 1e-9)
        .sort((x, y) => x - y);
    if (dir > 0) return stops.find((s) => s > scale * 1.03) ?? max;
    return [...stops].reverse().find((s) => s < scale * 0.97) ?? min;
}

/** 這個比例相對 1:1 的百分比。/ The scale as a percentage of 1:1. */
export function percentOf(scale: number, unit: number): number {
    return unit > 0 ? Math.round((scale / unit) * 100) : 100;
}

/** 「125%」這種標籤。/ A label such as "125%". */
export function percentLabel(scale: number, unit: number): string {
    return `${percentOf(scale, unit)}%`;
}

/**
 * 新連線（或換螢幕）時的狀態：照偏好的模式；自訂百分比 = scale 模式。手機上被縮小的畫面（fit / shrink 而且比 1:1 小）
 * 放大一級，遠端的字才看得清楚。
 * The state for a new session or screen: the preferred mode, a custom percentage as a chosen scale; on phones a
 * shrunk picture opens one step above fit.
 */
export function initialZoom(pref: { mode: Exclude<ZoomMode, "scale"> | "custom"; percent: number }, b: Bounds, phone: boolean): ZoomState {
    if (pref.mode === "custom") return { mode: "scale", scale: clampScale((pref.percent / 100) * b.unit, b), ox: 0, oy: 0 };
    if (phone && pref.mode !== "actual" && b.fit < b.unit * 0.99) return { mode: "scale", scale: clampScale(b.fit * PHONE_ZOOM, b), ox: 0, oy: 0 };
    return { mode: pref.mode, scale: 1, ox: 0, oy: 0 };
}

/** 滑鼠靠近畫面邊緣多少 px 開始捲動、每個畫格最多捲多少 px。/ The edge zone and the top pan speed per frame. */
export const EDGE_ZONE = 32;
export const EDGE_SPEED = 16;

/**
 * 滑鼠的邊緣捲動（畫面比框大時，滑鼠用的平移）：指標在裁切框邊緣 `zone` px 內就往那一邊捲，越靠邊越快。
 * `p` 是框內座標；裁切框置中於框。回傳這一畫格要加到 ox / oy 的量（0 = 不捲）。
 * Edge scrolling for mouse users when the picture is larger than the frame: inside the clip box's edge zone the
 * view pans that way, faster nearer the edge. Returns this frame's change to ox / oy.
 */
export function edgePan(p: Point, frame: Size, l: Pick<ZoomLayout, "hostWidth" | "hostHeight">, zone = EDGE_ZONE, speed = EDGE_SPEED): Point {
    const left = (frame.width - l.hostWidth) / 2;
    const top = (frame.height - l.hostHeight) / 2;
    const axis = (v: number, start: number, size: number): number => {
        const a = v - start;
        if (a < 0 || a > size) return 0;
        if (a < zone) return -speed * (1 - a / zone);
        if (size - a < zone) return speed * (1 - (size - a) / zone);
        return 0;
    };
    return { x: axis(p.x, left, l.hostWidth), y: axis(p.y, top, l.hostHeight) };
}
