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

/** 網頁 port 旁邊那句：有多確定它是網頁。/ The line beside a web port: how sure Telepy is that it is one. */
export function portHint(p: DevicePort): TranslationKey | null {
    if (p.web === "seen") return "browser.ports.seen";
    if (p.web === "usual") return "browser.ports.usual";
    if (p.web === "maybe") return "browser.ports.maybe";
    return null;
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
