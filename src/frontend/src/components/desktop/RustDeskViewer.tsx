"use client";

/**
 * 網頁內 RustDesk 的畫面：vendored 的 RustDesk web core 在這一頁裡解碼（WebCodecs），Telepy 只中繼。
 * - 核心是 window 上的全域物件（`setByName` / `onVideoFrame` …），一頁同時只能有一個 RustDesk 畫面。
 * - 連線流程：`option` custom-rendezvous-server = 這個 session 的 wss 網址（核心會把它當 proxy，id 與 relay 都連
 *   同一條；後端看第一則訊息分角色）→ `session_add_sync {id: 目標位址, password}` → `session_start`。
 *   密碼由核心在瀏覽器裡做雜湊挑戰，不會送到 Telepy。不加密的直連會跳 msgbox，這裡自動確認（隧道本身加密）。
 * - 影像：`onVideoFrame(display, VideoFrame)` 畫到 canvas，`onRgba` 備援；canvas 等比縮進框裡，滑鼠座標除以比例。
 * - 縮放：雙指捏合 / 拖曳（useDesktopZoom），手機上被縮小的畫面一打開放大一級；canvas 放在裁切框裡、往左上挪平移量。
 * - 鍵盤：焦點放在隱藏的 textarea（輸入法才能組字），按鍵走 `input_key`（legacy 鍵名），組好的字走 `input_string`。
 * - 游標：`cursor_data`（RGBA）→ data URL → CSS cursor，`cursor_id` 切換。
 * - 剪貼簿：start 回的方向（使用者的選擇套上站台上限）在這裡套用——off = 這台的 `disable-clipboard`，
 *   to_remote = 本機照送、遠端複製的不收。資料流是 RustDesk 的（端對端或 Direct IP），後端管不到。
 * In-browser RustDesk: the vendored core decodes in this page, Telepy relays. See `lib/rustdesk.ts`.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { getWsOrigin } from "@/lib/wsCommon";
import { useI18n } from "@/lib/i18n";
import type { DesktopFailure } from "@/lib/desktop";
import type { StreamStats } from "@/lib/desktopStats";
import { useDesktopZoom } from "@/hooks/useDesktopZoom";
import { ZoomControl } from "@/components/desktop/ZoomControl";
import {
    classifyMsgbox,
    inputKeyJson,
    keyNameFor,
    loadRustDeskCore,
    mouseButtonName,
    mouseJson,
    parsePeerInfo,
    peerIdFor,
    qualityToStats,
    rustdeskCloseFailure,
    rustdeskWsUrl,
    wheelSteps,
    type RustDeskCore,
    type RustDeskPeerInfo,
    type RustDeskStart,
} from "@/lib/rustdesk";

export interface RustDeskViewerHandle {
    disconnect: () => void;
    typeText: (text: string) => void;
    sendCtrlAltDel: () => void;
    switchDisplay: (index: number) => void;
    /** RustDesk 自己的畫質檔。/ RustDesk's own quality profile. */
    setQuality: (quality: RustDeskQuality) => void;
    focus: () => void;
}

export type RustDeskQuality = "best" | "balanced" | "low";

interface Props {
    start: RustDeskStart;
    /** RustDesk 的固定密碼；只交給核心。/ The permanent password, handed to the core only. */
    password: string;
    onConnected: (info: RustDeskPeerInfo) => void;
    onEnded: (failure: DesktopFailure | null) => void;
    onPeerInfo: (info: RustDeskPeerInfo) => void;
    onStats: (stats: StreamStats) => void;
    onRemoteClipboard: (text: string) => void;
}

type Globals = Partial<RustDeskCore> & {
    onGlobalEvent?: ((json: string) => void) | null;
    onRegisteredEvent?: ((json: string) => void) | null;
    onVideoFrame?: ((display: number, frame: VideoFrame) => boolean) | null;
    onRgba?: ((display: number, rgba: Uint8Array, width: number, height: number) => boolean) | null;
    onInitFinished?: (() => void) | null;
};

