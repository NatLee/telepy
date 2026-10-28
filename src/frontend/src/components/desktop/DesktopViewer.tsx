"use client";

/**
 * 遠端桌面畫面（guacamole-common-js）。WebSocketTunnel 連 `/ws/desktop/<sid>/?ticket=…`（子協定 `guacamole`），
 * 第一個指令是 tunnel UUID，之後 guacd 的畫面指令直接畫進 Guacamole.Display。
 * - 鍵盤：焦點放在一個看不見的 textarea（Guacamole.InputSink）而不是 div —— 輸入法只會在可編輯元素上組字，
 *   所以這樣中文 / 日文等 IME 才打得進去（組好的字以 Unicode keysym 送出）。點一下畫面就取得焦點；
 *   頁面上其他表單照常能打字。滑鼠 / 觸控走 Guacamole.Mouse。
 * - 「Ctrl 當 ⌘」：對 macOS 桌面把 Control 送成 Meta（Command），Windows / Linux 的瀏覽器才能用 Ctrl+C 之類的快捷鍵。
 * - 只看一個螢幕：`viewport` 把畫面裁成那個矩形（多螢幕的 VNC 桌面）；座標仍是整張畫面的，滑鼠位置照舊正確。
 * - 解析度（lib/desktopDisplay）：跟著框走的 session（start 的 `resize`：RDP 預設、VNC 要另外開）在框大小改變時送
 *   `size`（HiDPI 開著時是 devicePixelRatio 倍、縮回 CSS 大小，字才銳利）；固定解析度的就只在瀏覽器裡縮放。
 *   連線中改了解析度 / HiDPI 的偏好，跟著框走的 session 立刻送新的 `size`。
 * - 縮放（useDesktopZoom）：塞進框裡 / 只縮不放 / 1:1 / 自訂百分比，工具列與手機上的 − / % / + 都能改；
 *   雙指捏合 / 拖曳；放大後框是裁切框、畫面元素往左上挪。
 * - 串流統計：中繼每秒送 `telepy-ping`（這裡立刻回 `telepy-pong`）與 `telepy-stats`（交給 onStats）；
 *   兩者在交給 Guacamole.Client 前攔下。tunnel 的 UNSTABLE 狀態也往上報。
 * - 聲音（只有 RDP、start 時開了才有）：guacd 開 `audio` 串流（L16 PCM），guacamole-common-js 的 RawAudioPlayer 播；
 *   靜音 = 在這裡把 blob 丟掉（不排進 AudioContext，取消靜音時不會一次湧出來）。播放器用的 AudioContext 是頁面在
 *   「連線」那一下點擊裡建好的共用 context（lib/soundTap `primeAudio`），不然它會在 WebSocket 訊息裡才建、被瀏覽器的
 *   自動播放限制擋住；之後在框上點擊 / 按鍵也會 resume。每塊 blob 量峰值，`onSound` 回報給 lib/desktopSound 判斷
 *   「在播 / 瀏覽器擋著 / 遠端安靜 / 遠端沒開聲音通道」。
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
import { parseStats, PING_OPCODE, PONG_OPCODE, STATS_OPCODE, type StreamStats } from "@/lib/desktopStats";
import { EMPTY_SNAPSHOT, pcmPeak, rawBytesPerSample, type SoundSnapshot } from "@/lib/desktopSound";
import { sameSnapshot, sharedAudio, SoundTap } from "@/lib/soundTap";
import { rectFromPoints, type Framebuffer, type Viewport } from "@/lib/desktopScreens";
import { FIT, fitScale, zoomLayout, type ZoomMode } from "@/lib/desktopZoom";
import { requestedSize, type DisplayPrefs } from "@/lib/desktopDisplay";
import { useDesktopZoom, type ZoomInfo } from "@/hooks/useDesktopZoom";
import { Button } from "@/components/ui/button";
import { ZoomControl } from "@/components/desktop/ZoomControl";

type GuacNS = typeof Guac;

let guacPromise: Promise<GuacNS> | null = null;
/** 動態載入（它在 import 時就碰 window，也讓頁面 bundle 小一點）。/ Lazy-load the client (touches window; keeps the page bundle small). */
export function loadGuacamole(): Promise<GuacNS> {
    if (!guacPromise) {
        guacPromise = import("guacamole-common-js").then((m) => ((m as unknown as { default?: GuacNS }).default ?? (m as unknown as GuacNS)));
    }
    return guacPromise;
}

