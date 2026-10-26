/**
 * 遠端桌面的縮放與平移（純函式）：在「塞進框裡」的比例上再乘一個倍率，超出框的部分用平移看。
 * 座標：`frame` 是畫面框（CSS px），內容（放大後的畫面）置中於框內；比框大時框就是裁切框，
 * `ox` / `oy` = 內容左上角往左 / 上捲了多少（CSS px，夾在 0 ~ 內容 − 框 之間）。
 * Zoom and pan for the remote desktop (pure): a factor on top of the fit-to-frame scale; whatever does not fit
 * is reached by panning. The content is centred in the frame; once larger, the frame clips it and
 * `ox` / `oy` are how far it is scrolled (CSS px, clamped to 0 … content − frame).
 */

export interface ZoomState {
    /** 相對「塞進框裡」的倍率（1 = 剛好塞進）。/ Factor over the fit scale (1 = fit). */
    zoom: number;
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

export const FIT: ZoomState = { zoom: 1, ox: 0, oy: 0 };

/** 「+ / −」會停的倍率。/ The steps the zoom buttons stop at. */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

/** 手機上 VNC / RustDesk 一打開的倍率：比「塞進框裡」大一級。/ The phone default: one step above fit. */
export const PHONE_ZOOM = ZOOM_STEPS[1];

/** 最大倍率：至少 4 倍，畫面縮得很小時放大到一個遠端像素約 2 CSS px。/ At least 4×, or up to ~2 CSS px per remote pixel. */
export function maxZoom(fit: number): number {
    return fit > 0 ? Math.max(4, 2 / fit) : 4;
}

export function clampZoom(zoom: number, fit: number): number {
    if (!Number.isFinite(zoom)) return 1;
    return Math.min(Math.max(zoom, 1), maxZoom(fit));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** 依倍率與平移排版。/ Lay out the content for a zoom state. */
export function zoomLayout(frame: Size, content: Size, fit: number, st: ZoomState): ZoomLayout {
    const zoom = clampZoom(st.zoom, fit);
    const scale = fit * zoom;
    const cw = content.width * scale;
    const ch = content.height * scale;
    const hostWidth = Math.min(cw, frame.width);
    const hostHeight = Math.min(ch, frame.height);
    return { scale, hostWidth, hostHeight, ox: clamp(st.ox, 0, cw - hostWidth), oy: clamp(st.oy, 0, ch - hostHeight) };
}

/** 框內一點 → 遠端座標。/ A frame point → remote coordinates. */
export function remoteAt(frame: Size, content: Size, fit: number, st: ZoomState, p: Point): Point {
    const l = zoomLayout(frame, content, fit, st);
    return {
        x: (p.x - (frame.width - l.hostWidth) / 2 + l.ox) / l.scale,
        y: (p.y - (frame.height - l.hostHeight) / 2 + l.oy) / l.scale,
    };
}

/**
 * 雙指：手勢開始時 `from` 底下的遠端點，縮放 `factor` 倍後要落在 `to`（兩指中點會移動 = 平移）。
 * Pinch / two-finger pan: the remote point under `from` when the gesture began ends up under `to`
 * after zooming by `factor` (a moving midpoint pans).
 */
export function pinchZoom(frame: Size, content: Size, fit: number, start: ZoomState, from: Point, to: Point, factor: number): ZoomState {
    const r = remoteAt(frame, content, fit, start, from);
    const zoom = clampZoom(start.zoom * factor, fit);
    const scale = fit * zoom;
    const hostWidth = Math.min(content.width * scale, frame.width);
    const hostHeight = Math.min(content.height * scale, frame.height);
    const ox = r.x * scale - (to.x - (frame.width - hostWidth) / 2);
    const oy = r.y * scale - (to.y - (frame.height - hostHeight) / 2);
    const l = zoomLayout(frame, content, fit, { zoom, ox, oy });
    return { zoom, ox: l.ox, oy: l.oy };
}

/** 以框內某點為中心換倍率（按鈕用框的中心）。/ Change the zoom around a frame point (buttons use the centre). */
export function zoomAround(frame: Size, content: Size, fit: number, st: ZoomState, p: Point, zoom: number): ZoomState {
    return pinchZoom(frame, content, fit, st, p, p, clampZoom(zoom, fit) / clampZoom(st.zoom, fit));
}

/** 下一個（dir = 1）或上一個（dir = -1）倍率。/ The next step up or down. */
export function stepZoom(zoom: number, dir: 1 | -1, fit: number): number {
    const max = maxZoom(fit);
    const steps = [...ZOOM_STEPS.filter((s) => s < max), max];
    if (dir > 0) return steps.find((s) => s > zoom + 0.01) ?? max;
    return [...steps].reverse().find((s) => s < zoom - 0.01) ?? 1;
}

/** 「1.5×」這種標籤。/ A label such as "1.5×". */
export function zoomLabel(zoom: number): string {
    const r = Math.round(zoom * 10) / 10;
    return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}×`;
}
