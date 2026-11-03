/**
 * 區網主機「是什麼機器」（純函式）：後端 `lan/identify.rs` 給的類型（路由器、NAS、虛擬化…）與服務指紋，怎麼排序、計數、
 * 搜尋、顯示一句「憑什麼」。類型清單跟後端 `KINDS` 一樣（測試會讀 Rust 檔比對）；沒認出來的主機照舊用 port 分類。
 * What a LAN host is (pure): the type the backend's `lan/identify.rs` gives (router, NAS, hypervisor…) and the service
 * fingerprints — order, counts, search and the one-line "why". The type list matches the backend's `KINDS` (a test
 * reads the Rust file); unrecognised hosts keep their port-based kind.
 */
import type { HostKind } from "./lanHosts.ts";

export const DEVICE_KINDS = ["router", "network", "nas", "hypervisor", "server", "computer", "printer", "camera", "media", "iot", "phone"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface HostService {
    port: number;
    proto: string;
    status?: number;
    title?: string;
    server?: string;
    location?: string;
    realm?: string;
    banner?: string;
    cert?: { subject?: string; issuer?: string; org?: string; not_after?: number; self_signed: boolean; names?: string[] };
}

export interface HostIdentity {
    product: string | null;
    kind: DeviceKind;
    os?: string;
    by: { source: "title" | "server" | "cert" | "realm" | "banner" | "vendor" | "ports" | "gateway"; text: string };
}

type HostLike = { identity?: HostIdentity | null };

export function deviceKind(h: HostLike): DeviceKind | null {
    const k = h.identity?.kind;
    return k && (DEVICE_KINDS as readonly string[]).includes(k) ? k : null;
}

/** 「網路上有什麼」：每種類型幾台（照清單順序，沒有的不列），再加認不出來的台數。/ Counts per type, plus the unknown ones. */
export function kindTally(hosts: HostLike[]): { kinds: { kind: DeviceKind; count: number }[]; unknown: number } {
    const counts = new Map<DeviceKind, number>();
    let unknown = 0;
    for (const h of hosts) {
        const k = deviceKind(h);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
        else unknown += 1;
    }
    return { kinds: DEVICE_KINDS.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind)! })), unknown };
}

/** 主機在列表裡顯示的一句：產品（+ 系統）或系統。/ The host's one-line description: product (+ OS) or the OS. */
export function identityLine(h: HostLike): string | null {
    const id = h.identity;
    if (!id) return null;
    if (id.product && id.os && !id.product.toLowerCase().includes(id.os.toLowerCase())) return `${id.product} · ${id.os}`;
    return id.product ?? id.os ?? null;
}

/** 搜尋：`type:router`、產品名稱與標題都找得到。/ Search: `type:` plus product names and page titles. */
export function identityText(h: HostLike & { services?: HostService[] | null }): string {
    const parts: string[] = [];
    if (h.identity) parts.push(h.identity.kind, h.identity.product ?? "", h.identity.os ?? "");
    for (const s of h.services ?? []) parts.push(s.title ?? "", s.server ?? "", s.banner ?? "", s.cert?.subject ?? "");
    return parts.filter(Boolean).join(" ").toLowerCase();
}

/** 這個 port 用 http 還是 https（指紋優先；沒有就 null，由呼叫端照 port 猜）。/ The scheme a fingerprint saw on a port. */
export function seenScheme(services: HostService[] | null | undefined, port: number): "http" | "https" | null {
    const s = services?.find((x) => x.port === port);
    return s?.proto === "https" ? "https" : s?.proto === "http" ? "http" : null;
}

/** 憑證快到期或已過期（天數；null = 不知道）。/ Days until a certificate expires (null = unknown). */
export function certDaysLeft(s: HostService, nowSec: number): number | null {
    const t = s.cert?.not_after;
    return typeof t === "number" ? Math.floor((t - nowSec) / 86400) : null;
}

/** 沒認出類型時退回 port 分類的圖示（終端機 / 桌面 / 檔案 / 網頁 / 其他）。/ The fallback when no type is known. */
export function displayKind(h: HostLike, portKind: HostKind): DeviceKind | HostKind {
    return deviceKind(h) ?? portKind;
}
