import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { MonitorPlay, MonitorX, AlertCircle, Loader2 } from "lucide-react";
import { readJson, responseError } from "@/lib/api";
import { getWsOrigin } from "@/lib/wsCommon";
import RFB from "@novnc/novnc/lib/rfb";

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

/**
 * Remote Browser (KasmVNC over the existing /ws).
 *
 * 握手:開 WS → 先送 {type:"auth",token}(沿用 FirstMessageAuthConsumer 慣例)→ 後端連上
 * RFB、回 {type:"ready"} → 前端把「同一條已認證的 WS」交給 noVNC 的 RFB(它同步接管 onmessage
 * 並呼叫 _socketOpen)→ 前端回 {type:"begin"},後端才開始把 RFB 位元組 pump 過來。之後畫面/輸入
 * 全由 noVNC ↔ KasmVNC 端到端處理(真桌面:瀏覽器自身分頁/網址列/中文輸入/剪貼簿全部免費)。
 */
export function RemoteBrowserPanel({
    serverId,
    username,
    accessToken,
    onActiveChange,
}: RemoteBrowserPanelProps) {
    const [phase, setPhase] = useState<"idle" | "connecting" | "connected">("idle");
    const [error, setError] = useState<string | null>(null);

    const screenRef = useRef<HTMLDivElement | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const rfbRef = useRef<RFB | null>(null);
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

    // 統一收尾:冪等。noVNC 的 disconnect 事件、ws close、使用者 Stop 都走這裡。
    const cleanup = useCallback((notifyBackend: boolean) => {
        if (cleaningRef.current) return;
        cleaningRef.current = true;
        const sid = sessionIdRef.current;
        connectedRef.current = false;
        try { rfbRef.current?.disconnect(); } catch { /* noop */ }
        rfbRef.current = null;
        try { wsRef.current?.close(); } catch { /* noop */ }
        wsRef.current = null;
        if (notifyBackend && sid) postStop(sid);
        sessionIdRef.current = null;
        setPhase("idle");
        onActiveChange?.(false);
        cleaningRef.current = false;
    }, [postStop, onActiveChange]);

    const attachNoVnc = useCallback((ws: WebSocket) => {
        const screen = screenRef.current;
        if (!screen) return;
        const rfb = new RFB(screen, ws, { shared: true });   // 已開啟+已認證的 WS
        rfb.scaleViewport = true;     // 遠端畫面等比縮放填入面板
        rfb.resizeSession = true;     // KasmVNC 支援時,請伺服器把桌面調成面板大小
        rfb.background = "#000";
        rfb.addEventListener("connect", () => {
            connectedRef.current = true;
            setPhase("connected");
            onActiveChange?.(true);
            try { rfb.focus(); } catch { /* noop */ }
        });
        rfb.addEventListener("disconnect", () => cleanup(true));
        rfbRef.current = rfb;
        ws.send(JSON.stringify({ type: "begin" }));   // 通知後端開始 pump RFB
    }, [cleanup, onActiveChange]);

    const startSession = useCallback(async () => {
        setError(null);
        setPhase("connecting");
        cleaningRef.current = false;
        userStoppedRef.current = false;
        connectedRef.current = false;
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
            // setup 階段:等後端 {type:"ready"} 再把 socket 交給 noVNC。
            ws.onmessage = (ev) => {
                if (typeof ev.data !== "string") return;
                let msg: any;
                try { msg = JSON.parse(ev.data); } catch { return; }
                if (msg.type === "ready") {
                    ws.onmessage = null;      // 交棒給 noVNC
                    attachNoVnc(ws);
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
    }, [serverId, username, accessToken, attachNoVnc, cleanup]);

    const stopSession = useCallback(() => {
        userStoppedRef.current = true;
        cleanup(true);
    }, [cleanup]);

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

            {/* VNC viewport area — mounted while connecting/connected so noVNC has a sized div.
                Loading spinner overlays it until the RFB 'connect' event fires. */}
            {busy && (
                <div className="flex-1 min-h-0 relative bg-black">
                    <div ref={screenRef} className="absolute inset-0" />
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
