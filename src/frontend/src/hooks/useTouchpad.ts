"use client";

/**
 * 遠端畫面的「指標模式」（手機觸控板）：在 noVNC 之前攔下原始觸控事件（noVNC 完全收不到），用 `lib/touchpad.ts` 的
 * 狀態機判斷手勢，再用 RFB 自己的滑鼠函式送出；游標用 noVNC 自己畫的（遠端的形狀：箭頭、I 字、手指），由我們決定位置。
 * Pointer mode for the remote screen (a touchpad on phones): raw touch events are caught before noVNC (which never sees
 * them), the state machine in `lib/touchpad.ts` decides the gesture, and RFB's own mouse functions send it; the cursor is
 * noVNC's own (the remote's shape: arrow, I-beam, hand), placed where the touchpad says.
 */
import { useEffect, type RefObject } from "react";
import { HOLD_MS, moveCursor, PAD_IDLE, padStep, type PadAction, type PadEvent, type PadState, type Point } from "@/lib/touchpad";

/** RFB 內部的滑鼠函式（vendored KasmVNC fork，見 vendor/kasm-novnc）。/ RFB's internal mouse functions (the vendored fork). */
interface MouseRfb {
    _canvas?: HTMLCanvasElement;
    _cursor?: { move(clientX: number, clientY: number): void };
    _handleMouseMove(x: number, y: number): void;
    _handleMouseButton(x: number, y: number, down: boolean, bmask: number): void;
}

const LEFT = 0x1, RIGHT = 0x4, WHEEL_UP = 0x8, WHEEL_DOWN = 0x10, WHEEL_LEFT = 0x20, WHEEL_RIGHT = 0x40;

function centre(list: TouchList): Point {
    let x = 0, y = 0;
    for (let i = 0; i < list.length; i++) { x += list[i].clientX; y += list[i].clientY; }
    return list.length ? { x: x / list.length, y: y / list.length } : { x: 0, y: 0 };
}

export function useTouchpad(
    enabled: boolean,
    screenRef: RefObject<HTMLElement | null>,
    rfbRef: RefObject<unknown>,
    /** 游標目前的位置（相對於畫面元素頂端，鍵盤彈起時用來決定推多少）。/ The cursor's spot from the screen's top (for the keyboard push). */
    pointYRef: RefObject<number | null>,
) {
    useEffect(() => {
        const screen = screenRef.current;
        if (!enabled || !screen) return;
        const rfb = () => rfbRef.current as MouseRfb | null;
        const canvas = () => rfb()?._canvas ?? null;
        const sizeOf = (c: HTMLCanvasElement) => { const r = c.getBoundingClientRect(); return { width: r.width, height: r.height }; };
        // 游標位置記成畫面的比例（0–1）：canvas 縮放、轉向時位置跟著走。/ The cursor as fractions of the screen (0–1), so it follows rescaling and rotation.
        let frac = { x: 0.5, y: 0.5 };
        let state: PadState = PAD_IDLE;
        let holdTimer: ReturnType<typeof setTimeout> | undefined;

        const posPx = (c: HTMLCanvasElement): Point => { const z = sizeOf(c); return { x: frac.x * z.width, y: frac.y * z.height }; };
        const place = () => {
            const c = canvas();
            if (!c) return;
            const p = posPx(c);
            const cr = c.getBoundingClientRect(), sr = screen.getBoundingClientRect();
            rfb()?._cursor?.move(cr.left + p.x, cr.top + p.y);
            pointYRef.current = cr.top - sr.top + p.y;
        };
        const act = (a: PadAction) => {
            const r = rfb(), c = canvas();
            if (!r || !c) return;
            let p = posPx(c);
            switch (a.kind) {
                case "move": {
                    const z = sizeOf(c);
                    p = moveCursor(p, a.dx, a.dy, z);
                    frac = { x: z.width ? p.x / z.width : 0.5, y: z.height ? p.y / z.height : 0.5 };
                    r._handleMouseMove(p.x, p.y);
                    break;
                }
                case "click": {
                    const b = a.button === "right" ? RIGHT : LEFT;
                    r._handleMouseMove(p.x, p.y);
                    r._handleMouseButton(p.x, p.y, true, b);
                    r._handleMouseButton(p.x, p.y, false, b);
                    break;
                }
                case "down": r._handleMouseMove(p.x, p.y); r._handleMouseButton(p.x, p.y, true, LEFT); break;
                case "up": r._handleMouseButton(p.x, p.y, false, LEFT); break;
                case "scroll": {
                    // 內容跟著手指走：手指往下 = 滾輪往上。/ Content follows the fingers: fingers down = wheel up.
                    const press = (n: number, pos: number, neg: number) => {
                        const b = n > 0 ? pos : neg;
                        for (let i = 0; i < Math.abs(n); i++) { r._handleMouseButton(p.x, p.y, true, b); r._handleMouseButton(p.x, p.y, false, b); }
                    };
                    press(a.y, WHEEL_UP, WHEEL_DOWN);
                    press(a.x, WHEEL_LEFT, WHEEL_RIGHT);
                    break;
                }
            }
        };
        const feed = (e: PadEvent) => {
            const r = padStep(state, e);
            state = r.state;
            r.actions.forEach(act);
            place();
        };
        const onTouch = (e: TouchEvent) => {
            // noVNC（canvas 上的手勢與聚焦）收不到，頁面也不捲動。/ noVNC (gestures and focus on the canvas) never sees it; the page doesn't scroll.
            e.stopPropagation();
            if (e.cancelable) e.preventDefault();
            const t = performance.now();
            const fingers = e.touches.length;
            const at = fingers ? centre(e.touches) : centre(e.changedTouches);
            if (e.type === "touchstart") {
                feed({ type: "start", at, fingers, t });
                clearTimeout(holdTimer);
                if (fingers === 1) holdTimer = setTimeout(() => feed({ type: "hold", t: performance.now() }), HOLD_MS);
            } else if (e.type === "touchmove") {
                const before = state.phase;
                feed({ type: "move", at, fingers, t });
                if (state.phase !== before) clearTimeout(holdTimer);
            } else {
                clearTimeout(holdTimer);
                feed({ type: "end", at, fingers, t });
            }
        };
        const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
        for (const ty of types) screen.addEventListener(ty, onTouch, { capture: true, passive: false });
        const ro = new ResizeObserver(place);
        ro.observe(screen);
        place();
        return () => {
            for (const ty of types) screen.removeEventListener(ty, onTouch, { capture: true });
            clearTimeout(holdTimer);
            ro.disconnect();
            pointYRef.current = null;
        };
    }, [enabled, screenRef, rfbRef, pointYRef]);
}
