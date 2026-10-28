/**
 * 網路頁「所有主機」的純函式：把每台裝置的區網主機攤平成一張表、跨裝置搜尋（名稱、IP、MAC 廠商、種類、port）、
 * 排序、種類篩選，以及「最近用過的主機」清單（存在 localStorage）。主機種類（`hostKind`）也住在這裡。
 * Pure helpers for the network page's "All hosts" view: every device's LAN hosts flattened into one table, a search
 * across devices (name, IP, MAC vendor, kind, port), sorting, the kind filter and the "recently used hosts" list
 * (kept in localStorage). The host kind (`hostKind`) lives here too.
 */
import type { LanHost } from "../types/lan.ts";

/** 這台主機的 SSH port 有沒有在最後一次掃描時開著（或看到 SSH banner）。/ SSH seen on this host. */
export function hasSsh(h: Pick<LanHost, "open_ports" | "ssh_port" | "ssh_banner">): boolean {
    return h.open_ports.includes(h.ssh_port) || !!h.ssh_banner;
}

export type HostKind = "ssh" | "desktop" | "files" | "web" | "other";
export const HOST_KINDS: readonly HostKind[] = ["ssh", "desktop", "files", "web", "other"];

/** 依開著的 port 粗分（決定圖示）。/ Coarse kind from the open ports (picks the icon). */
export function hostKind(h: Pick<LanHost, "open_ports" | "ssh_port" | "ssh_banner">): HostKind {
    const p = new Set(h.open_ports);
    if (hasSsh(h)) return "ssh";
    if (p.has(3389) || p.has(5900) || p.has(21118)) return "desktop";
    if (p.has(445) || p.has(139) || p.has(548) || p.has(2049)) return "files";
    if (p.has(80) || p.has(443) || p.has(8080) || p.has(8443)) return "web";
    return "other";
}

type HostLike = Pick<LanHost, "id" | "tunnel_id" | "address" | "hostname" | "label" | "mac" | "vendor" | "ssh_banner" | "open_ports" | "ssh_port" | "last_seen">;
type DeviceLike<H> = { id: number; name: string; hosts: H[] };

export interface HostRow<H extends HostLike, D extends { id: number; name: string }> {
    host: H;
    device: D;
    kind: HostKind;
    /** 顯示名稱：標籤 > 主機名稱 > 位址。/ Display name: label, then hostname, then address. */
    name: string;
}

/** 每台裝置的主機攤平成一列一台（依裝置、再依位址）。/ Every device's hosts as one row each. */
export function flattenHosts<D extends DeviceLike<HostLike>>(devices: D[]): HostRow<D["hosts"][number], D>[] {
    return devices.flatMap((device) => device.hosts.map((host) => ({ host, device, kind: hostKind(host), name: host.label || host.hostname || host.address })));
}

