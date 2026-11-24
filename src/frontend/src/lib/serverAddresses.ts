/**
 * 伺服器的三個位址（純函式）：網頁、SSH、代理各自現在生效的值，以及沒設時退回什麼。`serverAddresses.test.ts` 有測試。
 * The server's three addresses (pure): the value in force for web, SSH and proxy, and what each falls back to when unset.
 */
import type { EnvMap } from "./settingSource.ts";

export interface AddressLane {
    id: "web" | "ssh" | "proxy";
    /** 顯示的值（沒設時是退回的那個；代理沒設 = 空）。/ The value shown (the fallback when unset; empty for an unset proxy). */
    value: string;
    /** 明確設了（.env 或這一頁）。/ Explicitly set (in .env or on this page). */
    set: boolean;
    /** 可以放在只轉網頁的 CDN / 代理後面。/ May sit behind a CDN or proxy that only carries web traffic. */
    cdn: boolean;
}

/** 現在生效的字串值：.env 有設用它，否則這頁存的。/ The string in force: .env when set, else what this page saved. */
export function inForce(values: Record<string, unknown>, env: EnvMap, key: string): string {
    const e = env[key];
    const raw = e?.set ? e.value : values[key];
    return typeof raw === "string" ? raw.trim() : "";
}

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
};

/**
 * 三條：網頁位址沒設 = 從請求推導（顯示現在這個瀏覽器用的）；SSH 沒設 = 跟網頁同一個主機；代理沒設 = 沒有，走網頁
 * 位址上的 WebSocket。
 * The three lanes: an unset web address is derived from the request (shown as what this browser uses); an unset SSH
 * host is the web host; an unset proxy address means none — the proxy rides WebSockets on the web address.
 */
export function addressLanes(values: Record<string, unknown>, env: EnvMap, origin: string): AddressLane[] {
    const web = inForce(values, env, "server_public_url");
    const ssh = inForce(values, env, "server_ssh_host");
    const proxy = inForce(values, env, "server_proxy_url");
    const webShown = web || origin;
    return [
        { id: "web", value: webShown, set: web !== "", cdn: true },
        { id: "ssh", value: ssh || hostOf(webShown), set: ssh !== "", cdn: false },
        { id: "proxy", value: proxy, set: proxy !== "", cdn: false },
    ];
}
