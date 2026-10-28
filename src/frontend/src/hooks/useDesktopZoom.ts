"use client";

/**
 * 遠端桌面的縮放 / 平移（兩個畫面元件共用：guacd 的 DesktopViewer、RustDeskViewer）。
 * - 起始方式來自顯示偏好（塞進框裡 / 只縮不放 / 1:1 / 自訂百分比，lib/desktopDisplay）；新的連線、換螢幕或改了偏好時重新套用。
 * - 工具列的縮放選單（滑鼠也能用）與觸控裝置上畫面右上角的 − / % / + 都呼叫這裡的 zoomIn / zoomOut / setMode。
 * - 雙指捏合縮放、雙指拖曳平移（單指照舊是遠端滑鼠：點一下 = 點擊、長按 = 右鍵）；滑鼠移到畫面邊緣就往那邊捲（畫面比框大時）。
 * - 手機（觸控 + 窄螢幕）上被縮小的畫面一打開放大一級，遠端的字才看得清楚。
 * - 畫面元件在自己的 rescale 裡呼叫 `layout()` 取得比例、裁切框與平移量；手勢 / 按鈕改了狀態就叫它重排。
 * Zoom and pan for both desktop viewers. The starting mode comes from the display preferences; the toolbar menu,
 * the touch pill and two-finger gestures change it. Viewers call `layout()` from their rescale.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { edgePan, FIT, fitScale, percentOf, initialZoom, pinchZoom, scaleRange, stepScale, zoomAround, zoomLayout, modeScale, type Bounds, type Point, type Size, type ZoomLayout, type ZoomMode, type ZoomState } from "@/lib/desktopZoom";
import type { ScaleMode } from "@/lib/desktopDisplay";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/** 手機：觸控為主、窄螢幕。/ A phone: coarse pointer and a narrow screen. */
const PHONE_QUERY = "(pointer: coarse) and (max-width: 639px)";

interface Geometry {
    frame: Size;
    content: Size;
    bounds: Bounds;
}

interface Gesture {
    start: ZoomState;
    from: Point;
    distance: number;
}

/** 給工具列看的狀態。/ What the toolbar shows. */
export interface ZoomInfo {
    mode: ZoomMode;
    /** 相對 1:1 的百分比。/ Percent of 1:1. */
    percent: number;
    /** 塞進框裡是幾 %（「塞進框裡」那一項旁邊顯示）。/ The fit scale in percent. */
    fitPercent: number;
    canZoomIn: boolean;
    canZoomOut: boolean;
}

export const EMPTY_ZOOM: ZoomInfo = { mode: "fit", percent: 100, fitPercent: 100, canZoomIn: false, canZoomOut: false };

export interface ZoomPref {
    mode: ScaleMode;
    percent: number;
}

export interface DesktopZoom {
    /** 依目前狀態排版；第一次有畫面時套用偏好（手機上放大一級）。`unit` = 1:1 的比例。/ Lay out at the current state. */
    layout: (frame: Size, content: Size, unit: number) => ZoomLayout;
    /** 下一次排版時重新套用偏好（新的連線、換螢幕）。/ Re-apply the preference at the next layout. */
    restart: () => void;
    info: ZoomInfo;
    zoomIn: () => void;
    zoomOut: () => void;
    /** 換成塞進框 / 只縮不放 / 1:1（以框的中心）。/ Switch to fit / shrink / 1:1 around the frame centre. */
    setMode: (mode: Exclude<ZoomMode, "scale">) => void;
    /** 指定百分比（相對 1:1）。/ A given percentage of 1:1. */
    setPercent: (percent: number) => void;
    /** 觸控裝置：畫面上顯示縮放按鈕。/ Touch device: show the on-picture buttons. */
    touch: boolean;
}