export const RustDeskViewer = forwardRef<RustDeskViewerHandle, Props>(function RustDeskViewer({ start, password, onConnected, onEnded, onPeerInfo, onStats, onRemoteClipboard }, ref) {
    const { t } = useI18n();
    const frameRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rescaleRef = useRef<(() => void) | null>(null);
    const sinkRef = useRef<HTMLTextAreaElement | null>(null);
    const coreRef = useRef<RustDeskCore | null>(null);
    const scaleRef = useRef(1);
    const sizeRef = useRef({ width: 0, height: 0 });
    const infoRef = useRef<RustDeskPeerInfo | null>(null);
    const endedRef = useRef(false);
    const callbacks = useRef({ onConnected, onEnded, onPeerInfo, onStats, onRemoteClipboard });
    const passwordRef = useRef(password);
    useLayoutEffect(() => {
        callbacks.current = { onConnected, onEnded, onPeerInfo, onStats, onRemoteClipboard };
    });
    const [focused, setFocused] = useState(false);
    const zoom = useDesktopZoom(frameRef, () => rescaleRef.current?.(), () => true);
    const zoomRef = useRef({ layout: zoom.layout, restart: zoom.restart });
    useLayoutEffect(() => {
        zoomRef.current = { layout: zoom.layout, restart: zoom.restart };
    });

    const call = (name: string, arg?: unknown) => {
        const core = coreRef.current;
        if (!core) return;
        core.setByName(name, typeof arg === "string" || arg === undefined ? arg : JSON.stringify(arg));
    };

    useImperativeHandle(ref, () => ({
        disconnect: () => call("session_close", ""),
        typeText: (text: string) => call("input_string", text),
        sendCtrlAltDel: () => call("ctrl_alt_del", ""),
        switchDisplay: (index: number) => call("switch_display", { value: index }),
        setQuality: (quality: RustDeskQuality) => call("image_quality", quality),
        focus: () => sinkRef.current?.focus(),
    }), []);

    useEffect(() => {
        const frame = frameRef.current;
        const host = hostRef.current;
        const canvas = canvasRef.current;
        const sink = sinkRef.current;
        if (!frame || !host || !canvas || !sink) return;
        let disposed = false;
        endedRef.current = false;
        const clipboard = start.clipboard ?? "both";
        const ctx = canvas.getContext("2d");
        const cursors = new Map<string, string>();
        const end = (failure: DesktopFailure | null) => {
            if (endedRef.current) return;
            endedRef.current = true;
            callbacks.current.onEnded(failure);
        };

        // 等比縮進框裡（不放大過 1:1），再乘上縮放倍率；host 是裁切框，canvas 往左上挪平移量。
        // Fit the canvas into the frame (never above 1:1), times the zoom; the host clips, the canvas shifts by the pan.
        const rescale = () => {
            const { width, height } = sizeRef.current;
            if (!width || !height) return;
            const box = frame.getBoundingClientRect();
            const fit = Math.min(box.width / width, box.height / height, 1);
            const l = zoomRef.current.layout(box, { width, height }, fit, fit < 0.99);
            scaleRef.current = l.scale;
            host.style.width = `${l.hostWidth}px`;
            host.style.height = `${l.hostHeight}px`;
            canvas.style.width = `${width * l.scale}px`;
            canvas.style.height = `${height * l.scale}px`;
            canvas.style.marginLeft = `${-l.ox}px`;
            canvas.style.marginTop = `${-l.oy}px`;
        };
        rescaleRef.current = rescale;
        const observer = new ResizeObserver(rescale);
        observer.observe(frame);

        const draw = (display: number, width: number, height: number, paint: () => void) => {
            if (display !== (infoRef.current?.currentDisplay ?? 0)) return;
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                sizeRef.current = { width, height };
                // 換了螢幕或解析度：倍率回到預設。/ Another display or resolution: back to the default zoom.
                zoomRef.current.restart();
                rescale();
            }
            paint();
        };

        const g = window as unknown as Globals;
        const install = () => {
            g.onGlobalEvent = (json: string) => {
                let e: Record<string, unknown>;
                try {
                    e = JSON.parse(json);
                } catch {
                    return;
                }
                const name = String(e.name ?? "");
                switch (name) {
                    case "peer_info":
                    case "sync_peer_info": {
                        const first = !infoRef.current;
                        const info = parsePeerInfo(e, infoRef.current);
                        infoRef.current = info;
                        callbacks.current.onPeerInfo(info);
                        if (first) {
                            callbacks.current.onConnected(info);
                            sink.focus();
                        }
                        break;
                    }
                    case "switch_display": {
                        if (infoRef.current) {
                            const d = Number(e.display);
                            if (Number.isFinite(d)) infoRef.current = { ...infoRef.current, currentDisplay: d };
                            callbacks.current.onPeerInfo(infoRef.current);
                        }
                        break;
                    }
                    case "update_quality_status":
                        callbacks.current.onStats(qualityToStats(e, infoRef.current?.currentDisplay ?? 0));
                        break;
                    case "msgbox": {
                        const m = { type: String(e.type ?? ""), title: String(e.title ?? ""), text: String(e.text ?? "") };
                        const closed = /WebSocket closed \((\d+)\)/.exec(m.text);
                        if (closed) {
                            end(rustdeskCloseFailure(Number(closed[1])));
                            break;
                        }
                        const action = classifyMsgbox(m);
                        // 核心先發 msgbox 事件、之後才記下等答案的 resolver，所以同步回答會被丟掉：下一個 tick 再答。
                        // The core emits the msgbox before it stores the resolver, so a synchronous answer is lost: answer next tick.
                        if (action.kind === "continue") setTimeout(() => call("common", { name: "continue-insecure-connection", value: "Y" }), 0);
                        else if (action.kind === "failure") {
                            end(action.failure);
                            setTimeout(() => call("session_close", ""), 0);
                        }
                        break;
                    }
                    case "cursor_data": {
                        const id = String(e.id ?? "");
                        const width = Number(e.width);
                        const height = Number(e.height);
                        try {
                            const colors = JSON.parse(String(e.colors ?? "[]")) as number[];
                            if (width > 0 && height > 0 && colors.length >= width * height * 4) {
                                const c = document.createElement("canvas");
                                c.width = width;
                                c.height = height;
                                const cx = c.getContext("2d");
                                if (cx) {
                                    cx.putImageData(new ImageData(new Uint8ClampedArray(colors.slice(0, width * height * 4)), width, height), 0, 0);
                                    cursors.set(id, `url(${c.toDataURL()}) ${Number(e.hotx) || 0} ${Number(e.hoty) || 0}, auto`);
                                    canvas.style.cursor = cursors.get(id) ?? "auto";
                                }
                            }
                        } catch {
                            // 游標資料壞了就用預設游標。/ Bad cursor data: keep the default cursor.
                        }
                        break;
                    }
                    case "cursor_id": {
                        const css = cursors.get(String(e.id ?? ""));
                        if (css) canvas.style.cursor = css;
                        break;
                    }
                    case "clipboard": {
                        // 只有雙向時才收遠端複製的文字（to_remote = 只能貼進去）。/ Remote text only comes back when the direction is both.
                        const text = typeof e.content === "string" ? e.content : typeof e.text === "string" ? e.text : "";
                        if (text && clipboard === "both") callbacks.current.onRemoteClipboard(text);
                        break;
                    }
                    default:
                        break;
                }
            };
            g.onVideoFrame = (display: number, frame: VideoFrame) => {
                try {
                    draw(display, frame.displayWidth, frame.displayHeight, () => ctx?.drawImage(frame, 0, 0));
                } finally {
                    frame.close();
                }
                return true;
            };
            g.onRgba = (display: number, rgba: Uint8Array, width: number, height: number) => {
                if (width > 0 && height > 0) {
                    draw(display, width, height, () => ctx?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0));
                }
                return true;
            };
        };

        // 滑鼠：座標除以縮放比例 = 遠端像素。/ Mouse: client coordinates ÷ scale = remote pixels.
        const remotePoint = (ev: MouseEvent) => {
            const r = canvas.getBoundingClientRect();
            const s = scaleRef.current || 1;
            return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s };
        };
        const onMouseMove = (ev: MouseEvent) => {
            const p = remotePoint(ev);
            call("send_mouse", mouseJson("", p.x, p.y, null, ev));
        };
        const onMouseDown = (ev: MouseEvent) => {
            ev.preventDefault();
            sink.focus();
            const p = remotePoint(ev);
            call("send_mouse", mouseJson("down", p.x, p.y, mouseButtonName(ev.button), ev));
        };
        const onMouseUp = (ev: MouseEvent) => {
            ev.preventDefault();
            const p = remotePoint(ev);
            call("send_mouse", mouseJson("up", p.x, p.y, mouseButtonName(ev.button), ev));
        };
        const onWheel = (ev: WheelEvent) => {
            ev.preventDefault();
            const steps = wheelSteps(ev.deltaX, ev.deltaY);
            if (!steps.x && !steps.y) return;
            const p = remotePoint(ev);
            const m = mouseJson("wheel", p.x, p.y, null, ev);
            // 滾輪用 x / y 表示格數（不是座標）。/ For wheel events x / y carry the steps.
            m.x = String(steps.x);
            m.y = String(steps.y);
            call("send_mouse", m);
        };
        const onContextMenu = (ev: MouseEvent) => ev.preventDefault();
        canvas.addEventListener("mousemove", onMouseMove);
        canvas.addEventListener("mousedown", onMouseDown);
        canvas.addEventListener("mouseup", onMouseUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("contextmenu", onContextMenu);

        // 鍵盤：組字中不送按鍵；組好的字一次送。/ Keys go out as legacy names; composed text as one string.
        const onKeyDown = (ev: KeyboardEvent) => {
            const name = keyNameFor(ev);
            if (!name) return;
            ev.preventDefault();
            call("input_key", inputKeyJson(name, true, ev));
        };
        const onKeyUp = (ev: KeyboardEvent) => {
            const name = keyNameFor(ev);
            if (!name) return;
            ev.preventDefault();
            call("input_key", inputKeyJson(name, false, ev));
        };
        const onComposition = (ev: CompositionEvent) => {
            if (ev.data) call("input_string", ev.data);
            sink.value = "";
        };
        const onInput = (ev: Event) => {
            const ie = ev as InputEvent;
            if (ie.isComposing) return;
            // 沒經 keydown 的輸入（手機鍵盤、語音）整段送。/ Input that bypassed keydown (mobile keyboards, dictation).
            if (ie.inputType === "insertText" && ie.data && ie.data.length > 1) call("input_string", ie.data);
            sink.value = "";
        };
        const onFocus = () => setFocused(true);
        const onBlur = () => setFocused(false);
        sink.addEventListener("keydown", onKeyDown);
        sink.addEventListener("keyup", onKeyUp);
        sink.addEventListener("compositionend", onComposition);
        sink.addEventListener("input", onInput);
        sink.addEventListener("focus", onFocus);
        sink.addEventListener("blur", onBlur);

        void loadRustDeskCore()
            .then(async (core) => {
                if (disposed) return;
                coreRef.current = core;
                install();
                if (!core.rdCore?.ready) {
                    await new Promise<void>((resolve) => {
                        g.onInitFinished = () => resolve();
                        core.init();
                    });
                }
                if (disposed) return;
                const url = rustdeskWsUrl(getWsOrigin(), start);
                call("option", { name: "custom-rendezvous-server", value: url });
                call("option", { name: "relay-server", value: url });
                // 經 Telepy 的 RustDesk 伺服器時有伺服器公鑰：核心驗裝置金鑰後做端對端加密；經隧道（Direct IP）沒有。
                // With Telepy's RustDesk server the core verifies the device key and encrypts end to end; Direct IP has none.
                call("option", { name: "key", value: start.key ?? "" });
                // 剪貼簿關掉 = 這台的 disable-clipboard：核心不再送本機的剪貼簿，登入時也請裝置別送它的。
                // Clipboard off = the peer's disable-clipboard: the core stops sending ours and asks the device not to send its own.
                call("option:peer", { id: peerIdFor(start), name: "disable-clipboard", value: clipboard === "off" ? "Y" : "N" });
                call("session_add_sync", { id: peerIdFor(start), password: passwordRef.current, isFileTransfer: false, isTerminal: false });
                call("session_start", { id: peerIdFor(start) });
            })
            .catch(() => end({ key: "desktop.err.rdCore", at: "browser" }));

        return () => {
            disposed = true;
            rescaleRef.current = null;
            observer.disconnect();
            canvas.removeEventListener("mousemove", onMouseMove);
            canvas.removeEventListener("mousedown", onMouseDown);
            canvas.removeEventListener("mouseup", onMouseUp);
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("contextmenu", onContextMenu);
            sink.removeEventListener("keydown", onKeyDown);
            sink.removeEventListener("keyup", onKeyUp);
            sink.removeEventListener("compositionend", onComposition);
            sink.removeEventListener("input", onInput);
            sink.removeEventListener("focus", onFocus);
            sink.removeEventListener("blur", onBlur);
            if (coreRef.current) {
                try {
                    coreRef.current.setByName("session_close", "");
                } catch {
                    // 已經關了。/ Already closed.
                }
            }
            g.onGlobalEvent = null;
            g.onVideoFrame = null;
            g.onRgba = null;
            coreRef.current = null;
            infoRef.current = null;
        };
    }, [start]);

    return (
        <div
            ref={frameRef}
            className="relative flex h-full w-full touch-none items-center justify-center overflow-hidden bg-black"
            aria-label={t("desktop.viewerLabel")}
            onMouseDown={() => sinkRef.current?.focus()}
        >
            <div ref={hostRef} className="relative shrink-0 overflow-hidden">
                <canvas ref={canvasRef} className="block max-w-none" width={0} height={0} />
            </div>
            {zoom.touch && <ZoomControl zoom={zoom} />}
            <textarea
                ref={sinkRef}
                aria-hidden="true"
                tabIndex={-1}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="absolute bottom-0 left-0 h-0 w-0 resize-none border-0 bg-transparent p-0 text-transparent opacity-0 outline-none"
            />
            {!focused && (
                <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-pop">
                    <MousePointerClick size={14} aria-hidden /> {t("desktop.clickToType")}
                </div>
            )}
        </div>
    );
});