const KEY_CTRL_L = 0xffe3;
const KEY_CTRL_R = 0xffe4;
const KEY_META_L = 0xffe7;
const KEY_META_R = 0xffe8;
const KEY_ALT = 0xffe9;
const KEY_DELETE = 0xffff;
const KEY_RETURN = 0xff0d;
const KEY_TAB = 0xff09;
/** 送文字時每個字的間隔（有些 VNC 伺服器會吃掉太密的按鍵）。/ Pause between typed characters. */
const TYPE_INTERVAL_MS = 8;

/** 一個字 → X11 keysym（Latin-1 直接對應，其他走 Unicode keysym）。/ A code point as an X11 keysym. */
export function keysymForCodePoint(cp: number): number | null {
    if (cp === 0x0a) return KEY_RETURN;
    if (cp === 0x09) return KEY_TAB;
    if (cp === 0x0d) return null;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
    if (cp < 0x20) return null;
    return 0x01000000 | cp;
}

/** Control → Meta（⌘）。/ Control → Meta (Command). */
function ctrlToCmd(keysym: number): number {
    if (keysym === KEY_CTRL_L) return KEY_META_L;
    if (keysym === KEY_CTRL_R) return KEY_META_R;
    return keysym;
}

export interface DesktopViewerHandle {
    disconnect: () => void;
    sendCtrlAltDel: () => void;
    sendClipboard: (text: string) => void;
    /** 把文字當按鍵一個個送出（IME 的備援）。/ Type text as key presses (the IME fallback). */
    typeText: (text: string) => void;
    focus: () => void;
    /** 畫面上這一點是不是黑的（多螢幕排列推斷用）。/ Is this framebuffer pixel black (layout inference)? */
    isBlack: (x: number, y: number) => boolean;
    /** 在點擊裡呼叫：讓被自動播放限制擋住的聲音動起來。/ From a click: let sound the browser held back play. */
    resumeSound: () => void;
    /** 工具列的縮放：放大 / 縮小 / 換模式 / 指定百分比。/ The toolbar's zoom commands. */
    zoom: ZoomCommands;
}

export interface ZoomCommands {
    zoomIn: () => void;
    zoomOut: () => void;
    setMode: (mode: Exclude<ZoomMode, "scale">) => void;
    setPercent: (percent: number) => void;
}

interface Props {
    start: DesktopStart;
    /** 只看這個矩形；null = 整張畫面。/ Crop to this rectangle; null = everything. */
    viewport: Viewport | null;
    /** 框選模式：顯示整張畫面，讓使用者拖出要看的區域（鍵盤滑鼠不送往遠端）。/ Area-selection mode over the whole desktop. */
    selecting: boolean;
    /** 框選完成（null = 取消）。/ The dragged area, or null when cancelled. */
    onAreaSelected: (area: Viewport | null) => void;
    /** 1 = CSS 像素；devicePixelRatio = 向 guacd 要裝置像素（HiDPI）。/ 1, or devicePixelRatio for HiDPI. */
    pixelRatio: number;
    /** 顯示偏好：縮放方式、解析度。/ Display preferences: scaling and resolution. */
    display: DisplayPrefs;
    /** 縮放狀態變了（工具列顯示百分比）。/ The zoom changed (the toolbar shows the percentage). */
    onZoom?: (info: ZoomInfo) => void;
    /** Control 送成 Command（macOS 桌面）。/ Send Control as Command. */
    ctrlAsCmd: boolean;
    onConnected: () => void;
    /** 連線結束：failure = null 是正常結束。/ The session ended; null = a normal end. */
    onEnded: (failure: DesktopFailure | null) => void;
    /** 遠端複製了文字（剪貼簿政策允許時）。/ The remote copied text (when the policy allows). */
    onRemoteClipboard: (text: string) => void;
    onStats: (stats: StreamStats) => void;
    onTunnelUnstable: (unstable: boolean) => void;
    /** 遠端畫面的大小（整張，裁切前）。/ The framebuffer size before any crop. */
    onDisplaySize: (size: Framebuffer) => void;
    /** 目前的顯示比例（1 = 1:1）。/ The current display scale. */
    onScale: (scale: number) => void;
    /** 聲音靜音（只在瀏覽器這邊；串流照收）。/ Mute the sound locally (the stream keeps coming). */
    muted?: boolean;
    /** 聲音的狀況變了（通道、資料、靜音與否、AudioContext）。/ The sound's situation changed. */
    onSound?: (snapshot: SoundSnapshot) => void;
}