/** 搜尋字拆成小寫詞，全部都要符合（AND）。/ The query as lower-case words, all of which must match. */
export function queryTerms(query: string): string[] {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 一台主機符不符合一個詞：純數字 = 開著的 port（完全相同）或位址的一部分；`port:N` 只比 port；`kind:x` 只比種類；
 * 其他比名稱、位址、主機名稱、MAC、廠商、SSH banner、所在裝置與種類（含翻譯後的種類名稱）。
 * One word against one host: digits = an open port (exact) or part of the address; `port:N` ports only; `kind:x`
 * the kind only; anything else name, address, hostname, MAC, vendor, SSH banner, device and kind (incl. its
 * translated label).
 */
export function hostMatchesTerm(row: { host: HostLike; device: { name: string }; kind: HostKind }, term: string, kindLabel: (k: HostKind) => string = (k) => k): boolean {
    const { host } = row;
    const port = /^port:(\d{1,5})$/.exec(term);
    if (port) return host.open_ports.includes(Number(port[1]));
    const kind = /^kind:(.+)$/.exec(term);
    if (kind) return row.kind === kind[1] || kindLabel(row.kind).toLowerCase().includes(kind[1]);
    if (/^\d{1,5}$/.test(term) && host.open_ports.includes(Number(term))) return true;
    const fields = [host.label, host.hostname, host.address, host.mac, host.vendor, host.ssh_banner, row.device.name, row.kind, kindLabel(row.kind)];
    return fields.some((v) => !!v && v.toLowerCase().includes(term));
}

export function hostMatches(row: { host: HostLike; device: { name: string }; kind: HostKind }, terms: string[], kindLabel?: (k: HostKind) => string): boolean {
    return terms.every((term) => hostMatchesTerm(row, term, kindLabel));
}

export type HostSort = "name" | "address" | "device" | "seen";
export const HOST_SORTS: readonly HostSort[] = ["name", "address", "device", "seen"];

/** IPv4 依數字排（10.0.0.9 在 10.0.0.10 前面）；不是 IPv4 的排在後面、依字母。/ IPv4 sorts numerically; others after, alphabetically. */
export function compareAddress(a: string, b: string): number {
    const pa = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
    const pb = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(b);
    if (pa && pb) {
        for (let i = 1; i <= 4; i++) {
            const d = Number(pa[i]) - Number(pb[i]);
            if (d) return d;
        }
        return 0;
    }
    if (pa) return -1;
    if (pb) return 1;
    return a.localeCompare(b);
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * 排序（不改原陣列）。`seen` = 最近看到的在前（沒掃描過的手動主機在最後）；`desc` 反過來。同值依裝置、位址。
 * Sort without mutating. `seen` = most recently seen first (never-scanned manual hosts last); `desc` reverses. Ties
 * by device, then address.
 */
export function sortHosts<R extends { host: HostLike; device: { name: string }; name: string }>(rows: R[], key: HostSort, desc = false): R[] {
    const seen = (r: R) => (r.host.last_seen ? Date.parse(r.host.last_seen) : Number.NEGATIVE_INFINITY);
    const tie = (a: R, b: R) => byName(a.device.name, b.device.name) || compareAddress(a.host.address, b.host.address);
    const cmp = (a: R, b: R): number => {
        if (key === "name") return byName(a.name, b.name) || tie(a, b);
        if (key === "address") return compareAddress(a.host.address, b.host.address) || byName(a.device.name, b.device.name);
        if (key === "device") return tie(a, b);
        const d = seen(b) - seen(a);
        return (Number.isNaN(d) ? 0 : d) || tie(a, b);
    };
    const out = [...rows].sort(cmp);
    return desc ? out.reverse() : out;
}

/** 依種類數（篩選鈕上的數字）。/ Hosts per kind (the counts on the kind filter). */
export function countKinds(rows: { kind: HostKind }[]): Record<HostKind | "all", number> {
    const out = { all: rows.length, ssh: 0, desktop: 0, files: 0, web: 0, other: 0 };
    for (const r of rows) out[r.kind]++;
    return out;
}

// ── 最近用過的主機 / Recently used hosts ──────────────────────────────────

export const RECENT_KEY = "telepy.lanRecent";
export const RECENT_MAX = 8;

export interface RecentHost {
    tunnelId: number;
    hostId: number;
    /** 用的時間（ms）。/ When it was used (ms). */
    at: number;
}

/** localStorage 的值 → 清單（壞掉的項目丟掉）。/ The stored value as a list (bad entries dropped). */
export function parseRecent(raw: string | null): RecentHost[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        if (!Array.isArray(v)) return [];
        return v
            .filter((x) => x && Number.isInteger(x.tunnelId) && Number.isInteger(x.hostId) && typeof x.at === "number")
            .map((x) => ({ tunnelId: x.tunnelId, hostId: x.hostId, at: x.at }))
            .slice(0, RECENT_MAX);
    } catch {
        return [];
    }
}

/** 用了一台主機：移到最前面，最多留 `RECENT_MAX` 台。/ Using a host moves it to the front; at most `RECENT_MAX` kept. */
export function pushRecent(list: RecentHost[], tunnelId: number, hostId: number, at: number): RecentHost[] {
    return [{ tunnelId, hostId, at }, ...list.filter((x) => x.hostId !== hostId)].slice(0, RECENT_MAX);
}

/** 最近用過的、還在的主機（刪掉或看不到的跳過），依使用時間。/ The recent hosts that still exist, newest first. */
export function recentRows<R extends { host: { id: number } }>(recent: RecentHost[], rows: R[]): R[] {
    const byId = new Map(rows.map((r) => [r.host.id, r]));
    return recent.map((x) => byId.get(x.hostId)).filter((r): r is R => r !== undefined);
}

/**
 * 主機在一個清單裡往上 / 往下移一格（鍵盤 ↑↓）；不在清單裡就從頭（↓）或尾（↑）開始。
 * Moving one row up / down a list (↑↓ keys); from outside the list, ↓ starts at the top and ↑ at the bottom.
 */
export function stepIndex(current: number, length: number, delta: 1 | -1): number {
    if (length <= 0) return -1;
    if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1;
    return Math.min(length - 1, Math.max(0, current + delta));
}
