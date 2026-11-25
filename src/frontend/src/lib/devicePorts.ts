/**
 * 裝置自己在聽的 port（遠端瀏覽器面板的「這台裝置上」）：分成瀏覽器打得開的和不是網頁的、每個 port 叫什麼、
 * 旁邊那句說明用哪個字串。純函式，資料來自 `GET /api/reverse/server/{id}/remote-browser/ports`。
 * The device's own listening ports (the remote browser panel's "On this device"): split into what the browser can open
 * and what isn't a web page, each port's name, and which string explains it. Pure; data from
 * `GET /api/reverse/server/{id}/remote-browser/ports`.
 */
import type { TranslationKey } from "../locales/en.ts";

export type PortWeb = "seen" | "usual" | "maybe" | "no";

export interface DevicePort {
    port: number;
    web: PortWeb;
    scheme: "http" | "https" | null;
    /** 瀏覽器要開的網址（一律 localhost：瀏覽器是從裝置連出去的）。/ What the browser opens (always localhost). */
    url: string | null;
    title: string | null;
    proto: string | null;
    loopback_only: boolean;
}

export interface DevicePortsData {
    tunnel_id: number;
    username: string;
    /** false = 裝置上沒有列得出 port 的工具。/ false = no tool on the device could list its ports. */
    listed: boolean;
    /** 有沒有掃描看過裝置自己（名稱從那裡來）。/ Whether a scan has looked at the device itself (names come from it). */
    scanned: boolean;
    ports: DevicePort[];
}

/** 瀏覽器打得開的（有網址）與不是網頁的；各自維持後端的順序。/ What the browser can open vs the rest, in the backend's order. */
export function splitPorts(ports: DevicePort[]): { web: DevicePort[]; other: DevicePort[] } {
    return { web: ports.filter((p) => p.url !== null), other: ports.filter((p) => p.url === null) };
}

/**
 * 左側分類：掃描看過是網頁 / 通常是網頁 / 可能是網頁 / 不是網頁（瀏覽器打不開，沒有網址）。
 * The left-hand groups: seen as a web page / usually one / maybe one / not a web page (no URL, the browser can't open it).
 */
export type PortGroup = "seen" | "usual" | "maybe" | "no";
export const PORT_GROUPS: readonly PortGroup[] = ["seen", "usual", "maybe", "no"];

export function portGroup(p: DevicePort): PortGroup {
    return p.url === null ? "no" : p.web === "no" ? "maybe" : p.web;
}

/**
 * 搜尋：port 號碼（「80」找到 80、8080）或名稱，不分大小寫；空字串 = 全部。
 * Search: the port number ("80" finds 80 and 8080) or its name, case-insensitive; empty = everything.
 */
export function matchPort(p: DevicePort, query: string, name: string | null): boolean {
    const q = query.trim().toLowerCase().replace(/^:/, "");
    if (!q) return true;
    return String(p.port).includes(q) || (name ?? "").toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q);
}

/** 依分類分好（各自維持後端的順序）。/ Ports per group, each in the backend's order. */
export function groupPorts(ports: DevicePort[]): Record<PortGroup, DevicePort[]> {
    const out: Record<PortGroup, DevicePort[]> = { seen: [], usual: [], maybe: [], no: [] };
    for (const p of ports) out[portGroup(p)].push(p);
    return out;
}

/**
 * 要顯示哪一類：選的那類還有東西就是它，否則第一個有東西的（搜尋把它清空時跟著跳，網頁類優先）；全空 = 選的那類。
 * Which group to show: the chosen one while it has ports, else the first that has any (follows a search that empties it,
 * web groups first); all empty = the chosen one.
 */
export function shownGroup(groups: Record<PortGroup, DevicePort[]>, chosen: PortGroup | null): PortGroup {
    if (chosen && groups[chosen].length > 0) return chosen;
    return PORT_GROUPS.find((g) => groups[g].length > 0) ?? chosen ?? "seen";
}

/** 分類的名稱。/ A group's label. */
export function groupKey(g: PortGroup): TranslationKey {
    return g === "no" ? "browser.ports.groupNo" : g === "seen" ? "browser.ports.seen" : g === "usual" ? "browser.ports.usual" : "browser.ports.maybe";
}

const GENERIC = new Set(["HTTP", "HTTPS"]);

/**
 * 這個 port 叫什麼：掃描讀到的標題 → 掃描認出的協定（不是網頁的）→ 常見服務名稱。網頁 port 的「HTTP / HTTPS」
 * 不算名字（鎖頭和說明已經講了）。
 * A port's name: the scan's title → the protocol the scan recognised (non-web) → the well-known service name. "HTTP" /
 * "HTTPS" isn't a name for a web port (the lock and the hint already say so).
 */
export function portName(p: DevicePort, known: (port: number) => string | null): string | null {
    if (p.title) return p.title;
    if (p.proto && p.proto !== "http" && p.proto !== "https") return p.proto.toUpperCase();
    const name = known(p.port);
    if (!name || (p.url !== null && GENERIC.has(name))) return null;
    return name;
}

/** 列不出來時說什麼（後端的 `code`）；null = 用後端的訊息。/ What to say when listing failed (the backend's `code`); null = its message. */
export function portsErrorKey(code: unknown): TranslationKey | null {
    if (code === "device_offline") return "browser.ports.offline";
    if (code === "no_account") return "browser.ports.noAccount";
    return null;
}

/** 列表是空的時候說什麼。/ What an empty list means. */
export function emptyKey(d: Pick<DevicePortsData, "listed">): TranslationKey {
    return d.listed ? "browser.ports.empty" : "browser.ports.noTool";
}
