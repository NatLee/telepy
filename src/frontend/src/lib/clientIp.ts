/**
 * 「Telepy 怎麼看你的位址」（`GET /api/auth/client-ip-check`，管理員）：解析回應、路徑圖每一站的狀態、
 * 「拿假位址試試看」的判讀。純函式，有測試。
 * The admin's "How Telepy sees your address" check: parse the response, the state of every stop on the path
 * diagram, and how to read the made-up-address test. Pure, tested.
 */
import type { SpotState } from "./flow.ts";

export type AddressScope = "public" | "private" | "loopback" | "link_local" | "shared_nat" | "reserved";
export type HopRole = "ignored" | "client" | "proxy";
export type Verdict = "ok" | "hops_too_low" | "hops_too_high" | "use_header" | "header_private" | "all_private" | "unknown";

export interface ChainHop {
    ip: string;
    scope: string;
    source: "forwarded_for" | "peer";
    role: HopRole;
}

export interface HeaderSeen {
    name: string;
    value: string;
    addresses: { ip: string; scope: string }[];
}

export interface ClientIpCheck {
    ip: string | null;
    scope: string | null;
    from: "chain" | "header" | null;
    trustedProxyHops: number;
    clientIpHeader: string | null;
    chain: ChainHop[];
    headers: HeaderSeen[];
    verdict: Verdict;
    suggestHops: number | null;
    suggestHeader: string | null;
    shortChain: boolean;
    headerAbsent: boolean;
}

const VERDICTS: Verdict[] = ["ok", "hops_too_low", "hops_too_high", "use_header", "header_private", "all_private", "unknown"];
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** 後端 JSON → 型別；形狀不對回 null。/ Backend JSON → typed; null when the shape is wrong. */
export function parseClientIpCheck(raw: unknown): ClientIpCheck | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.chain)) return null;
    const chain: ChainHop[] = r.chain.flatMap((h) => {
        const o = (h ?? {}) as Record<string, unknown>;
        const ip = str(o.ip);
        if (!ip) return [];
        const role: HopRole = o.role === "ignored" || o.role === "client" ? o.role : "proxy";
        return [{ ip, scope: str(o.scope) ?? "reserved", source: o.source === "peer" ? "peer" : "forwarded_for", role } satisfies ChainHop];
    });
    const headers: HeaderSeen[] = (Array.isArray(r.headers) ? r.headers : []).flatMap((h) => {
        const o = (h ?? {}) as Record<string, unknown>;
        const name = str(o.name);
        if (!name) return [];
        const addresses = (Array.isArray(o.addresses) ? o.addresses : []).flatMap((a) => {
            const x = (a ?? {}) as Record<string, unknown>;
            const ip = str(x.ip);
            return ip ? [{ ip, scope: str(x.scope) ?? "reserved" }] : [];
        });
        return [{ name, value: typeof o.value === "string" ? o.value : "", addresses }];
    });
    const suggest = (r.suggest ?? {}) as Record<string, unknown>;
    const verdict = VERDICTS.includes(r.verdict as Verdict) ? (r.verdict as Verdict) : "unknown";
    return {
        ip: str(r.ip),
        scope: str(r.scope),
        from: r.from === "chain" || r.from === "header" ? r.from : null,
        trustedProxyHops: int(r.trusted_proxy_hops) ?? 0,
        clientIpHeader: str(r.client_ip_header),
        chain,
        headers,
        verdict,
        suggestHops: int(suggest.trusted_proxy_hops),
        suggestHeader: str(suggest.client_ip_header),
        shortChain: r.short_chain === true,
        headerAbsent: r.header_absent === true,
    };
}

export const isPublicScope = (scope: string | null | undefined) => scope === "public";

/** 一站的狀態：選中的那段 = 公網綠、內部紅；其他站中性。/ A stop's state on the diagram. */
export function hopState(hop: ChainHop): SpotState {
    if (hop.role !== "client") return "waiting";
    return isPublicScope(hop.scope) ? "ok" : "failed";
}

/** 結果好不好（路徑圖兩端與 Telepy 那站用）。/ Whether the check passed. */
export const checkPassed = (c: ClientIpCheck) => c.verdict === "ok";

/**
 * 「拿假位址試試看」用的位址（RFC 5737 文件用位址，不會是真的訪客）：一個放進 X-Forwarded-For，一個放進 X-Real-IP。
 * Made-up addresses for the spoof test (RFC 5737 documentation range): one in X-Forwarded-For, one in X-Real-IP.
 */
export const PROBE_FORWARDED_FOR = "203.0.113.77";
export const PROBE_REAL_IP = "203.0.113.78";

export const probeHeaders = (): Record<string, string> => ({ "X-Forwarded-For": PROBE_FORWARDED_FOR, "X-Real-IP": PROBE_REAL_IP });

export type ProbeOutcome = "safe" | "forwarded_for" | "real_ip";

/**
 * 帶著假標頭的那次檢查：Telepy 記下的若是假位址 = 訪客能自己選要被記成什麼位址。X-Real-IP 被採用 = 前面的代理
 * （nginx real_ip / Nginx Proxy Manager）信任了訪客送的標頭；X-Forwarded-For 被採用 = TRUSTED_PROXY_HOPS 算多了。
 * Reading the check sent with made-up headers: if Telepy took a made-up address, a visitor can choose the address
 * that gets recorded. X-Real-IP taken = the proxy in front trusts the visitor's header; X-Forwarded-For taken =
 * TRUSTED_PROXY_HOPS counts more proxies than there are.
 */
export function probeOutcome(c: ClientIpCheck): ProbeOutcome {
    if (c.ip === PROBE_REAL_IP) return "real_ip";
    if (c.ip === PROBE_FORWARDED_FOR) return "forwarded_for";
    return "safe";
}
