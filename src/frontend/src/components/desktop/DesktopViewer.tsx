"use client";

/**
 * 遠端桌面畫面（guacamole-common-js）。WebSocketTunnel 連 `/ws/desktop/<sid>/?ticket=…`（子協定 `guacamole`），
 * 第一個指令是 tunnel UUID，之後 guacd 的畫面指令直接畫進 Guacamole.Display。
 * - 鍵盤只在畫面取得焦點時送出（點一下畫面），所以頁面上的表單照常能打字；滑鼠 / 觸控走 Guacamole.Mouse。
 * - 容器大小改變 → 等比縮放畫面；RDP 另外送 `size`，遠端桌面會跟著改解析度（resize-method display-update）。
 * - 錯誤：guacd 的 `error` 指令（client.onerror）或後端的關閉碼（後端把代碼放在 close reason，tunnel.onerror
 *   拿到的 status.code 就是它）；VNC 伺服器要求我們沒給的帳密（onrequired）時直接斷線，請使用者補填。
 * Remote desktop canvas on guacamole-common-js; see the backend relay in `ws/desktop.rs`.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type * as Guac from "guacamole-common-js";
import { MousePointerClick } from "lucide-react";
import { getWsOrigin } from "@/lib/wsCommon";
import { useI18n } from "@/lib/i18n";
import { sessionFailure, type DesktopFailure, type DesktopStart } from "@/lib/desktop";

type GuacNS = typeof Guac;

let guacPromise: Promise<GuacNS> | null = null;
/** 動態載入（它在 import 時就碰 window，也讓頁面 bundle 小一點）。/ Lazy-load the client (touches window; keeps the page bundle small). */
export function loadGuacamole(): Promise<GuacNS> {
    if (!guacPromise) {
        guacPromise = import("guacamole-common-js").then((m) => ((m as unknown as { default?: GuacNS }).default ?? (m as unknown as GuacNS)));
    }
    return guacPromise;
}

const KEY_CTRL = 0xffe3;
const KEY_ALT = 0xffe9;
const KEY_DELETE = 0xffff;

export interface DesktopViewerHandle {
    disconnect: () => void;
    sendCtrlAltDel: () => void;
    sendClipboard: (text: string) => void;
    focus: () => void;
}

interface Props {
    start: DesktopStart;
    onConnected: () => void;
    /** 連線結束：failure = null 是正常結束。/ The session ended; null = a normal end. */
    onEnded: (failure: DesktopFailure | null) => void;
    /** 遠端複製了文字（剪貼簿政策允許時）。/ The remote copied text (when the policy allows). */
    onRemoteClipboard: (text: string) => void;
}

