/**
 * 隧道列表的搜尋語法（參考 Tailscale 機器頁的 `property:value` 篩選）：空白分開的詞都要成立（AND）；
 * `key:a,b` 是「a 或 b」；前面加 `-` 是排除；其他詞比對名稱、說明、埠、IP 與正在使用的人。
 * 看起來像篩選（英文字母 + 冒號）但 key 或值不認得的詞會被略過並列出來，不會當成文字讓整個列表變空。
 * Search syntax for the tunnel list, after Tailscale's machine filters: whitespace-separated terms are ANDed,
 * `key:a,b` means a OR b, a leading `-` negates, anything else is free text over name, description, port,
 * IP and who is using it.
 *
 *   status:online|degraded|offline|never|up|down   up = online + degraded，down = offline + never
 *   shared:in|out|no                                in = 別人分享給我；out = 我分享出去；no = 我的、沒分享
 *   port:1024 | port:1024-1100 | port:>2000         埠號、範圍或比較
 *   lastseen:>3h | lastseen:<1d | lastseen:never    最後上線多久以前（m/h/d/w）；連著的算「現在」
 *   ip:203.0.113                                    裝置公網 IP 的前綴
 *   user:alice                                      現在正在用這條隧道的人（看得到細節時）
 *
 * 純函式、不依賴 React，`tunnelQuery.test.ts` 有測試。/ Pure functions; tested in tunnelQuery.test.ts.
 */
import type { Tunnel, TunnelHealth } from "../types/tunnel";

export const QUERY_KEYS = ["status", "shared", "port", "lastseen", "ip", "user"] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

export interface QueryFilter {
    key: QueryKey;
    values: string[];
    negate: boolean;
    /** 原始的詞（顯示「看不懂」時用）。/ The raw token, for the "not understood" hint. */
    raw: string;
}

export interface ParsedQuery {
    text: string[];
    filters: QueryFilter[];
    /** 看起來像篩選、但 key 或值不認得的詞（被略過）。/ Filter-looking terms with an unknown key or bad value (ignored). */
    invalid: string[];
}

export interface MatchContext {
    /** 即時健康狀態（lib/tunnelHealth.liveHealth）。/ Live health. */
    health: TunnelHealth;
    now: number;
}

const STATUS = new Set(["online", "degraded", "offline", "never", "up", "down"]);
const SHARED = new Set(["in", "out", "no"]);
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** 空白切詞，雙引號裡的空白保留。/ Split on whitespace, keeping quoted phrases together. */
export function tokenize(input: string): string[] {
    const out: string[] = [];
    const re = /(-?[a-z]+:)?"([^"]*)"|\S+/gi;
    for (const m of input.matchAll(re)) {
        out.push(m[2] !== undefined ? `${m[1] ?? ""}${m[2]}` : m[0]);
    }
    return out.filter((t) => t.length > 0);
}

function validValue(key: QueryKey, v: string): boolean {
    switch (key) {
        case "status":
            return STATUS.has(v);
        case "shared":
            return SHARED.has(v);
        case "port":
            return /^\d{1,5}$/.test(v) || /^\d{1,5}-\d{1,5}$/.test(v) || /^[<>]\d{1,5}$/.test(v);
        case "lastseen":
            return v === "never" || /^[<>]\d+[mhdw]$/.test(v);
        case "ip":
        case "user":
            return v.length > 0;
    }
}

export function parseQuery(input: string): ParsedQuery {
    const parsed: ParsedQuery = { text: [], filters: [], invalid: [] };
    for (const token of tokenize(input)) {
        const m = /^(-?)([a-z]+):(.*)$/i.exec(token);
        const key = m?.[2].toLowerCase();
        if (!m) {
            parsed.text.push(token.toLowerCase());
            continue;
        }
        if (!(QUERY_KEYS as readonly string[]).includes(key!)) {
            parsed.invalid.push(token);
            continue;
        }
        const values = m[3].toLowerCase().split(",").map((v) => v.trim()).filter(Boolean);
        if (values.length === 0 || !values.every((v) => validValue(key as QueryKey, v))) {
            parsed.invalid.push(token);
            continue;
        }
        parsed.filters.push({ key: key as QueryKey, values, negate: m[1] === "-", raw: token });
    }
    return parsed;
}

