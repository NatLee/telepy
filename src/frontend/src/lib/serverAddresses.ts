/**
 * 伺服器的三個位址（純函式）：網頁、SSH、代理各自現在生效的值，以及沒設時退回什麼。`serverAddresses.test.ts` 有測試。
 * The server's three addresses (pure): the value in force for web, SSH and proxy, and what each falls back to when unset.
 */
import type { EnvMap } from "./settingSource.ts";
import type { SshHostVerdict } from "./sshHost.ts";

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
 * 位址上的 WebSocket（所以沒設時那一格是空的，而且可以放在 CDN 後面）。
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
        // 代理沒設定：沒有第三個位址，連線走網頁位址（所以前面可以有 CDN）。/ No proxy address: there is no third address; connections ride the web address (so a CDN in front is fine).
        { id: "proxy", value: proxy, set: proxy !== "", cdn: proxy === "" },
    ];
}

/** 每一條對應的設定 key。/ The setting behind each lane. */
export const LANE_KEY: Record<AddressLane["id"], string> = { web: "server_public_url", ssh: "server_ssh_host", proxy: "server_proxy_url" };

/** 圖上那一行現況需要的即時資料（還沒查到 = 缺）。/ The live facts behind a lane's status line (absent until checked). */
export interface LaneFacts {
    /** `/api/site/ssh-host` 的結論。/ The verdict of `/api/site/ssh-host`. */
    verdict?: SshHostVerdict;
    /** 網頁的名稱指到 Cloudflare。/ The web name points at Cloudflare. */
    webProxied?: boolean;
    /** 代理的入口有在聽。/ The proxy endpoint is listening. */
    proxyListening?: boolean;
}

export type LaneStatusKey = "cloudflare" | "noProxy" | "local" | "sshBlocked" | "unresolved" | "listening" | "portClosed";
export interface LaneStatus {
    key: LaneStatusKey;
    tone: "ok" | "warn" | "bad" | "plain";
}

/**
 * 一條的現況（一個點 + 幾個字）；null = 沒什麼好說（還沒查到，或代理位址沒設定——那一格自己就寫了）。
 * A lane's status (a dot and a few words); null = nothing to say (not checked yet, or an unset proxy address — its
 * own cell says so).
 */
export function laneStatus(lane: AddressLane, facts: LaneFacts): LaneStatus | null {
    if (lane.id === "proxy") {
        if (!lane.set || facts.proxyListening === undefined) return null;
        return facts.proxyListening ? { key: "listening", tone: "ok" } : { key: "portClosed", tone: "warn" };
    }
    if (facts.verdict === undefined) return null;
    if (facts.verdict === "local") return { key: "local", tone: "plain" };
    if (lane.id === "web") return { key: facts.webProxied ? "cloudflare" : "noProxy", tone: "plain" };
    if (facts.verdict === "ssh_proxied") return { key: "sshBlocked", tone: "bad" };
    if (facts.verdict === "unresolved") return { key: "unresolved", tone: "warn" };
    return { key: "noProxy", tone: "ok" };
}

/** 第一條有問題的（一進來就把它的設定打開）。/ The first lane with a problem (its editor opens by itself). */
export function firstProblem(lanes: AddressLane[], facts: LaneFacts): AddressLane["id"] | null {
    return lanes.find((l) => ["warn", "bad"].includes(laneStatus(l, facts)?.tone ?? ""))?.id ?? null;
}

/** 進 Telepy 的哪個入口：代理位址沒設定時走的是網頁的入口。/ Which door of Telepy: an unset proxy address uses the web door. */
export function laneDoor(lane: AddressLane): AddressLane["id"] {
    return lane.id === "proxy" && !lane.set ? "web" : lane.id;
}
