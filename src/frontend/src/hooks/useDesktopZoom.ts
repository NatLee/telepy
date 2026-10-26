"use client";

/**
 * 遠端桌面的縮放 / 平移（兩個畫面元件共用：guacd 的 DesktopViewer、RustDeskViewer）。
 * - 雙指捏合縮放、雙指拖曳平移（單指照舊是遠端滑鼠：點一下 = 點擊、長按 = 右鍵）。
 * - 手機（觸控 + 窄螢幕）上，畫面被縮小時（VNC / RustDesk 的固定解析度）一打開就放大一級，遠端的字才看得清楚；
 *   RDP 的解析度跟著框走、本來就是 1:1，不放大。新的連線或換螢幕時重新套用。
 * - 畫面元件在自己的 rescale 裡呼叫 `layout()` 取得比例、裁切框與平移量；手勢 / 按鈕改了倍率就叫它重排。
 * Zoom and pan for both desktop viewers: two-finger pinch / pan (one finger stays the remote mouse), and on
 * phones a shrunk picture (VNC / RustDesk) opens one step above fit. Viewers call `layout()` from their rescale.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { FIT, maxZoom, PHONE_ZOOM, pinchZoom, stepZoom, zoomAround, zoomLayout, type Point, type Size, type ZoomLayout, type ZoomState } from "@/lib/desktopZoom";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/** 手機：觸控為主、窄螢幕。/ A phone: coarse pointer and a narrow screen. */
const PHONE_QUERY = "(pointer: coarse) and (max-width: 639px)";

interface Geometry {
    frame: Size;
    content: Size;
    fit: number;
}

interface Gesture {
    start: ZoomState;
    from: Point;
    distance: number;
}

export interface DesktopZoom {
    /** 依目前倍率排版；第一次有畫面時套用手機預設倍率。`shrunk` = 塞進框裡時畫面被縮小。/ Lay out at the current zoom. */
    layout: (frame: Size, content: Size, fit: number, shrunk: boolean) => ZoomLayout;
    /** 下一次排版時重新套用預設倍率（新的連線、換螢幕）。/ Re-apply the default at the next layout. */
    restart: () => void;
    zoom: number;
    canZoomIn: boolean;
    zoomIn: () => void;
    zoomOut: () => void;
    fit: () => void;
    /** 觸控裝置：顯示縮放按鈕。/ Touch device: show the zoom buttons. */
    touch: boolean;
}

export function useDesktopZoom(frameRef: RefObject<HTMLElement | null>, relayout: () => void, enabled: () => boolean): DesktopZoom {
    const touch = useMediaQuery("(pointer: coarse)") ?? false;
    const stateRef = useRef<ZoomState>(FIT);
    const pendingRef = useRef(true);
    const geomRef = useRef<Geometry | null>(null);
    const [zoom, setZoom] = useState(1);
    const [canZoomIn, setCanZoomIn] = useState(true);
    // 最新的回呼（手勢監聽只掛一次）。/ Latest callbacks; the listeners are attached once.
    const fns = useRef({ relayout, enabled });
    useEffect(() => {
        fns.current = { relayout, enabled };
    });

    const publish = useCallback((st: ZoomState, fit: number) => {
        setZoom(st.zoom);
        setCanZoomIn(st.zoom < maxZoom(fit) - 0.01);
    }, []);

    const layout = useCallback((frame: Size, content: Size, fit: number, shrunk: boolean): ZoomLayout => {
        if (pendingRef.current && content.width > 0 && content.height > 0) {
            pendingRef.current = false;
            const phone = typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches;
            stateRef.current = { zoom: phone && shrunk ? PHONE_ZOOM : 1, ox: 0, oy: 0 };
        }
        const l = zoomLayout(frame, content, fit, stateRef.current);
        stateRef.current = { zoom: fit > 0 ? l.scale / fit : 1, ox: l.ox, oy: l.oy };
        geomRef.current = { frame: { width: frame.width, height: frame.height }, content, fit };
        publish(stateRef.current, fit);
        return l;
    }, [publish]);

    const restart = useCallback(() => {
        pendingRef.current = true;
    }, []);

    // 手勢 / 按鈕改了倍率：一個畫格重排一次。/ Re-layout at most once per frame.
    const raf = useRef<number | null>(null);
    const apply = useCallback((st: ZoomState) => {
        stateRef.current = st;
        if (raf.current !== null) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = null;
            fns.current.relayout();
        });
    }, []);

    const step = (dir: 1 | -1 | 0) => {
        const g = geomRef.current;
        if (!g) return;
        const centre = { x: g.frame.width / 2, y: g.frame.height / 2 };
        const target = dir === 0 ? 1 : stepZoom(stateRef.current.zoom, dir, g.fit);
        apply(dir === 0 ? FIT : zoomAround(g.frame, g.content, g.fit, stateRef.current, centre, target));
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
            apply(pinchZoom(g.frame, g.content, g.fit, gesture.start, gesture.from, p.mid, p.distance / gesture.distance));
        };
        const onEnd = (e: TouchEvent) => {
            if (gesture && e.touches.length < 2) gesture = null;
        };
        frame.addEventListener("touchstart", onStart, { passive: false });
        frame.addEventListener("touchmove", onMove, { passive: false });
        frame.addEventListener("touchend", onEnd);
        frame.addEventListener("touchcancel", onEnd);
        return () => {
            frame.removeEventListener("touchstart", onStart);
            frame.removeEventListener("touchmove", onMove);
            frame.removeEventListener("touchend", onEnd);
            frame.removeEventListener("touchcancel", onEnd);
            if (raf.current !== null) cancelAnimationFrame(raf.current);
            raf.current = null;
        };
    }, [frameRef, apply]);

    return {
        layout,
        restart,
        zoom,
        canZoomIn,
        zoomIn: () => step(1),
        zoomOut: () => step(-1),
        fit: () => step(0),
        touch,
    };
}
