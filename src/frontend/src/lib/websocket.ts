"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";

// Re-export getWsOrigin for use elsewhere (e.g. terminal page)
export function getWsOrigin(): string {
    if (typeof window === "undefined") {
        return "ws://localhost:8787";
    }
    // In dev, NEXT_PUBLIC_WS_HOST is set to e.g. "localhost:8787"
    // In prod, WS goes through Traefik on the same origin
    const wsHost = process.env.NEXT_PUBLIC_WS_HOST;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (wsHost) {
        return `${protocol}//${wsHost}`;
    }
    return `${protocol}//${window.location.host}`;
}

/**
 * Build the two auth subprotocols expected by Django Channels consumers:
 *   - token.<base64(jwt)>
 *   - auth.<sha256 ticket>
 */
async function buildAuthProtocols(accessToken: string, ticketContext: string): Promise<[string, string]> {
    const tokenProtocol = `token.${btoa(accessToken)}`;
    const jsSha256 = (await import("js-sha256")).sha256;
    const ticket = `auth.${jsSha256(`${ticketContext}.${Date.now()}`)}`;
    return [tokenProtocol, ticket];
}

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Hook for general notifications WebSocket.
 * Backend: NotificationConsumer at /ws/notifications/
 * Required subprotocols: token.<base64(jwt)>, auth.<ticket>
 */
export function useNotificationWebSocket() {
    const { accessToken } = useAuth();
    const [isConnected, setIsConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectAttemptRef = useRef(0);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        if (!accessToken) return;
        mountedRef.current = true;
        reconnectAttemptRef.current = 0;

        async function connect() {
            if (!accessToken || !mountedRef.current) return;

            try {
                const base = getWsOrigin();
                const url = `${base}/ws/notifications/`;
                const [tokenProtocol, authTicket] = await buildAuthProtocols(accessToken, "notification");

                const ws = new WebSocket(url, [tokenProtocol, authTicket]);
                wsRef.current = ws;

                ws.onopen = () => {
                    if (mountedRef.current) {
                        setIsConnected(true);
                        reconnectAttemptRef.current = 0;
                    }
                };

                ws.onmessage = (e) => {
                    try {
                        setLastMessage(JSON.parse(e.data));
                    } catch {
                        setLastMessage(e.data);
                    }
                };

                ws.onclose = () => {
                    wsRef.current = null;
                    if (mountedRef.current) {
                        setIsConnected(false);
                        if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
                            reconnectAttemptRef.current += 1;
                            timeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
                        }
                    }
                };

                ws.onerror = () => {
                    // onclose will fire after onerror and handle reconnect
                };
            } catch (e) {
                console.error("Notification WS connect error", e);
            }
        }

        connect();

        return () => {
            mountedRef.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.onclose = null; // prevent reconnect on explicit unmount
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [accessToken]);

    return { isConnected, lastMessage };
}

/**
 * Hook for tunnel connection status WebSocket.
 * Backend: TunnelConnectionConsumer at /ws/tunnel_connection/<id>/
 * Required subprotocols: token.<base64(jwt)>, tunnel.<id>, auth.<ticket>
 */
export function useTunnelConnectionWebSocket(tunnelId: string | null) {
    const { accessToken } = useAuth();
    const [status, setStatus] = useState<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectAttemptRef = useRef(0);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        if (!accessToken || !tunnelId) return;
        mountedRef.current = true;
        reconnectAttemptRef.current = 0;

        async function connect() {
            if (!accessToken || !tunnelId || !mountedRef.current) return;

            try {
                const base = getWsOrigin();
                const url = `${base}/ws/tunnel_connection/${tunnelId}/`;
                const [tokenProtocol, authTicket] = await buildAuthProtocols(accessToken, `tunnel_connection_${tunnelId}`);

                // Backend TunnelConnectionConsumer also expects tunnel.<id>
                const tunnelProtocol = `tunnel.${tunnelId}`;

                const ws = new WebSocket(url, [tokenProtocol, tunnelProtocol, authTicket]);
                wsRef.current = ws;

                ws.onopen = () => {
                    if (mountedRef.current) {
                        reconnectAttemptRef.current = 0;
                    }
                };

                ws.onmessage = (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        setStatus(data);
                    } catch {
                        // ignore parse errors
                    }
                };

                ws.onclose = () => {
                    wsRef.current = null;
                    if (mountedRef.current) {
                        if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
                            reconnectAttemptRef.current += 1;
                            timeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
                        }
                    }
                };

                ws.onerror = () => {
                    // onclose handles reconnect
                };
            } catch (e) {
                console.error("Tunnel WS connect error", e);
            }
        }

        connect();

        return () => {
            mountedRef.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.onclose = null;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [accessToken, tunnelId]);

    return { status };
}