export const DesktopViewer = forwardRef<DesktopViewerHandle, Props>(function DesktopViewer({ start, viewport, selecting, onAreaSelected, pixelRatio, display, onZoom, ctrlAsCmd, onConnected, onEnded, onRemoteClipboard, onStats, onTunnelUnstable, onDisplaySize, onScale, muted = false, onSound }, ref) {
    const { t } = useI18n();
    const frameRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const clientRef = useRef<Guac.Client | null>(null);
    const guacRef = useRef<GuacNS | null>(null);
    const keyboardRef = useRef<Guac.Keyboard | null>(null);
    const sinkRef = useRef<Guac.InputSink | null>(null);
    const displayElRef = useRef<HTMLElement | null>(null);
    const rescaleRef = useRef<(() => void) | null>(null);
    const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const soundRef = useRef(new SoundTap());
    const endedRef = useRef(false);
    // 最新的回呼與選項（連線只建一次，這些每次 render 都可能換）。/ Latest callbacks and options; the connection is set up once.
    const callbacks = useRef({ onConnected, onEnded, onRemoteClipboard, onStats, onTunnelUnstable, onDisplaySize, onScale, onAreaSelected, onSound });
    const options = useRef({ viewport, pixelRatio, ctrlAsCmd, selecting, muted, display });
    useLayoutEffect(() => {
        callbacks.current = { onConnected, onEnded, onRemoteClipboard, onStats, onTunnelUnstable, onDisplaySize, onScale, onAreaSelected, onSound };
        options.current = { viewport, pixelRatio, ctrlAsCmd, selecting, muted, display };
    });
    const [focused, setFocused] = useState(false);
    // 框選時不縮放（兩指手勢交給框選層）。/ No zooming while selecting an area.
    const zoom = useDesktopZoom(frameRef, () => rescaleRef.current?.(), () => !options.current.selecting, { mode: display.scale, percent: display.percent });
    const sendSizeRef = useRef<(() => void) | null>(null);
    // 工具列要顯示百分比。/ The toolbar shows the percentage.
    const zoomInfo = zoom.info;
    useEffect(() => {
        onZoom?.(zoomInfo);
    }, [zoomInfo, onZoom]);
    // 連線中改了解析度 / HiDPI：跟著框走的 session 立刻要新的大小。/ A changed resolution or HiDPI resizes a following session now.
    const sizeKey = `${display.resolution}:${display.fixed.width}x${display.fixed.height}:${pixelRatio}`;
    useEffect(() => {
        sendSizeRef.current?.();
    }, [sizeKey]);
    const zoomLayoutRef = useRef(zoom.layout);
    const zoomCmds = useRef<ZoomCommands>(zoom);
    useLayoutEffect(() => {
        zoomLayoutRef.current = zoom.layout;
        zoomCmds.current = zoom;
    });

    // 換螢幕、進出框選模式 → 重新裁切縮放。/ A new viewport or selection mode re-crops the display.
    useEffect(() => {
        rescaleRef.current?.();
    }, [viewport, pixelRatio, selecting]);
    // 換到別的螢幕 / 區域：倍率回到預設。比對位置而不是物件（選單打開時會重算出新物件）。
    // Another screen or area resets the zoom; compare the rectangle, not the object (the menu recomputes them).
    const viewportKey = viewport ? `${viewport.x},${viewport.y},${viewport.width},${viewport.height}` : "";
    const restartZoom = zoom.restart;
    useEffect(() => {
        restartZoom();
        rescaleRef.current?.();
    }, [viewportKey, restartZoom]);

    /** 視窗座標 → 整張畫面的座標（框選用）。/ Client coordinates → framebuffer coordinates. */
    const toFramebuffer = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const el = displayElRef.current;
        const c = clientRef.current;
        if (!el || !c) return null;
        const rect = el.getBoundingClientRect();
        const s = c.getDisplay().getScale() || 1;
        return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
    };
    const framebufferSize = (): Framebuffer | null => {
        const c = clientRef.current;
        if (!c) return null;
        const d = c.getDisplay();
        return d.getWidth() && d.getHeight() ? { width: d.getWidth(), height: d.getHeight() } : null;
    };

    useImperativeHandle(ref, () => ({
        disconnect: () => clientRef.current?.disconnect(),
        sendCtrlAltDel: () => {
            const c = clientRef.current;
            if (!c) return;
            for (const k of [KEY_CTRL_L, KEY_ALT, KEY_DELETE]) c.sendKeyEvent(1, k);
            for (const k of [KEY_DELETE, KEY_ALT, KEY_CTRL_L]) c.sendKeyEvent(0, k);
        },
        sendClipboard: (text: string) => {
            const c = clientRef.current;
            const G = guacRef.current;
            if (!c || !G) return;
            const writer = new G.StringWriter(c.createClipboardStream("text/plain"));
            writer.sendText(text);
            writer.sendEnd();
        },
        typeText: (text: string) => {
            const c = clientRef.current;
            if (!c) return;
            if (typingRef.current) clearTimeout(typingRef.current);
            const keys = Array.from(text).map((ch) => keysymForCodePoint(ch.codePointAt(0) ?? 0)).filter((k): k is number => k !== null);
            let i = 0;
            const step = () => {
                if (i >= keys.length || clientRef.current !== c) {
                    typingRef.current = null;
                    return;
                }
                c.sendKeyEvent(1, keys[i]);
                c.sendKeyEvent(0, keys[i]);
                i += 1;
                typingRef.current = setTimeout(step, TYPE_INTERVAL_MS);
            };
            step();
        },
        focus: () => sinkRef.current?.focus(),
        resumeSound: () => soundRef.current.resume(),
        zoom: { zoomIn: () => zoomCmds.current.zoomIn(), zoomOut: () => zoomCmds.current.zoomOut(), setMode: (m) => zoomCmds.current.setMode(m), setPercent: (p) => zoomCmds.current.setPercent(p) },
        isBlack: (x: number, y: number) => {
            const c = clientRef.current;
            if (!c) return false;
            try {
                const canvas = c.getDisplay().getDefaultLayer().getCanvas();
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) return false;
                const px = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, x)), Math.max(0, Math.min(canvas.height - 1, y)), 1, 1).data;
                return px[0] < 12 && px[1] < 12 && px[2] < 12;
            } catch {
                return false;
            }
        },
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
            displayElRef.current = el;

            // 裁切 + 縮放：host 是裁切框（viewport 的大小 × 比例，放大後最多到框的大小），畫面元素往左上挪
            // viewport 的位移再加平移量。比例由縮放模式決定（1:1 = 一個遠端像素一個 CSS px，HiDPI 時一個裝置像素）。
            // 框選時一律整張塞進框裡。
            // Crop and zoom: the host is the clip box, the display element shifted by the viewport's origin plus the pan.
            const rescale = () => {
                const w = display.getWidth();
                const h = display.getHeight();
                if (!w || !h) return;
                const selecting = options.current.selecting;
                const vpRaw = selecting ? null : options.current.viewport;
                const vp: Viewport = vpRaw && vpRaw.x < w && vpRaw.y < h ? { x: vpRaw.x, y: vpRaw.y, width: Math.min(vpRaw.width, w - vpRaw.x), height: Math.min(vpRaw.height, h - vpRaw.y) } : { x: 0, y: 0, width: w, height: h };
                const box = frame.getBoundingClientRect();
                const unit = 1 / Math.max(1, options.current.pixelRatio);
                const l = selecting ? zoomLayout(box, vp, { fit: fitScale(box, vp), unit }, FIT) : zoomLayoutRef.current(box, vp, unit);
                display.scale(l.scale);
                host.style.width = `${l.hostWidth}px`;
                host.style.height = `${l.hostHeight}px`;
                el.style.marginLeft = `${-(vp.x * l.scale + l.ox)}px`;
                el.style.marginTop = `${-(vp.y * l.scale + l.oy)}px`;
                callbacks.current.onScale(l.scale);
            };
            rescaleRef.current = rescale;
            display.onresize = (w, h) => {
                rescale();
                callbacks.current.onDisplaySize({ width: w, height: h });
            };
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

            // 鍵盤：InputSink 的 textarea 收焦點（IME 才會組字），Keyboard 掛在框上（事件從 textarea 冒上來）。
            // Keyboard: the InputSink textarea holds focus (so IMEs compose); the Keyboard listens on the frame.
            const sink = new G.InputSink();
            const sinkEl = sink.getElement();
            sinkEl.setAttribute("aria-hidden", "true");
            sinkEl.setAttribute("tabindex", "-1");
            frame.appendChild(sinkEl);
            sinkRef.current = sink;
            const onSinkFocus = () => setFocused(true);
            const onSinkBlur = () => setFocused(false);
            sinkEl.addEventListener("focus", onSinkFocus);
            sinkEl.addEventListener("blur", onSinkBlur);
            const keyboard = new G.Keyboard(frame);
            keyboardRef.current = keyboard;
            // 按下時記住實際送出的 keysym，放開時用同一個（中途切換 Ctrl→⌘ 不會卡住修飾鍵）。
            // Remember what was sent on press so the release matches even if the remap toggles in between.
            const sent = new Map<number, number>();
            keyboard.onkeydown = (keysym) => {
                // 框選中：按鍵留給框選層（Esc 取消），不送往遠端。/ While selecting, keys stay local (Esc cancels).
                if (options.current.selecting) return true;
                const k = options.current.ctrlAsCmd ? ctrlToCmd(keysym) : keysym;
                sent.set(keysym, k);
                client.sendKeyEvent(1, k);
                return false;
            };
            keyboard.onkeyup = (keysym) => {
                const k = sent.get(keysym);
                if (k === undefined) return;
                sent.delete(keysym);
                client.sendKeyEvent(0, k);
            };

            client.onstatechange = (state) => {
                if (state === 3) {
                    rescale();
                    callbacks.current.onDisplaySize({ width: display.getWidth(), height: display.getHeight() });
                    callbacks.current.onConnected();
                    sink.focus();
                } else if (state === 5) {
                    end(null);
                }
            };
            client.onerror = (status) => end(sessionFailure(status.code, status.message));
            tunnel.onerror = (status) => end(sessionFailure(status.code, status.message));
            tunnel.onstatechange = (state) => callbacks.current.onTunnelUnstable(state === G.Tunnel.State.UNSTABLE);
            // VNC 伺服器要我們沒給的欄位（例如密碼）：不在串流裡補，直接請使用者重新連。
            // The server wants a parameter we did not send: disconnect and ask the user to fill it in.
            client.onrequired = (params) => {
                end({ key: "desktop.err.required", vars: { fields: params.join(", ") }, at: "target" });
                client.disconnect();
            };
            // 遠端的聲音：播放器用頁面在點擊裡建好的共用 AudioContext（沒有才讓它自己建）；靜音時 blob 直接丟掉；
            // 每塊量峰值給「在播 / 安靜 / 被擋」的判斷。
            // The remote's sound: the player uses the click-unlocked shared context; blobs are dropped while muted;
            // each blob's peak feeds the playing / quiet / blocked decision.
            const factory = (G as unknown as { AudioContextFactory?: { singleton: AudioContext | null; getAudioContext?: () => AudioContext | null } }).AudioContextFactory;
            const tap = soundRef.current;
            tap.reset();
            if (start.audio && factory && (!factory.singleton || factory.singleton.state === "closed")) factory.singleton = sharedAudio();
            client.onaudio = (stream, mimetype) => {
                const player = G.AudioPlayer.getInstance(stream, mimetype);
                if (!player) return null;
                tap.open();
                tap.context = factory?.singleton ?? null;
                const bytes = rawBytesPerSample(mimetype) ?? 2;
                const play = stream.onblob;
                stream.onblob = (data: string) => {
                    tap.data(pcmPeak(data, bytes));
                    if (!options.current.muted) play?.call(stream, data);
                };
                return player;
            };
            let lastSnapshot: SoundSnapshot = EMPTY_SNAPSHOT;
            const audioTimer = start.audio ? setInterval(() => {
                const snap = tap.snapshot();
                if (!sameSnapshot(snap, lastSnapshot)) {
                    lastSnapshot = snap;
                    callbacks.current.onSound?.(snap);
                }
            }, 500) : null;
            // 自動播放限制：在框上點擊 / 按鍵也讓 context 動起來。/ Autoplay: a click or key on the frame resumes the context too.
            const resumeAudio = () => {
                if (start.audio) tap.resume();
            };
            frame.addEventListener("pointerdown", resumeAudio, true);
            frame.addEventListener("keydown", resumeAudio, true);
            client.onclipboard = (stream, mimetype) => {
                if (!/^text\//.test(mimetype)) return;
                const reader = new G.StringReader(stream);
                let data = "";
                reader.ontext = (text) => { data += text; };
                reader.onend = () => callbacks.current.onRemoteClipboard(data);
            };

            // 跟著框走的 session（RDP 預設；VNC 要另外開）：框大小改變就送 `size`（停 400 ms 再送，拖視窗時不會一直重設）。
            // 固定解析度的 session 只縮放。/ A following session sends `size` 400 ms after the frame settles; a fixed one only scales.
            let resizeTimer: ReturnType<typeof setTimeout> | null = null;
            const requested = () => {
                const box = frame.getBoundingClientRect();
                return requestedSize(options.current.display, start.protocol, { width: box.width, height: box.height }, options.current.pixelRatio, start.max_resolution ?? null);
            };
            let lastSent = "";
            const sendSize = () => {
                if (!start.resize) return;
                const box = frame.getBoundingClientRect();
                if (box.width <= 0 || box.height <= 0) return;
                const r = requested();
                const key = `${r.width}x${r.height}`;
                if (key === lastSent) return;
                lastSent = key;
                client.sendSize(r.width, r.height);
            };
            sendSizeRef.current = sendSize;
            const observer = new ResizeObserver(() => {
                rescale();
                if (!start.resize) return;
                if (resizeTimer) clearTimeout(resizeTimer);
                resizeTimer = setTimeout(sendSize, 400);
            });
            observer.observe(frame);

            const size = requested();
            lastSent = `${size.width}x${size.height}`;
            client.connect(new URLSearchParams({ ticket: start.ticket, width: String(size.width), height: String(size.height), dpi: String(size.dpi) }).toString());
            // 中繼自己的指令在交給 Client 前攔下：ping 立刻回 pong，stats 往上報。其餘原樣交給 Client。
            // Intercept the relay's own instructions before the Client sees them; everything else passes through.
            const inner = tunnel.oninstruction;
            tunnel.oninstruction = (opcode, args) => {
                if (opcode === PING_OPCODE) {
                    tunnel.sendMessage(PONG_OPCODE, String(args[0] ?? ""));
                    return;
                }
                if (opcode === STATS_OPCODE) {
                    const s = parseStats(String(args[0] ?? ""));
                    if (s) callbacks.current.onStats(s);
                    return;
                }
                inner?.(opcode, args);
            };

            cleanup = () => {
                observer.disconnect();
                if (audioTimer) clearInterval(audioTimer);
                frame.removeEventListener("pointerdown", resumeAudio, true);
                frame.removeEventListener("keydown", resumeAudio, true);
                client.onaudio = null;
                if (resizeTimer) clearTimeout(resizeTimer);
                if (typingRef.current) clearTimeout(typingRef.current);
                typingRef.current = null;
                keyboard.onkeydown = null;
                keyboard.onkeyup = null;
                keyboard.reset();
                sinkEl.removeEventListener("focus", onSinkFocus);
                sinkEl.removeEventListener("blur", onSinkBlur);
                sinkEl.remove();
                client.onstatechange = null;
                client.onerror = null;
                tunnel.onerror = null;
                tunnel.onstatechange = null;
                client.disconnect();
                el.remove();
                rescaleRef.current = null;
                sendSizeRef.current = null;
                sinkRef.current = null;
                keyboardRef.current = null;
                displayElRef.current = null;
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
            onMouseDown={() => sinkRef.current?.focus()}
            onFocus={(e) => { if (e.target === frameRef.current) sinkRef.current?.focus(); }}
            className="relative flex h-full w-full touch-none items-center justify-center overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={t("desktop.viewerLabel")}
        >
            <div ref={hostRef} className="relative shrink-0 overflow-hidden" />
            {zoom.touch && !selecting && <ZoomControl zoom={zoom} />}
            {selecting && <AreaSelector toFramebuffer={toFramebuffer} framebuffer={framebufferSize} onDone={(area) => callbacks.current.onAreaSelected(area)} />}
            {!focused && !selecting && (
                <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs text-foreground shadow-pop">
                    <MousePointerClick size={14} aria-hidden /> {t("desktop.clickToType")}
                </div>
            )}
        </div>
    );
});

