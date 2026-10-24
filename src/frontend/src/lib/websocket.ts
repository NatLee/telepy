"use client";

/**
 * WebSocket 連線與通知 hooks。/ WebSocket connection & notification hooks.
 * - 認證：連上後第一則訊息帶 token（見 reconnectingSocket.ts）；JWT 只在 WS payload，不進 URL/header。
 *   Auth: token in the first WS message (see reconnectingSocket.ts); the JWT stays in the WS payload.
 * - 連線生命週期（送 auth、退避重連、心跳）統一由 ReconnectingSocket 處理。
 *   Connection lifecycle (auth send, backoff reconnect, heartbeat) is handled by ReconnectingSocket.
 * - 通知 socket 為模組層單例：整頁所有 useNotificationWebSocket/useNotificationHandlers 共用一條連線。
 *   The notification socket is a module-level singleton shared by all callers on the page.
 */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { NotificationPayload } from "./notificationActions";
import { ReconnectingSocket, type SocketPhase } from "./reconnectingSocket";

export type { SocketPhase } from "./reconnectingSocket";

// 為相容既有 import（如 useTerminalPage 由此取 getWsOrigin），自 wsCommon 再匯出。
// Re-export from wsCommon for existing imports (e.g. useTerminalPage imports getWsOrigin from here).
export { getWsOrigin, backoffDelay, STABLE_CONNECTION_MS, NON_RETRYABLE_CLOSE_CODES } from "./wsCommon";

// ────────────────────────────────────────────────────────────────────────────
// 通知 socket 單例 / Notification socket singleton
// ────────────────────────────────────────────────────────────────────────────

type NotificationListener = {
    onMessage: (msg: unknown) => void;
    onStatus: (connected: boolean) => void;
    onPhase: (phase: SocketPhase) => void;
};

class NotificationHub {
    private socket: ReconnectingSocket | null = null;
    private listeners = new Set<NotificationListener>();
    private connected = false;
    private phase: SocketPhase = { state: "connecting" };
    private teardownTimer: ReturnType<typeof setTimeout> | null = null;

    subscribe(listener: NotificationListener): () => void {
        // 取消待處理的關閉，讓 StrictMode/換頁的瞬間 remount 重用同一條連線。
        if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }

        this.listeners.add(listener);
        listener.onStatus(this.connected);
        listener.onPhase(this.phase);

        if (!this.socket) {
            this.socket = new ReconnectingSocket({
                path: "/ws/notifications/",
                heartbeat: true,
                onStatus: (c) => {
                    this.connected = c;
                    this.listeners.forEach((l) => l.onStatus(c));
                },
                onPhase: (p) => {
                    this.phase = p;
                    this.listeners.forEach((l) => l.onPhase(p));
                },
                onMessage: (data) => {
                    let parsed: unknown;
                    try { parsed = JSON.parse(data); } catch { parsed = data; }
                    this.listeners.forEach((l) => l.onMessage(parsed));
                },
            });
            this.socket.start();
        }

        return () => this.unsubscribe(listener);
    }

    /** 立即重連（略過退避等待）。/ Reconnect right away (skips the backoff wait). */
    reconnect() {
        this.socket?.reconnect();
    }

    private unsubscribe(listener: NotificationListener) {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
            // 延遲關閉，避免 StrictMode/換頁瞬間 unmount→remount 把連線關掉又重開。
            if (this.teardownTimer) clearTimeout(this.teardownTimer);
            this.teardownTimer = setTimeout(() => {
                this.socket?.close();
                this.socket = null;
                this.connected = false;
                this.phase = { state: "connecting" };
            }, 500);
        }
    }
}

const notificationHub = new NotificationHub();

/**
 * Hook for general notifications WebSocket.
 * Backend: NotificationConsumer at /ws/notifications/
 * 所有呼叫者共用同一條底層連線（單例）。/ All callers share one underlying connection (singleton).
 */
export function useNotificationWebSocket() {
    const { accessToken } = useAuth();
    const [isConnected, setIsConnected] = useState(false);
    const [phase, setPhase] = useState<SocketPhase>({ state: "connecting" });
    // 收到幾則訊息（給狀態燈「剛收到更新」的閃動用）。/ Messages received so far (drives the status dot's "update arrived" ping).
    const [messageCount, setMessageCount] = useState(0);

    useEffect(() => {
        if (!accessToken) return; // 未登入不連 / don't connect when logged out
        const listener: NotificationListener = {
            onMessage: () => setMessageCount((n) => n + 1),
            onStatus: setIsConnected,
            onPhase: setPhase,
        };
        return notificationHub.subscribe(listener);
    }, [accessToken]);

    return { isConnected, phase, messageCount, reconnect: reconnectNotifications };
}

function reconnectNotifications() {
    notificationHub.reconnect();
}

/**
 * 依 action 把通知分派給 handler。每則訊息都直接從 socket 交給 handler，不經過 React state：
 * 以前用一個 `lastMessage` state 轉手，兩則在同一次 render 前到達就只剩後一則（例如人數歸零的
 * UPDATE-TUNNEL-PRESENCE 被吃掉，列表一直顯示「使用中」）。
 * Dispatch notifications to handlers by action. Every message goes straight from the socket to its handler
 * instead of through a `lastMessage` state, which kept only the last of messages arriving before a render
 * (a lost "count: 0" presence update left a tunnel showing "in use").
 */
export function useNotificationHandlers(
    handlers: Partial<Record<string, (msg: NotificationPayload) => void>>
) {
    const { accessToken } = useAuth();

    // Store handlers in a ref so we don't resubscribe on every re-render
    const handlersRef = useRef(handlers);
    useEffect(() => {
        handlersRef.current = handlers;
    }, [handlers]);

    useEffect(() => {
        if (!accessToken) return;
        return notificationHub.subscribe({
            onMessage: (raw) => {
                const msg = (raw as { message?: NotificationPayload } | null)?.message;
                const action = msg?.action as string | undefined;
                if (msg && action) handlersRef.current[action]?.(msg);
            },
            onStatus: () => {},
            onPhase: () => {},
        });
    }, [accessToken]);
}

/**
 * Hook for tunnel connection status WebSocket.
 * Backend: TunnelConnectionConsumer at /ws/tunnel_connection/<id>/
 */
export function useTunnelConnectionWebSocket(tunnelId: string | null) {
    const { accessToken } = useAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [status, setStatus] = useState<any>(null);

    useEffect(() => {
        if (!accessToken || !tunnelId) return;
        const socket = new ReconnectingSocket({
            path: `/ws/tunnel_connection/${tunnelId}/`,
            authFields: () => ({ tunnel_id: tunnelId }),
            heartbeat: true,
            onMessage: (data) => {
                try {
                    const msg = JSON.parse(data);
                    // latency_update 只帶 rtt_ms（延遲監控每 ~5s 一次）：僅併入 rtt_ms，不可覆蓋 is_connected
                    // 等既有欄位（否則會誤把連線狀態清成 undefined，破壞建立精靈的 Step4 顯示）。
                    // connection_status 則以合併方式套用，保留先前欄位並帶入最新的 rtt_ms。
                    if (msg && msg.type === "latency_update") {
                        setStatus((prev: Record<string, unknown> | null) => ({ ...(prev ?? {}), rtt_ms: msg.rtt_ms }));
                    } else {
                        setStatus((prev: Record<string, unknown> | null) => ({ ...(prev ?? {}), ...msg }));
                    }
                } catch { /* ignore parse errors */ }
            },
        });
        socket.start();
        return () => socket.close();
    }, [accessToken, tunnelId]);

    return { status };
}
