"use client";

/**
 * WebSocket 共用基礎：連線來源、重連退避、關閉碼。/ Shared WebSocket primitives: origin, backoff, close codes.
 * 放在獨立模組避免 websocket.ts 與 reconnectingSocket.ts 互相 import 造成循環相依。
 * Kept in a standalone module so websocket.ts and reconnectingSocket.ts don't import each other (no cycle).
 */

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

// 重連策略：指數退避 + full jitter（天花板 30s）；連線穩定存活後才歸零退避計數。
// Reconnect strategy: exponential backoff + full jitter (30s ceiling); reset the counter only after a stable open.
export const BASE_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;
export const STABLE_CONNECTION_MS = 10000;
// 認證/權限類關閉碼（見 consumers.py），重連也不會成功，直接停止。
// Auth/permission close codes (see consumers.py); retrying won't help, so stop.
export const NON_RETRYABLE_CLOSE_CODES = new Set([4000, 4001, 4002, 4003, 4004, 4006]);

/** full-jitter 指數退避：delay ∈ [0, min(ceiling, base * 2^attempt)] */
export function backoffDelay(attempt: number): number {
    const capped = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);
    return Math.random() * capped;
}
