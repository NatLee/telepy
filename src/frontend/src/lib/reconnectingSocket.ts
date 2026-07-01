"use client";

/**
 * 共用的可重連 WebSocket 抽象。/ Shared reconnecting WebSocket abstraction.
 *
 * 一次到位地處理：
 *  - 一次性 ticket 認證：連線前先打 /api/auth/ws-ticket（JWT 走 Authorization header，不進 WS/URL）；
 *    因為 apiFetch 遇到 401 會自動 refresh，所以每次（重）連天然帶最新身分（解決 token 過期重連）。
 *  - 指數退避 + full jitter 重連、連線穩定後才歸零、認證/權限關閉碼不重試。
 *  - 應用層心跳（ping/pong）：偵測半開連線，逾時未回 pong 就主動斷開重連。
 *
 * Handles, in one place: one-time ticket auth (token only in the Authorization header, never in the
 * WS subprotocol/URL; apiFetch auto-refreshes so every (re)connect carries a fresh identity), exponential
 * backoff + jitter reconnect, stable-open reset, no-retry on auth/permission close codes, and an optional
 * app-level ping/pong heartbeat to detect half-open connections.
 */
import { apiFetch } from "@/lib/api";
import { getWsOrigin, backoffDelay, STABLE_CONNECTION_MS, NON_RETRYABLE_CLOSE_CODES } from "@/lib/wsCommon";

const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 10000;

/** 取得一次性 WebSocket 連線票。/ Fetch a one-time WebSocket ticket. */
export async function fetchWsTicket(): Promise<string> {
    const res = await apiFetch("/api/auth/ws-ticket", { method: "POST" });
    if (!res.ok) throw new Error(`ws-ticket request failed: ${res.status}`);
    const data = await res.json();
    if (!data?.ticket) throw new Error("ws-ticket response missing ticket");
    return data.ticket as string;
}

export type ReconnectingSocketOptions = {
    /** e.g. "/ws/notifications/" */
    path: string;
    /** 額外的「非敏感」subprotocols（如 server.<id>、tunnel.<id>）。/ extra non-sensitive subprotocols. */
    protocols?: () => string[] | Promise<string[]>;
    /** 啟用應用層 ping/pong 心跳。/ enable app-level ping/pong heartbeat. */
    heartbeat?: boolean;
    onOpen?: (socket: ReconnectingSocket) => void;
    onMessage?: (data: string) => void;
    onStatus?: (connected: boolean) => void;
};

export class ReconnectingSocket {
    private ws: WebSocket | null = null;
    private closedByUser = false;
    private connecting = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private stableTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    private awaitingPong = false;

    constructor(private opts: ReconnectingSocketOptions) {}

    start() {
        this.closedByUser = false;
        this.reconnectAttempt = 0;
        void this.connect();
    }

    /** 手動立即重連（重置退避）。/ Manual immediate reconnect (resets backoff). */
    reconnect() {
        this.forceClose();
        this.closedByUser = false;
        this.reconnectAttempt = 0;
        void this.connect();
    }

    /** 永久關閉（不再重連）。/ Permanent close (no reconnect). */
    close() {
        this.closedByUser = true;
        this.forceClose();
    }

    send(data: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    }

    get isOpen(): boolean {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    private async connect() {
        if (this.closedByUser || this.connecting || this.ws) return;
        this.connecting = true;
        try {
            const ticket = await fetchWsTicket();
            if (this.closedByUser) { this.connecting = false; return; }
            const extra = this.opts.protocols ? await this.opts.protocols() : [];
            if (this.closedByUser) { this.connecting = false; return; }

            const ws = new WebSocket(`${getWsOrigin()}${this.opts.path}`, [`ticket.${ticket}`, ...extra]);
            this.ws = ws;

            ws.onopen = () => {
                this.connecting = false;
                this.opts.onStatus?.(true);
                if (this.stableTimer) clearTimeout(this.stableTimer);
                this.stableTimer = setTimeout(() => { this.reconnectAttempt = 0; }, STABLE_CONNECTION_MS);
                if (this.opts.heartbeat) this.startHeartbeat();
                this.opts.onOpen?.(this);
            };

            ws.onmessage = (e) => {
                if (this.opts.heartbeat) {
                    // 攔截 pong（不轉發），並標記連線存活。/ Intercept pong (don't forward); mark alive.
                    try {
                        const parsed = JSON.parse(e.data);
                        if (parsed && parsed.type === "pong") { this.onPong(); return; }
                    } catch { /* 非 JSON（如純文字）→ 照常轉發 / not JSON → forward as-is */ }
                }
                this.opts.onMessage?.(e.data);
            };

            ws.onclose = (event) => {
                if (this.ws === ws) this.ws = null;
                this.connecting = false;
                this.stopHeartbeat();
                if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
                this.opts.onStatus?.(false);
                if (this.closedByUser) return;
                if (NON_RETRYABLE_CLOSE_CODES.has(event.code)) return;
                this.scheduleReconnect();
            };

            ws.onerror = () => {
                // onclose fires afterwards and handles reconnect
            };
        } catch (e) {
            console.error(`ReconnectingSocket(${this.opts.path}) connect error`, e);
            this.connecting = false;
            if (!this.closedByUser) this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const delay = backoffDelay(this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closedByUser && !this.ws) void this.connect();
        }, delay);
    }

    private forceClose() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
        this.stopHeartbeat();
        this.connecting = false;
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null; // prevent reconnect
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.isOpen) return;
            this.send(JSON.stringify({ type: "ping" }));
            this.awaitingPong = true;
            if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = setTimeout(() => {
                // 沒收到 pong → 視為半開連線，關閉以觸發重連。/ No pong → treat as half-open, close to reconnect.
                if (this.awaitingPong && this.ws) {
                    try { this.ws.close(); } catch { /* noop */ }
                }
            }, HEARTBEAT_TIMEOUT_MS);
        }, HEARTBEAT_INTERVAL_MS);
    }

    private onPong() {
        this.awaitingPong = false;
        if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
        if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
        this.awaitingPong = false;
    }
}
