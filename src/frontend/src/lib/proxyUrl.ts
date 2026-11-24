/**
 * 網站設定 → 伺服器 →「代理位址」那一列的純函式：裝置代理有兩個位址——網頁位址上的 WebSocket（永遠有）與標準的代理
 * 位址（有設、而且代理入口有在聽才有）。沒設定時連線就走網頁位址，所以兩列都列出來，跟「SSH 主機」那一列一樣。
 * Pure helpers for Site settings → Server → "Proxy address": the device proxy has two addresses — the WebSocket on the
 * web address (always) and the standard proxy address (when set and the endpoint listens). Unset, connections use the
 * web address, so both rows are listed, like the "SSH host" row does.
 */

export type ProxyRowState = "always" | "listening" | "notListening" | "sameAsWeb";

export interface ProxyRow {
    id: "web" | "proxy";
    /** 顯示的位址。/ The address shown. */
    value: string;
    state: ProxyRowState;
}

export type ProxyVerdict = "webOnly" | "ready" | "portClosed";

/** 整理輸入：去空白、去結尾斜線。/ Tidy the input: trimmed, no trailing slash. */
export function tidyUrl(raw: string): string {
    return raw.trim().replace(/\/+$/, "");
}

/** 輸入有什麼問題（null = 沒有；空白 = 清掉，也沒問題）。規則跟後端 `check_proxy_url` 一樣。/ What is wrong with the input (null = nothing; blank clears it). Same rule as the backend's `check_proxy_url`. */
export function proxyUrlProblem(raw: string): "format" | null {
    const v = tidyUrl(raw);
    if (v === "") return null;
    let u: URL;
    try {
        u = new URL(v);
    } catch {
        return "format";
    }
    const ok = (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && u.username === "" && u.password === "" && (u.pathname === "" || u.pathname === "/") && u.search === "" && u.hash === "";
    return ok ? null : "format";
}

/**
 * 兩列：網頁位址上的 WebSocket，與代理位址。代理位址沒設 = 顯示網頁那一個並標「跟網頁一樣」；設了但入口沒在聽 = 標出來。
 * The two rows: the WebSocket on the web address, and the proxy address. Unset, the proxy row shows the web one marked
 * "same as the web"; set while the endpoint isn't listening is marked as such.
 */
export function proxyRows(saved: string, websocket: string, listening: boolean): ProxyRow[] {
    const set = tidyUrl(saved);
    return [
        { id: "web", value: websocket, state: "always" },
        set === "" ? { id: "proxy", value: websocket, state: "sameAsWeb" } : { id: "proxy", value: set, state: listening ? "listening" : "notListening" },
    ];
}

export function proxyVerdict(saved: string, listening: boolean): ProxyVerdict {
    if (tidyUrl(saved) === "") return "webOnly";
    return listening ? "ready" : "portClosed";
}