export function useDesktopZoom(frameRef: RefObject<HTMLElement | null>, relayout: () => void, enabled: () => boolean, pref: ZoomPref): DesktopZoom {
    const touch = useMediaQuery("(pointer: coarse)") ?? false;
    const stateRef = useRef<ZoomState>(FIT);
    const pendingRef = useRef(true);
    const geomRef = useRef<Geometry | null>(null);
    const [info, setInfo] = useState<ZoomInfo>(EMPTY_ZOOM);
    // 最新的回呼與偏好（手勢監聽只掛一次）。/ Latest callbacks and preference; the listeners are attached once.
    const fns = useRef({ relayout, enabled, pref });
    useEffect(() => {
        fns.current = { relayout, enabled, pref };
    });

    const publish = useCallback((st: ZoomState, scale: number, b: Bounds) => {
        const { min, max } = scaleRange(b);
        const next: ZoomInfo = {
            mode: st.mode,
            percent: percentOf(scale, b.unit),
            fitPercent: percentOf(b.fit, b.unit),
            canZoomIn: scale < max * 0.99,
            canZoomOut: scale > min * 1.01,
        };
        setInfo((prev) => (prev.mode === next.mode && prev.percent === next.percent && prev.fitPercent === next.fitPercent && prev.canZoomIn === next.canZoomIn && prev.canZoomOut === next.canZoomOut ? prev : next));
    }, []);

    const layout = useCallback((frame: Size, content: Size, unit: number): ZoomLayout => {
        const bounds: Bounds = { fit: fitScale(frame, content), unit: unit > 0 ? unit : 1 };
        if (pendingRef.current && content.width > 0 && content.height > 0) {
            pendingRef.current = false;
            const phone = typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches;
            stateRef.current = initialZoom(fns.current.pref, bounds, phone);
        }
        const l = zoomLayout(frame, content, bounds, stateRef.current);
        stateRef.current = { ...stateRef.current, ox: l.ox, oy: l.oy };
        geomRef.current = { frame: { width: frame.width, height: frame.height }, content, bounds };
        publish(stateRef.current, l.scale, bounds);
        return l;
    }, [publish]);

    const restart = useCallback(() => {
        pendingRef.current = true;
    }, []);

    // 手勢 / 按鈕改了狀態：一個畫格重排一次。/ Re-layout at most once per frame.
    const raf = useRef<number | null>(null);
    const apply = useCallback((st: ZoomState) => {
        stateRef.current = st;
        if (raf.current !== null) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = null;
            fns.current.relayout();
        });
    }, []);

    // 偏好改了（偏好設定或工具列裡的「預設」）：重新套用並重排。/ A changed preference is applied right away.
    const prefKey = `${pref.mode}:${pref.percent}`;
    useEffect(() => {
        pendingRef.current = true;
        fns.current.relayout();
    }, [prefKey]);

    const around = (target: Pick<ZoomState, "mode" | "scale">) => {
        const g = geomRef.current;
        if (!g) return;
        const centre = { x: g.frame.width / 2, y: g.frame.height / 2 };
        apply(zoomAround(g.frame, g.content, g.bounds, stateRef.current, centre, target));
    };
    const step = (dir: 1 | -1) => {
        const g = geomRef.current;
        if (!g) return;
        around({ mode: "scale", scale: stepScale(modeScale(stateRef.current, g.bounds), dir, g.bounds) });
    };

    useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        let gesture: Gesture | null = null;
        const pair = (e: TouchEvent): { mid: Point; distance: number } | null => {
            if (e.touches.length < 2) return null;
            const r = frame.getBoundingClientRect();
            const a = e.touches[0];
            const b = e.touches[1];
            return {
                mid: { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top },
                distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
            };
        };
        const onStart = (e: TouchEvent) => {
            if (e.touches.length < 2 || !fns.current.enabled()) return;
            const p = pair(e);
            if (!p || !geomRef.current) return;
            e.preventDefault();
            gesture = { start: stateRef.current, from: p.mid, distance: Math.max(1, p.distance) };
        };
        const onMove = (e: TouchEvent) => {
            if (!gesture) return;
            const p = pair(e);
            const g = geomRef.current;
            if (!p || !g) return;
            e.preventDefault();
            apply(pinchZoom(g.frame, g.content, g.bounds, gesture.start, gesture.from, p.mid, p.distance / gesture.distance));
        };
        const onEnd = (e: TouchEvent) => {
            if (gesture && e.touches.length < 2) gesture = null;
        };
        // 滑鼠的邊緣捲動：指標在畫面邊緣時每個畫格捲一點，捲不動了就停。/ Mouse edge scrolling, one step per frame until it stops moving.
        let pointer: Point | null = null;
        let loop: number | null = null;
        const tick = () => {
            loop = null;
            const g = geomRef.current;
            if (!pointer || !g || !fns.current.enabled()) return;
            const l = zoomLayout(g.frame, g.content, g.bounds, stateRef.current);
            const d = edgePan(pointer, g.frame, l);
            if (!d.x && !d.y) return;
            const next = zoomLayout(g.frame, g.content, g.bounds, { ...stateRef.current, ox: l.ox + d.x, oy: l.oy + d.y });
            if (Math.abs(next.ox - l.ox) < 0.01 && Math.abs(next.oy - l.oy) < 0.01) return;
            stateRef.current = { ...stateRef.current, ox: next.ox, oy: next.oy };
            fns.current.relayout();
            loop = requestAnimationFrame(tick);
        };
        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerType !== "mouse") return;
            const r = frame.getBoundingClientRect();
            pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
            if (loop === null) loop = requestAnimationFrame(tick);
        };
        const onPointerLeave = () => {
            pointer = null;
        };
        frame.addEventListener("pointermove", onPointerMove, true);
        frame.addEventListener("pointerleave", onPointerLeave);
        frame.addEventListener("touchstart", onStart, { passive: false });
        frame.addEventListener("touchmove", onMove, { passive: false });
        frame.addEventListener("touchend", onEnd);
        frame.addEventListener("touchcancel", onEnd);
        return () => {
            frame.removeEventListener("touchstart", onStart);
            frame.removeEventListener("touchmove", onMove);
            frame.removeEventListener("touchend", onEnd);
            frame.removeEventListener("touchcancel", onEnd);
            frame.removeEventListener("pointermove", onPointerMove, true);
            frame.removeEventListener("pointerleave", onPointerLeave);
            if (loop !== null) cancelAnimationFrame(loop);
            if (raf.current !== null) cancelAnimationFrame(raf.current);
            raf.current = null;
        };
    }, [frameRef, apply]);

    return {
        layout,
        restart,
        info,
        zoomIn: () => step(1),
        zoomOut: () => step(-1),
        setMode: (mode) => around({ mode, scale: 1 }),
        setPercent: (percent) => {
            const g = geomRef.current;
            if (g) around({ mode: "scale", scale: (percent / 100) * g.bounds.unit });
        },
        touch,
    };
}
