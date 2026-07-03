import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { MonitorPlay, MonitorX, AlertCircle, Loader2, Languages } from "lucide-react";
import { readJson, responseError } from "@/lib/api";
import { getWsOrigin } from "@/lib/wsCommon";
import KasmUI from "@/vendor/kasm-novnc/app/ui.js";

export interface RemoteBrowserPanelProps {
    serverId: string;
    username: string;
    accessToken: string | null;
    onActiveChange?: (isActive: boolean) => void;
}

const CLOSE_MESSAGES: Record<number, string> = {
    4403: "Permission denied for this tunnel",
    4404: "Session not found or expired",
    4011: "Could not reach the VNC browser backend",
    4013: "VNC connection closed",
};

/** 我們用到的 KasmVNC RFB 介面(vendored fork 是 untyped JS,見 vendor/kasm-novnc/README.md)。 */
type KasmRFB = {
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    clipboardUp: boolean;
    clipboardDown: boolean;
    clipboardSeamless: boolean;
    enableWebP: boolean;
    enableWebRTC: boolean;
    translateShortcuts: boolean;
    mouseButtonMapper: unknown;
    readonly keyboard: { enableIME: boolean } & Record<string, unknown>;
    focus(): void;
    disconnect(): void;
    addEventListener(type: string, listener: (e: Event) => void): void;
};
type KasmRFBConstructor = new (
    target: HTMLElement,
    touchInput: HTMLTextAreaElement,   // 比 stock noVNC 多的參數:IME/行動鍵盤輸入用的隱形 textarea
    urlOrChannel: string | WebSocket,
    options?: { shared?: boolean },
) => KasmRFB;

// 動態載入 vendored client:它的 util/browser.js 在 import 當下就碰 document/window,
// 靜態 import 會炸 SSR prerender;順便把 ~700KB 的 client 從頁面 bundle 拆出去。
// mousebuttonmapper 與 rfb 同一個 import graph(rfb 自己也 import 它),同 chunk。
let clientModulesPromise: Promise<[
    { default: unknown },
    { MouseButtonMapper: new () => { set(btn: number, xvnc: number): void }; XVNC_BUTTONS: Record<string, number> },
]> | null = null;
const loadClient = () => {
    if (!clientModulesPromise) {
        clientModulesPromise = Promise.all([
            import("@/vendor/kasm-novnc/core/rfb.js"),
            import("@/vendor/kasm-novnc/core/mousebuttonmapper.js"),
        ]) as NonNullable<typeof clientModulesPromise>;
    }
    return clientModulesPromise;
};

/**
 * Remote Browser (KasmVNC over the existing /ws).
 *
 * 握手:開 WS → 先送 {type:"auth",token}(沿用 FirstMessageAuthConsumer 慣例)→ 後端連上
 * KasmVNC 的 websocket、回 {type:"ready"} → 前端把「同一條已認證的 WS」交給 **KasmVNC 自家
 * noVNC fork** 的 RFB(stock noVNC 連 KasmVNC 是黑畫面,協定已分岔)→ 前端回 {type:"begin"},
 * 後端才開始 pump。之後畫面/輸入/剪貼簿/IME 全由 KasmVNC client ↔ server 端到端處理。
 */