function matchStatus(v: string, health: TunnelHealth): boolean {
    if (v === "up") return health === "online" || health === "degraded";
    if (v === "down") return health === "offline" || health === "never";
    return v === health;
}

function matchShared(v: string, t: Tunnel): boolean {
    if (v === "in") return !t.is_owner;
    if (v === "out") return t.is_owner && (t.shared_with_count ?? 0) > 0;
    return t.is_owner && (t.shared_with_count ?? 0) === 0;
}

function matchPort(v: string, port: number): boolean {
    if (v.startsWith(">")) return port > Number(v.slice(1));
    if (v.startsWith("<")) return port < Number(v.slice(1));
    if (v.includes("-")) {
        const [a, b] = v.split("-").map(Number);
        return port >= Math.min(a, b) && port <= Math.max(a, b);
    }
    return port === Number(v);
}

/** 連著 = 現在；從沒連過 = null。/ Connected = now; never connected = null. */
function lastSeenMs(t: Tunnel, ctx: MatchContext): number | null {
    if (ctx.health === "online" || ctx.health === "degraded") return ctx.now;
    if (ctx.health === "never" || !t.last_seen_at) return null;
    const at = Date.parse(t.last_seen_at);
    return Number.isNaN(at) ? null : at;
}

function matchLastSeen(v: string, t: Tunnel, ctx: MatchContext): boolean {
    const at = lastSeenMs(t, ctx);
    if (v === "never") return at === null;
    if (at === null) return false;
    const span = Number(v.slice(1, -1)) * UNIT_MS[v.slice(-1)];
    const age = ctx.now - at;
    return v.startsWith(">") ? age > span : age < span;
}

function matchOne(f: QueryFilter, v: string, t: Tunnel, ctx: MatchContext): boolean {
    switch (f.key) {
        case "status":
            return matchStatus(v, ctx.health);
        case "shared":
            return matchShared(v, t);
        case "port":
            return matchPort(v, t.reverse_port);
        case "lastseen":
            return matchLastSeen(v, t, ctx);
        case "ip":
            return (t.endpoint?.ip ?? "").toLowerCase().startsWith(v);
        case "user":
            return (t.presence?.sessions ?? []).some((s) => s.user.toLowerCase().includes(v));
    }
}

function matchText(term: string, t: Tunnel): boolean {
    const hay = [
        t.host_friendly_name,
        t.description ?? "",
        String(t.reverse_port),
        t.endpoint?.ip ?? "",
        ...(t.presence?.sessions ?? []).map((s) => s.user),
    ];
    return hay.some((h) => h.toLowerCase().includes(term));
}

export function matchTunnel(t: Tunnel, q: ParsedQuery, ctx: MatchContext): boolean {
    for (const term of q.text) {
        if (!matchText(term, t)) return false;
    }
    for (const f of q.filters) {
        const hit = f.values.some((v) => matchOne(f, v, t, ctx));
        if (hit === f.negate) return false;
    }
    return true;
}

export type TunnelSort = "name" | "status" | "lastseen" | "port";
export const TUNNEL_SORTS: TunnelSort[] = ["name", "status", "lastseen", "port"];

const STATUS_RANK: Record<TunnelHealth, number> = { degraded: 0, online: 1, offline: 2, never: 3 };

/**
 * 排序：status 把需要注意的（降級）放最前面，再來線上、離線、從沒連過；lastseen 由近到遠、從沒連過墊底。
 * Sorting: status puts degraded first (it needs attention), then online, offline, never; lastseen is most
 * recent first with never-connected last. Ties fall back to the name.
 */
export function compareTunnels(a: Tunnel, b: Tunnel, sort: TunnelSort, ctx: (t: Tunnel) => MatchContext): number {
    const byName = a.host_friendly_name.localeCompare(b.host_friendly_name);
    switch (sort) {
        case "name":
            return byName;
        case "port":
            return a.reverse_port - b.reverse_port;
        case "status":
            return STATUS_RANK[ctx(a).health] - STATUS_RANK[ctx(b).health] || byName;
        case "lastseen": {
            const la = lastSeenMs(a, ctx(a)) ?? -Infinity;
            const lb = lastSeenMs(b, ctx(b)) ?? -Infinity;
            return lb === la ? byName : lb > la ? 1 : -1;
        }
    }
}