/**
 * 框選層：蓋在整張畫面上，拖出一個矩形 → 畫面座標的區域；太小（像點一下）不算，Esc 或「取消」放棄。
 * 指標事件都被這層吃掉，遠端不會收到滑鼠。/ The drag-to-select layer over the whole desktop.
 */
function AreaSelector({ toFramebuffer, framebuffer, onDone }: {
    toFramebuffer: (clientX: number, clientY: number) => { x: number; y: number } | null;
    framebuffer: () => Framebuffer | null;
    onDone: (area: Viewport | null) => void;
}) {
    const { t } = useI18n();
    const layerRef = useRef<HTMLDivElement | null>(null);
    const startRef = useRef<{ x: number; y: number } | null>(null);
    const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    const doneRef = useRef(onDone);
    useLayoutEffect(() => {
        doneRef.current = onDone;
    });

    // Esc 在整個視窗都算（打開選單那顆按鈕會把焦點搶回去，不能只靠這一層的焦點）。
    // Esc anywhere in the window: the menu button takes focus back after the menu closes.
    useEffect(() => {
        layerRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            doneRef.current(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, []);

    const clientBox = (ax: number, ay: number, bx: number, by: number) => {
        const r = layerRef.current?.getBoundingClientRect();
        if (!r) return null;
        return { left: Math.min(ax, bx) - r.left, top: Math.min(ay, by) - r.top, width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    };
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        startRef.current = { x: e.clientX, y: e.clientY };
        setBox(clientBox(e.clientX, e.clientY, e.clientX, e.clientY));
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const s = startRef.current;
        if (!s) return;
        setBox(clientBox(s.x, s.y, e.clientX, e.clientY));
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        const s = startRef.current;
        startRef.current = null;
        setBox(null);
        if (!s) return;
        const fb = framebuffer();
        const a = toFramebuffer(s.x, s.y);
        const b = toFramebuffer(e.clientX, e.clientY);
        if (!fb || !a || !b) return;
        const area = rectFromPoints(a, b, fb);
        // 太小 = 點了一下：留在框選模式，再拖一次。/ A click, not a drag: stay in selection mode.
        if (area) onDone(area);
    };

    return (
        <div
            ref={layerRef}
            tabIndex={0}
            role="application"
            aria-label={t("desktop.screen.selectHint")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { startRef.current = null; setBox(null); }}
            className="absolute inset-0 z-10 cursor-crosshair touch-none select-none outline-none"
        >
            {box && (
                <div
                    className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                    style={{ left: box.left, top: box.top, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
                />
            )}
            <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-md bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-pop">
                <span>{t("desktop.screen.selectHint")}</span>
                <Button size="xs" variant="outline" className="pointer-events-auto" onClick={() => onDone(null)}>{t("common.cancel")}</Button>
            </div>
        </div>
    );
}
