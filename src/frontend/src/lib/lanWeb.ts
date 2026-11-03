/**
 * 區網主機的網頁（純函式）：哪些 port 是網頁、網址怎麼寫、使用者自己打的「8080/admin」怎麼變成網址、dock 分頁上的短標籤。
 * 經通道打開它有兩條路：Telepy 的遠端瀏覽器（Chromium 在 Telepy 那邊，所有連線從裝置出去）或你自己的瀏覽器
 * （`telepy forward` / `ssh -L` 把 port 開到你電腦上）。port 表跟後端 `lan/web.rs` 一樣
 * （測試會讀 Rust 檔比對）；後端有給 `host.web` 時以它為準。
 * Pure helpers for LAN hosts' web pages: which ports are web pages, how their URLs read, how a typed "8080/admin"
 * becomes a URL, and the dock tab's short label. Two ways to open one through the tunnel: Telepy's remote browser
 * (Chromium runs on Telepy's side, every connection leaves from the device) or your own browser (`telepy forward` /
 * `ssh -L` brings the port to your computer). The port tables match the backend's (a test reads the Rust file);
 * `host.web` from the backend wins when present.
 */
import { shq } from "./forwardRecipes.ts";

export const WEB_HTTPS_PORTS: readonly number[] = [443, 5001, 8006, 8443, 9443, 10443];
export const WEB_HTTP_PORTS: readonly number[] = [80, 3000, 5000, 8000, 8008, 8080, 8081, 8123, 8888, 9000, 9090, 32400];

export type WebScheme = "http" | "https";

export interface WebLink {
    port: number;
    scheme: WebScheme;
    url: string;
}

/** 這個 port 通常是哪種網頁（不是網頁 = null）。/ The usual web scheme on a port (null = not a web port). */
export function webScheme(port: number): WebScheme | null {
    if (WEB_HTTPS_PORTS.includes(port)) return "https";
    if (WEB_HTTP_PORTS.includes(port)) return "http";
    return null;
}

/** 網址（預設 port 不寫；`path` 以 / 開頭）。/ The URL (default ports omitted; `path` starts with /). */
export function webUrl(address: string, port: number, scheme: WebScheme, path = "/"): string {
    const host = address.includes(":") ? `[${address}]` : address;
    const isDefault = (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${scheme}://${host}${isDefault ? "" : `:${port}`}${p}`;
}

type HostLike = { address: string; open_ports: number[]; web?: WebLink[] | null };

/** 主機開著的網頁 port（後端給的優先，舊後端自己算）。/ A host's web ports (the backend's list first). */
export function webLinks(h: HostLike): WebLink[] {
    if (Array.isArray(h.web)) return h.web;
    return [...new Set(h.open_ports)]
        .sort((a, b) => a - b)
        .flatMap((port) => {
            const scheme = webScheme(port);
            return scheme ? [{ port, scheme, url: webUrl(h.address, port, scheme) }] : [];
        });
}

export function hasWeb(h: HostLike): boolean {
    return webLinks(h).length > 0;
}

export type WebInputError = "empty" | "scheme" | "port" | "host";

/**
 * 使用者在「其他網頁」欄打的字 → 網址。可以是完整網址（只收 http / https）、`8080`、`8080/admin`、`/admin`
 * 或 `https:8443`；沒寫的就用這台主機的位址、照 port 猜 http / https（猜不到用 http）。
 * What someone types in the "other page" field → a URL: a full http(s) URL, `8080`, `8080/admin`, `/admin` or
 * `https:8443`; the host's address fills in the rest and the port picks http / https (http when unknown).
 */
export function parseWebInput(address: string, raw: string): { url: string } | { error: WebInputError } {
    const text = raw.trim();
    if (!text) return { error: "empty" };
    const full = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
    if (full) {
        const scheme = full[1].toLowerCase();
        if (scheme !== "http" && scheme !== "https") return { error: "scheme" };
        try {
            const u = new URL(text);
            if (!u.hostname) return { error: "host" };
            return { url: u.toString() };
        } catch {
            return { error: "host" };
        }
    }
    const m = /^(?:(https?):)?(\d{1,5})?(\/.*)?$/i.exec(text);
    if (!m || (!m[2] && !m[3])) return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:/i.test(text) ? { error: "scheme" } : { error: "port" };
    const port = m[2] ? Number(m[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) return { error: "port" };
    const scheme = (m[1]?.toLowerCase() as WebScheme | undefined) ?? (port !== null ? webScheme(port) ?? "http" : "http");
    const usePort = port ?? (scheme === "https" ? 443 : 80);
    return { url: webUrl(address, usePort, scheme, m[3] ?? "/") };
}

/** dock 分頁 / 清單上的短標籤：去掉 scheme 與結尾的 /。/ A short label: no scheme, no trailing slash. */
export function shortUrl(url: string): string {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** 遠端瀏覽器 session 屬於哪台裝置的哪個帳號：一樣就開新分頁，不一樣就得換一個。/ Which device + account a browser goes out through. */
export function sameBrowser(a: { tunnelId: number; deviceUser: string }, b: { tunnelId: number; deviceUser: string }): boolean {
    return a.tunnelId === b.tunnelId && a.deviceUser === b.deviceUser;
}

/**
 * 用自己的瀏覽器打開它：`telepy forward <通道>[@帳號] <位址>:<port> --open`（CLI 挑本機 port、跑 ssh -L、打開瀏覽器）。
 * Your own browser: the CLI picks a local port, runs ssh -L and opens the browser.
 */
export function forwardCommand(tunnelName: string, deviceUser: string | null, address: string, port: number): string {
    const target = deviceUser ? `${tunnelName}@${deviceUser}` : tunnelName;
    const host = address.includes(":") ? `[${address}]` : address;
    return `telepy forward ${shq(target)} ${shq(`${host}:${port}`)} --open`;
}