export function RemoteBrowserPanel({
    serverId,
    username,
    accessToken,
    onActiveChange,
}: RemoteBrowserPanelProps) {
    const [phase, setPhase] = useState<"idle" | "connecting" | "connected">("idle");
    const [error, setError] = useState<string | null>(null);
    const [imeEnabled, setImeEnabled] = useState(true);   // 中文輸入預設開啟
    const imeEnabledRef = useRef(true);

    const screenRef = useRef<HTMLDivElement | null>(null);
    const keyboardInputRef = useRef<HTMLTextAreaElement | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const rfbRef = useRef<KasmRFB | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const cleaningRef = useRef(false);
    const connectedRef = useRef(false);
    const userStoppedRef = useRef(false);

    const postStop = useCallback((sid: string) => {
        const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
        return fetch(`${apiBase}/api/reverse/server/remote-browser/${sid}/stop`, {
            method: "POST",
            headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
            keepalive: true,
        }).catch(() => { });
    }, [accessToken]);

    // 統一收尾:冪等。RFB 的 disconnect 事件、ws close、使用者 Stop 都走這裡。
    const cleanup = useCallback((notifyBackend: boolean) => {
        if (cleaningRef.current) return;
        cleaningRef.current = true;
        const sid = sessionIdRef.current;
        connectedRef.current = false;
        try { rfbRef.current?.disconnect(); } catch { /* noop */ }
        rfbRef.current = null;
        KasmUI.rfb = null;
        try { wsRef.current?.close(); } catch { /* noop */ }
        wsRef.current = null;
        if (notifyBackend && sid) postStop(sid);
        sessionIdRef.current = null;
        setPhase("idle");
        onActiveChange?.(false);
        cleaningRef.current = false;
    }, [postStop, onActiveChange]);

    const attachKasmClient = useCallback(async (ws: WebSocket) => {
        const screen = screenRef.current;
        const keyboardInput = keyboardInputRef.current;
        if (!screen || !keyboardInput) return;
        let RFB: KasmRFBConstructor;
        let mapperMod: Awaited<ReturnType<typeof loadClient>>[1];
        try {
            const [rfbMod, mbm] = await loadClient();
            RFB = rfbMod.default as KasmRFBConstructor;
            mapperMod = mbm;
        } catch {
            setError("Failed to load the VNC client bundle");
            cleanup(true);
            return;
        }
        // chunk 載入是 async:期間 WS 可能已關、或使用者已 Stop/重啟
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;

        const rfb = new RFB(screen, keyboardInput, ws, { shared: true });   // 已開啟+已認證的 WS
        rfb.scaleViewport = true;       // 遠端畫面等比縮放填入面板
        rfb.resizeSession = true;       // KasmVNC 會把遠端桌面調成面板大小
        rfb.background = "#000";
        rfb.enableWebRTC = false;       // UDP/WebRTC 過不了我們的 WS 中繼,關掉免得它反覆嘗試
        rfb.enableWebP = true;          // 對齊 kasm 自家 standalone 預設
        rfb.clipboardUp = true;         // 剪貼簿:本機 → 遠端
        rfb.clipboardDown = true;       // 剪貼簿:遠端 → 本機
        // seamless 剪貼簿走 navigator.clipboard;Safari 已知會壞(KASM-960),照上游 UI 排除
        rfb.clipboardSeamless = !(/^((?!chrome|android).)*safari/i.test(navigator.userAgent));
        rfb.translateShortcuts = true;  // macOS:Cmd+C/V 轉 Ctrl+C/V 給遠端
        // 滑鼠按鍵對映:rfb.js 預設 mouseButtonMapper=null,且 _handleMouse 對「每一個」滑鼠事件
        // 都先 .get(ev.button) —— 不設定的話所有滑鼠事件都 TypeError,滑鼠整個不能用。
        // 對映值照上游 app/ui.js initMouseButtonMapper 的預設。
        const { MouseButtonMapper, XVNC_BUTTONS } = mapperMod;
        const mapper = new MouseButtonMapper();
        mapper.set(0, XVNC_BUTTONS.LEFT_BUTTON);
        mapper.set(1, XVNC_BUTTONS.MIDDLE_BUTTON);
        mapper.set(2, XVNC_BUTTONS.RIGHT_BUTTON);
        mapper.set(3, XVNC_BUTTONS.BACK_BUTTON);
        mapper.set(4, XVNC_BUTTONS.FORWARD_BUTTON);
        rfb.mouseButtonMapper = mapper;
        // IME(預設開,可用面板按鈕切換)。setter 會順便 focus 到隱形 textarea。
        rfb.keyboard.enableIME = imeEnabledRef.current;
        // 修復 IME 重複輸出:keyboard.js 用「textarea 值 vs _lastKeyboardInput」差分決定送什麼;
        // compositionend 與最後一個 input 事件的先後順序因瀏覽器/輸入法而異,基準一旦沒跟上,
        // 下一次組字就會把整段舊值重送(測試 → 測試測試 → …)。每次組字結束後把值與基準
        // 一起歸零(deferred,讓同一輪殘餘的 input 事件先跑完;組字中則跳過,別打斷使用者)。
        keyboardInput.addEventListener("compositionend", () => {
            setTimeout(() => {
                const kb = rfb.keyboard as unknown as {
                    _imeInProgress?: boolean; _keyboardInputReset?: () => void;
                };
                if (!kb._imeInProgress) kb._keyboardInputReset?.();
            }, 0);
        });
        rfb.addEventListener("connect", () => {
            connectedRef.current = true;
            setPhase("connected");
            onActiveChange?.(true);
            try { rfb.focus(); } catch { /* noop */ }
        });
        rfb.addEventListener("disconnect", () => cleanup(true));
        rfbRef.current = rfb;
        KasmUI.rfb = rfb;   // keyboard.js 經 app/ui.js shim 讀 translateShortcuts(見 vendor README)
        // RFB 建構子把「attach 到 socket」排在下一個 tick(setTimeout 0)。把 begin 排進同一個
        // timer 佇列(必在其後執行),確保後端開始 pump 時 onmessage 已被 RFB 接管,不漏訊息。
        setTimeout(() => {
            if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "begin" }));
            }
        }, 0);
    }, [cleanup, onActiveChange]);

    const startSession = useCallback(async () => {
        setError(null);
        setPhase("connecting");
        cleaningRef.current = false;
        userStoppedRef.current = false;
        connectedRef.current = false;
        loadClient().catch(() => { });   // 預熱 client chunk,與 start API 並行
        try {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            const res = await fetch(
                `${apiBase}/api/reverse/server/${serverId}/remote-browser/start`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                    },
                    body: JSON.stringify({ username }),
                },
            );
            if (!res.ok) {
                const data = await readJson(res);
                throw new Error(responseError(res, data, "Failed to start remote browser"));
            }
            const data = await res.json();
            sessionIdRef.current = data.session_id;

            const ws = new WebSocket(`${getWsOrigin()}${data.ws_path}`);
            ws.binaryType = "arraybuffer";
            wsRef.current = ws;

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: "auth",
                    token: typeof window !== "undefined"
                        ? localStorage.getItem("accessToken") : accessToken,
                }));
            };
            // setup 階段:等後端 {type:"ready"} 再把 socket 交給 KasmVNC client。
            ws.onmessage = (ev) => {
                if (typeof ev.data !== "string") return;
                let msg: any;
                try { msg = JSON.parse(ev.data); } catch { return; }
                if (msg.type === "ready") {
                    ws.onmessage = null;      // 交棒給 KasmVNC client
                    void attachKasmClient(ws);
                }
            };
            ws.onerror = () => {
                if (!connectedRef.current) setError((e) => e || "WebSocket error");
            };
            ws.onclose = (ev) => {
                const wasConnected = connectedRef.current;
                if (!userStoppedRef.current && !wasConnected) {
                    setError((e) => e || CLOSE_MESSAGES[ev.code] || "Connection closed");
                }
                cleanup(false);
            };
        } catch (err: any) {
            setError(err.message || "An unknown error occurred");
            cleanup(true);
        }
    }, [serverId, username, accessToken, attachKasmClient, cleanup]);

    const stopSession = useCallback(() => {
        userStoppedRef.current = true;
        cleanup(true);
    }, [cleanup]);

    // IME(中文/日文輸入法)模式:composition 事件經隱形 textarea 差分送往遠端。預設開啟。
    // 切換時把焦點交回 RFB(IME 開 → focus 到 textarea;關 → focus 到 canvas)。
    const toggleIme = useCallback(() => {
        setImeEnabled((prev) => {
            const next = !prev;
            imeEnabledRef.current = next;
            const rfb = rfbRef.current;
            if (rfb) {
                rfb.keyboard.enableIME = next;
                try { rfb.focus(); } catch { /* noop */ }
            }
            return next;
        });
    }, []);

    // 心跳:讓後端 GC 能回收斷線的 session
    useEffect(() => {
        if (phase !== "connected") return;
        const id = setInterval(() => {
            const sid = sessionIdRef.current;
            if (!sid) return;
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            fetch(`${apiBase}/api/reverse/server/remote-browser/${sid}/ping`, {
                method: "POST",
                headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
            }).catch(() => { });
        }, 15000);
        return () => clearInterval(id);
    }, [phase, accessToken]);

    // 卸載 / 關閉分頁時收掉 session
    useEffect(() => {
        const onUnload = () => { const sid = sessionIdRef.current; if (sid) postStop(sid); };
        window.addEventListener("beforeunload", onUnload);
        return () => {
            window.removeEventListener("beforeunload", onUnload);
            cleanup(true);
        };
    }, [postStop, cleanup]);

    const active = phase === "connected";
    const busy = phase !== "idle";

    return (
        <div className="flex flex-col h-full w-full bg-card overflow-hidden relative shadow-xl">
            {/* Header */}
            <div className="flex items-center gap-2 p-2 px-3 border-b border-border bg-muted/40">
                <MonitorPlay size={18} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm font-semibold tracking-tight text-foreground">
                    Proxy Browser (VNC)
                </span>
                {active && (
                    <Button
                        variant={imeEnabled ? "default" : "outline"}
                        size="sm"
                        onClick={toggleIme}
                        className="h-8 gap-1"
                        title="Toggle IME mode for CJK input (中文輸入)"
                    >
                        <Languages size={14} /> IME
                    </Button>
                )}
                {busy ? (
                    <Button variant="destructive" size="sm" onClick={stopSession} className="h-8 gap-1">
                        <MonitorX size={14} /> Stop Session
                    </Button>
                ) : (
                    <Button variant="default" size="sm" onClick={startSession} className="h-8 gap-1">
                        <MonitorPlay size={14} /> Start Browser
                    </Button>
                )}
            </div>

            {error && (
                <div className="p-3 m-3 bg-red-500/10 border border-red-500/20 text-red-500 text-sm rounded-md flex items-start gap-2">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {/* Idle info */}
            {phase === "idle" && !error && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4 text-center">
                    <MonitorPlay size={48} className="mb-4 opacity-20" />
                    <h3 className="text-lg font-medium mb-2 text-foreground">Proxy Browser via SSH</h3>
                    <p className="text-sm max-w-sm mb-4">
                        Starts a real Chromium desktop streamed over VNC. Traffic is tunneled
                        through the target server ({username}@reverse), masquerading external
                        requests as the target machine.
                    </p>
                    <Button onClick={startSession}>Click to Initialize</Button>
                </div>
            )}

            {/* VNC viewport area — mounted while connecting/connected so the client has a sized div.
                Loading spinner overlays it until the RFB 'connect' event fires. */}
            {busy && (
                <div className="flex-1 min-h-0 relative bg-black">
                    <div ref={screenRef} className="absolute inset-0">
                        {/* IME/行動鍵盤輸入用的隱形 textarea(對齊 kasm vnc.html 的 #noVNC_keyboardinput):
                            要可聚焦(不能 display:none),擺在畫面中段讓 IME 候選窗出現在內容附近。 */}
                        <textarea
                            ref={keyboardInputRef}
                            autoCapitalize="off"
                            autoComplete="off"
                            spellCheck={false}
                            tabIndex={-1}
                            className="absolute w-0 h-0 p-0 border-0 resize-none overflow-hidden bg-transparent text-transparent caret-transparent outline-none"
                            style={{ left: "35%", top: "40%" }}
                        />
                    </div>
                    {!active && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground bg-black/80">
                            <Loader2 size={48} className="mb-4 animate-spin text-primary" />
                            <p className="text-sm">Starting browser and binding SSH proxy...</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
