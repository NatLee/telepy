"use client";

/**
 * WebSocket 連線與通知 hooks。/ WebSocket connection & notification hooks.
 * - 認證：一次性 ticket（見 reconnectingSocket.ts / common/ws_ticket.py）；JWT 不進 WS。
 *   Auth: one-time ticket; the JWT never enters the WebSocket.
 * - 連線生命週期（ticket 取得、退避重連、心跳）統一由 ReconnectingSocket 處理。
 *   Connection lifecycle (ticket fetch, backoff reconnect, heartbeat) is handled by ReconnectingSocket.
 * - 通知 socket 為模組層單例：整頁所有 useNotificationWebSocket/useNotificationHandlers 共用一條連線。
 *   The notification socket is a module-level singleton shared by all callers on the page.
 */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { NotificationPayload } from "./notificationActions";
import { ReconnectingSocket } from "./reconnectingSocket";

// 為相容既有 import（如 useTerminalPage 由此取 getWsOrigin），自 wsCommon 再匯出。
// Re-export from wsCommon for existing imports (e.g. useTerminalPage imports getWsOrigin from here).
export { getWsOrigin, backoffDelay, STABLE_CONNECTION_MS, NON_RETRYABLE_CLOSE_CODES } from "./wsCommon";

// ────────────────────────────────────────────────────────────────────────────
// 通知 socket 單例 / Notification socket singleton
// ────────────────────────────────────────────────────────────────────────────

type NotificationListener = {
    onMessage: (msg: unknown) => void;
    onStatus: (connected: boolean) => void;
};

class NotificationHub {
    private socket: ReconnectingSocket | null = null;
    private listeners = new Set<NotificationListener>();
    private connected = false;
    private teardownTimer: ReturnType<typeof setTimeout> | null = null;

    subscribe(listener: NotificationListener): () => void {
        // 取消待處理的關閉，讓 StrictMode/換頁的瞬間 remount 重用同一條連線。
        if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }

        this.listeners.add(listener);
        listener.onStatus(this.connected);

        if (!this.socket) {
            this.socket = new ReconnectingSocket({
                path: "/ws/notifications/",
                heartbeat: true,
                onStatus: (c) => {
                    this.connected = c;
                    this.listeners.forEach((l) => l.onStatus(c));
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

    private unsubscribe(listener: NotificationListener) {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
            // 延遲關閉，避免 StrictMode/換頁瞬間 unmount→remount 把連線關掉又重開。
            if (this.teardownTimer) clearTimeout(this.teardownTimer);
            this.teardownTimer = setTimeout(() => {
                this.socket?.close();
                this.socket = null;
                this.connected = false;
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
    const [lastMessage, setLastMessage] = useState<unknown>(null);

    useEffect(() => {
        if (!accessToken) return; // 未登入不連 / don't connect when logged out
        const listener: NotificationListener = {
            onMessage: setLastMessage,
            onStatus: setIsConnected,
        };
        return notificationHub.subscribe(listener);
    }, [accessToken]);

    return { isConnected, lastMessage };
}

/**
 * Hook to abstract WebSocket notification dispatching based on action.
 * Maps incoming WS actions to provided handler functions.
 */
export function useNotificationHandlers(
    handlers: Partial<Record<string, (msg: NotificationPayload) => void>>
) {
    const { isConnected, lastMessage } = useNotificationWebSocket();

    // Store handlers in a ref so we don't trigger the effect on every re-render
    const handlersRef = useRef(handlers);
    useEffect(() => {
        handlersRef.current = handlers;
    }, [handlers]);

    useEffect(() => {
        const lm = lastMessage as { message?: NotificationPayload } | null;
        if (!lm?.message) return;
        const msg = lm.message as NotificationPayload;
        const action = msg.action as string;

        if (action && handlersRef.current[action]) {
            handlersRef.current[action]!(msg);
        }
    }, [lastMessage]);

    return { isConnected };
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
            protocols: () => [`tunnel.${tunnelId}`],
            heartbeat: true,
            onMessage: (data) => {
                try { setStatus(JSON.parse(data)); } catch { /* ignore parse errors */ }
            },
        });
        socket.start();
        return () => socket.close();
    }, [accessToken, tunnelId]);

    return { status };
}
