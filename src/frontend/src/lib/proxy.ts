/**
 * 裝置代理（`/api/proxy/*`、`/ws/proxy/`）的純函式：頁面現在是哪種狀態、進來的兩條路、給人複製的範例、session 那一列
 * 的字。`proxy.test.ts` 有測試。
 * Pure helpers for the device proxy (`/api/proxy/*`, `/ws/proxy/`): which state the page is in, the two ways in, the
 * copy-ready examples and the words of a session row.
 */
import type { TranslationKey } from "../locales/en.ts";
import type { SpotState } from "./flow.ts";

export interface ProxyTunnel {
    id: number;
    name: string;
    online: boolean | null;
    accounts: string[];
    default_account: string | null;
    blocked: "step_up" | "no_account" | "offline" | null;
}

export interface ProxyInfo {
    enabled: boolean;
    allowed: boolean;
    scope: string;
    max_connections: number;
    idle_seconds: number;
    endpoints: { websocket: string; http_proxy: string | null; http_listening?: boolean };
    tunnels: ProxyTunnel[];
}

export interface ProxySession {
    id: string;
    user: { id: number; username: string };
    client_name: string;
    kind: "app" | "token" | "web";
    grant_id: number | null;
    token_id: number | null;
    tunnel: { id: number; name: string };
    username: string;
    ip: string | null;
    opened_at: string;
    connections: number;
    connections_total: number;
    bytes_up: number;
    bytes_down: number;
    targets: string[];
    targets_more: number;
}

export type ProxyState = "off" | "denied" | "noTunnels" | "ready";

/** 這一頁該說什麼：站台沒開、這個人被關掉、沒有能用的通道、可以用。/ What the page says: off, turned off for you, nothing usable, ready. */
export function proxyState(info: Pick<ProxyInfo, "enabled" | "allowed" | "tunnels">): ProxyState {
    if (!info.enabled) return "off";
    if (!info.allowed) return "denied";
    if (!info.tunnels.some((t) => t.blocked === null)) return "noTunnels";
    return "ready";
}

/** 預設選哪條通道：第一條能用的，沒有就第一條。/ The tunnel picked first: the first usable one, else the first. */
export function firstTunnel(tunnels: ProxyTunnel[]): ProxyTunnel | null {
    return tunnels.find((t) => t.blocked === null) ?? tunnels[0] ?? null;
}

export const BLOCKED_KEY: Record<NonNullable<ProxyTunnel["blocked"]>, TranslationKey> = {
    step_up: "proxy.blocked.stepUp",
    no_account: "proxy.blocked.noAccount",
    offline: "proxy.blocked.offline",
};

/** 路徑圖每一站的狀態。/ The state of each stop on the path diagram. */
export function pathStates(state: ProxyState, tunnel: ProxyTunnel | null): { app: SpotState; token: SpotState; telepy: SpotState; tunnel: SpotState; device: SpotState } {
    if (state === "off" || state === "denied") return { app: "ok", token: "failed", telepy: "waiting", tunnel: "waiting", device: "waiting" };
    const usable = tunnel !== null && tunnel.blocked === null;
    return { app: "ok", token: "ok", telepy: "ok", tunnel: usable ? "ok" : "failed", device: usable ? "ok" : "waiting" };
}

/** POSIX shell 引號。/ POSIX shell quoting. */
export function shq(value: string): string {
    return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `telepy proxy` 的指令（加一行用它的 curl）。/ The `telepy proxy` command, with a curl that uses it. */
export function cliExample(tunnel: string, port = 8118): string {
    return [`telepy proxy ${shq(tunnel)} --port ${port}`, `curl -x http://127.0.0.1:${port} https://ifconfig.me`].join("\n");
}

/** app 列出它能代理的通道。/ An app listing the tunnels it may proxy through. */
export function listExample(baseUrl: string): string {
    return `curl -H "Authorization: Bearer $TELEPY_TOKEN" ${baseUrl.replace(/\/$/, "")}/api/proxy/tunnels`;
}

/** 一條 WebSocket = 一條 TCP 連線：網址。/ One WebSocket = one TCP connection: its URL. */
export function wsUrl(endpoint: string, tunnel: string, host: string, port: number): string {
    return `${endpoint}?tunnel=${encodeURIComponent(tunnel)}&host=${encodeURIComponent(host)}&port=${port}`;
}

/** Python 的最小範例（`websockets` 套件）。/ A minimal Python example (the `websockets` package). */
export function pythonExample(endpoint: string, tunnel: string): string {
    return [
        "import asyncio, os, websockets",
        "",
        "async def main():",
        `    url = "${wsUrl(endpoint, tunnel, "localhost", 8080)}"`,
        '    headers = {"Authorization": "Bearer " + os.environ["TELEPY_TOKEN"]}',
        "    async with websockets.connect(url, additional_headers=headers) as ws:   # 101 = the device reached it",
        '        await ws.send(b"GET / HTTP/1.0\\r\\n\\r\\n")                        # binary frames are the TCP bytes',
        "        print((await ws.recv()).decode(errors='replace'))",
        "",
        "asyncio.run(main())",
    ].join("\n");
}

/** 標準 HTTP 代理（有設定代理位址時）：通道寫在帳號、token 寫在密碼。/ The standard HTTP proxy (when an address is set): the tunnel as the user, the token as the password. */
export function httpProxyExample(httpProxy: string, tunnel: string): string {
    const u = httpProxy.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(tunnel)}:$TELEPY_TOKEN@`);
    return `curl -x "${u}" https://ifconfig.me`;
}

/** 位元組數：`1.2 MB`。/ A byte count. */
export function bytes(n: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** 新的在前。/ Newest first. */
export function sortSessions(list: ProxySession[]): ProxySession[] {
    return [...list].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
}