export const DesktopViewer = forwardRef<DesktopViewerHandle, Props>(function DesktopViewer({ start, onConnected, onEnded, onRemoteClipboard }, ref) {
    const { t } = useI18n();
    const frameRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const clientRef = useRef<Guac.Client | null>(null);
    const guacRef = useRef<GuacNS | null>(null);
    const endedRef = useRef(false);
    // 最新的回呼（連線只建一次，回呼可能每次 render 都換）。/ Latest callbacks; the connection is set up once.
    const callbacks = useRef({ onConnected, onEnded, onRemoteClipboard });
    useLayoutEffect(() => {
        callbacks.current = { onConnected, onEnded, onRemoteClipboard };
    });
    const [focused, setFocused] = useState(false);

    useImperativeHandle(ref, () => ({
        disconnect: () => clientRef.current?.disconnect(),
        sendCtrlAltDel: () => {
            const c = clientRef.current;
            if (!c) return;
            for (const k of [KEY_CTRL, KEY_ALT, KEY_DELETE]) c.sendKeyEvent(1, k);
            for (const k of [KEY_DELETE, KEY_ALT, KEY_CTRL]) c.sendKeyEvent(0, k);
        },
        sendClipboard: (text: string) => {
            const c = clientRef.current;
            const G = guacRef.current;
            if (!c || !G) return;
            const writer = new G.StringWriter(c.createClipboardStream("text/plain"));
            writer.sendText(text);
            writer.sendEnd();
        },
        focus: () => frameRef.current?.focus(),
    }), []);

    useEffect(() => {
        const frame = frameRef.current;
        const host = hostRef.current;
        if (!frame || !host) return;
        let disposed = false;
        let cleanup: (() => void) | null = null;
        endedRef.current = false;
        const end = (failure: DesktopFailure | null) => {
            if (endedRef.current) return;
            endedRef.current = true;
            callbacks.current.onEnded(failure);
        };

        void loadGuacamole().then((G) => {
            if (disposed) return;
            guacRef.current = G;
            const tunnel = new G.WebSocketTunnel(`${getWsOrigin()}${start.ws_path}`);
            const client = new G.Client(tunnel);
            clientRef.current = client;
            const display = client.getDisplay();
            const el = display.getElement();
            host.appendChild(el);

            // 等比縮放到容器裡（不放大超過 1:1）。/ Fit the remote screen into the frame (never upscale past 1:1).
            const rescale = () => {
                const w = display.getWidth();
                const h = display.getHeight();
                if (!w || !h) return;
                const box = frame.getBoundingClientRect();
                display.scale(Math.min(box.width / w, box.height / h, 1));
            };
            display.onresize = rescale;
            // 本機游標換成遠端游標的圖（沒有延遲）；瀏覽器不支援時用 Display 自己畫的軟體游標。
            // Show the remote cursor image as the local cursor (no lag); fall back to the display's software cursor.
            const mouse = new G.Mouse(el);
            display.oncursor = (canvas, x, y) => {
                display.showCursor(!mouse.setCursor(canvas, x, y));
            };
            const sendMouse = (e: Guac.Event) => client.sendMouseState((e as unknown as { state: Guac.Mouse.State }).state, true);
            mouse.onEach(["mousedown", "mouseup", "mousemove"], sendMouse);
            const touch = new G.Mouse.Touchscreen(el);
            touch.onEach(["mousedown", "mouseup", "mousemove"], sendMouse);

            const keyboard = new G.Keyboard(frame);
            keyboard.onkeydown = (keysym) => {
                client.sendKeyEvent(1, keysym);
                return false;
            };
            keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

            client.onstatechange = (state) => {
                if (state === 3) {
                    rescale();
                    callbacks.current.onConnected();
                    frame.focus();
                } else if (state === 5) {
                    end(null);
                }
            };
            client.onerror = (status) => end(sessionFailure(status.code, status.message));
            tunnel.onerror = (status) => end(sessionFailure(status.code, status.message));
            // VNC 伺服器要我們沒給的欄位（例如密碼）：不在串流裡補，直接請使用者重新連。
            // The server wants a parameter we did not send: disconnect and ask the user to fill it in.
            client.onrequired = (params) => {
                end({ key: "desktop.err.required", vars: { fields: params.join(", ") }, at: "target" });
                client.disconnect();
            };
            client.onclipboard = (stream, mimetype) => {
                if (!/^text\//.test(mimetype)) return;
                const reader = new G.StringReader(stream);
                let data = "";
                reader.ontext = (text) => { data += text; };
                reader.onend = () => callbacks.current.onRemoteClipboard(data);
            };

            // RDP 跟著框的大小改解析度；VNC 的解析度固定，只縮放。/ RDP follows the frame size; VNC only scales.
            let resizeTimer: ReturnType<typeof setTimeout> | null = null;
            const observer = new ResizeObserver(() => {
                rescale();
                if (start.protocol !== "rdp") return;
                if (resizeTimer) clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    const box = frame.getBoundingClientRect();
                    if (box.width > 0 && box.height > 0) client.sendSize(Math.round(box.width), Math.round(box.height));
                }, 400);
            });
            observer.observe(frame);

            const box = frame.getBoundingClientRect();
            const width = Math.max(320, Math.round(box.width));
            const height = Math.max(240, Math.round(box.height));
            client.connect(new URLSearchParams({ ticket: start.ticket, width: String(width), height: String(height), dpi: "96" }).toString());

            cleanup = () => {
                observer.disconnect();
                if (resizeTimer) clearTimeout(resizeTimer);
                keyboard.onkeydown = null;
                keyboard.onkeyup = null;
                keyboard.reset();
                client.onstatechange = null;
                client.onerror = null;
                tunnel.onerror = null;
                client.disconnect();
                el.remove();
            };
        }).catch(() => end({ key: "desktop.err.bundle", at: "browser" }));

        return () => {
            disposed = true;
            cleanup?.();
            clientRef.current = null;
        };
    }, [start]);

    return (
        <div
            ref={frameRef}
            tabIndex={0}
            onMouseDown={() => frameRef.current?.focus()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={t("desktop.viewerLabel")}
        >
            <div ref={hostRef} className="[&>div]:mx-auto" />
            {!focused && (
                <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-pop">
                    <MousePointerClick size={14} aria-hidden /> {t("desktop.clickToType")}
                </div>
            )}
        </div>
    );
});
