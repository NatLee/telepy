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

export type HopsMode = "auto" | "fixed";

export type CloudflareMode = "auto" | "always" | "off";

/**
 * Cloudflare 的 CF-Connecting-IP 這次怎麼處理：模式、收到的值、有沒有看到 Cloudflare 自己的位址、有沒有採用。
 * How CF-Connecting-IP was handled: the mode, the header's value, whether a Cloudflare edge address was seen,
 * and whether the header was used.
 */
export interface CloudflareInfo {
    mode: CloudflareMode;
    header: string | null;
    edgeSeen: boolean;
    used: boolean;
}

export interface ClientIpCheck {
    ip: string | null;
    scope: string | null;
    from: "chain" | "header" | null;
    /** `auto` = 內部位址都算代理；`fixed` = `TRUSTED_PROXY_HOPS` 是數字。/ Automatic, or a fixed count. */
    hopsMode: HopsMode;
    /** 固定層數；自動模式是 null。/ The fixed count; null in auto mode. */
    trustedProxyHops: number | null;
    /** 這個請求實際被當成代理跳過的段數。/ Entries skipped as proxies on this request. */
    skippedHops: number;
    clientIpHeader: string | null;
    chain: ChainHop[];
    headers: HeaderSeen[];
    verdict: Verdict;
    suggestHops: number | null;
    suggestHeader: string | null;
    shortChain: boolean;
    headerAbsent: boolean;
    /** 舊後端沒有。/ Absent from older backends. */
    cloudflare: CloudflareInfo | null;
    /**
     * 有 Cloudflare 標頭卻看不到 Cloudflare 的位址（自動模式）：前面的代理把它換掉了，自動模式不敢信。
     * The Cloudflare header arrived but no Cloudflare address is visible (auto mode): a proxy in front replaced it.
     */
    cloudflareMasked: boolean;
}

/** 設定頁上改這些的地方。/ Where these are changed on the settings page. */
export const VISITOR_SETTINGS_HREF = "/tunnels/settings?tab=server#visitor-addresses";

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
    const cloudflare = parseCloudflare(r.cloudflare);
    // 後端在 hints 裡說；沒有 hints 的回應（較舊 / 別的形狀）就從 cloudflare 區塊推（自動 + 有標頭 + 沒看到 Cloudflare）。
    // The backend says so in hints; without a hints list, derive it from the cloudflare block (auto + header + no edge).
    const cloudflareMasked =
        r.cloudflare_masked === true ||
        (Array.isArray(r.hints)
            ? r.hints.includes("cloudflare_masked")
            : !!cloudflare && cloudflare.mode === "auto" && !!cloudflare.header && !cloudflare.edgeSeen);
    const verdict = VERDICTS.includes(r.verdict as Verdict) ? (r.verdict as Verdict) : "unknown";
    return {
        ip: str(r.ip),
        scope: str(r.scope),
        from: r.from === "chain" || r.from === "header" ? r.from : null,
        // 舊後端沒有 hops_mode：有數字就是固定。/ An older backend has no hops_mode: a number means fixed.
        hopsMode: r.hops_mode === "auto" || (r.hops_mode === undefined && int(r.trusted_proxy_hops) === null) ? "auto" : "fixed",
        trustedProxyHops: int(r.trusted_proxy_hops),
        skippedHops: int(r.skipped_hops) ?? 0,
        clientIpHeader: str(r.client_ip_header),
        chain,
        headers,
        verdict,
        suggestHops: int(suggest.trusted_proxy_hops),
        suggestHeader: str(suggest.client_ip_header),
        shortChain: r.short_chain === true,
        headerAbsent: r.header_absent === true,
        cloudflare,
        cloudflareMasked,
    };
}

function parseCloudflare(raw: unknown): CloudflareInfo | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const mode: CloudflareMode = o.mode === "always" || o.mode === "off" ? o.mode : "auto";
    return { mode, header: str(o.header), edgeSeen: o.edge_seen === true, used: o.used === true };
}

export const isPublicScope = (scope: string | null | undefined) => scope === "public";

/** 設定值的寫法：`auto` 或層數。/ The setting as written: `auto` or the count. */
export const hopsSetting = (c: ClientIpCheck) => (c.hopsMode === "auto" ? "auto" : String(c.trustedProxyHops ?? 0));

/**
 * CDN 自己設定的來源標頭。一個都沒收到 = 這個請求沒經過 CDN（例如 Cloudflare 的記錄是「僅 DNS」灰雲），這時設
 * CLIENT_IP_HEADER 只會讓訪客能自己寫位址。
 * Headers a CDN sets itself. None of them arriving means the request did not pass a CDN (a Cloudflare record set
 * to DNS only, say), and CLIENT_IP_HEADER would then only let visitors write their own address.
 */
export const CDN_HEADERS: readonly string[] = ["cf-connecting-ip", "true-client-ip", "fastly-client-ip", "cloudfront-viewer-address", "x-azure-clientip", "fly-client-ip", "do-connecting-ip"];

export const viaCdn = (c: ClientIpCheck) => c.headers.some((h) => CDN_HEADERS.includes(h.name.toLowerCase()));

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

export type ProbeOutcome = "safe" | "forwarded_for" | "auto_internal" | "real_ip";

/**
 * 帶著假標頭的那次檢查：Telepy 記下的若是假位址 = 訪客能自己選要被記成什麼位址。X-Real-IP 被採用 = 前面的代理
 * （nginx real_ip / Nginx Proxy Manager）信任了訪客送的標頭；X-Forwarded-For 被採用 = 固定層數算多了，或自動模式下
 * 你自己就在內網（內部位址都算代理，所以越過了你的位址）——只有內網的訪客能這樣，而且只能改自己被記成什麼。
 * Reading the check sent with made-up headers: if Telepy took a made-up address, a visitor can choose the address
 * that gets recorded. X-Real-IP taken = the proxy in front trusts the visitor's header; X-Forwarded-For taken =
 * a fixed count counts more proxies than there are, or, in auto mode, you are on an internal address yourself
 * (every internal address counts as a proxy, so yours was skipped) — only internal visitors can, and only for
 * their own record.
 */
export function probeOutcome(c: ClientIpCheck): ProbeOutcome {
    if (c.ip === PROBE_REAL_IP) return "real_ip";
    if (c.ip === PROBE_FORWARDED_FOR) return c.hopsMode === "auto" ? "auto_internal" : "forwarded_for";
    return "safe";
}
