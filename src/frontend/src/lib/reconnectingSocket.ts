"use client";

/**
 * 共用的可重連 WebSocket 抽象。/ Shared reconnecting WebSocket abstraction.
 *
 * 認證：連上後「第一則訊息」送 {"type":"auth","token":<jwt>, ...authFields}。
 *  - JWT 只在 WS 訊息 payload，不進 URL / subprotocol / 任何請求 header，避免被 proxy / access log 記錄。
 *  - 省掉舊版 ws-ticket 的預先 HTTP round-trip（連線更快）。
 *  - token 過期時後端回關閉碼 4001；此時 refresh 一次 access token 再重連（見 onclose）。
 *
 * 另處理：指數退避 + full jitter 重連、連線穩定後才歸零、認證/權限關閉碼不重試、
 *        應用層心跳（ping/pong）偵測半開連線。
 *
 * Auth: send {"type":"auth","token":...} as the FIRST WS frame after open. The JWT stays in the WS
 * payload (never in URL/subprotocol/headers, so proxies/logs can't capture it) and there's no
 * ws-ticket pre-flight. On 4001 (expired token) we refresh once and reconnect. Also: exponential
 * backoff + jitter reconnect, stable-open reset, no-retry on auth/permission codes, ping/pong heartbeat.
 */
import { refreshAccessToken } from "@/lib/api";
import { getWsOrigin, backoffDelay, STABLE_CONNECTION_MS, NON_RETRYABLE_CLOSE_CODES } from "@/lib/wsCommon";

const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 10000;

/** 讀取目前的 access token。/ Read the current access token. */
function getAccessToken(): string | null {
    return typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
}

export type ReconnectingSocketOptions = {
    /** e.g. "/ws/notifications/" */
    path: string;
    /**
     * 併入第一則 auth 訊息的額外「非敏感」欄位（如 { server_id, username } 或 { tunnel_id }）。
     * Extra non-sensitive fields merged into the first auth message (e.g. { tunnel_id }).
     */
    authFields?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
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
    // token 過期時只允許 refresh 重連一次；連線穩定存活後歸零，避免無限 refresh 迴圈。
    // Allow a single refresh-retry per auth failure; reset once the connection proves stable.
    private authRefreshTried = false;

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
            const extra = this.opts.authFields ? await this.opts.authFields() : {};
            if (this.closedByUser) { this.connecting = false; return; }

            const ws = new WebSocket(`${getWsOrigin()}${this.opts.path}`);
            this.ws = ws;

            ws.onopen = () => {
                this.connecting = false;
                // 第一則訊息即認證：{type:'auth', token, ...authFields}。
                // First frame authenticates: {type:'auth', token, ...authFields}.
                ws.send(JSON.stringify({ type: "auth", token: getAccessToken(), ...extra }));
                this.opts.onStatus?.(true);
                if (this.stableTimer) clearTimeout(this.stableTimer);
                this.stableTimer = setTimeout(() => {
                    this.reconnectAttempt = 0;
                    this.authRefreshTried = false; // 連線穩定 → 允許下次 4001 再 refresh 一次
                }, STABLE_CONNECTION_MS);
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
                // 4001：token 無效/過期。refresh 一次再重連；refresh 失敗才放棄。
                // 4001: invalid/expired token — refresh once and retry; give up only if refresh fails.
                if (event.code === 4001) { void this.handleAuthClose(); return; }
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

    private async handleAuthClose() {
        if (this.closedByUser || this.authRefreshTried) return; // 每次認證失敗只 refresh 一次
        this.authRefreshTried = true;
        const ok = await refreshAccessToken();
        if (ok && !this.closedByUser && !this.ws) {
            this.reconnectAttempt = 0;
            void this.connect();
        }
        // refresh 失敗 → 不重連（保持關閉）。/ refresh failed → stay closed.
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
