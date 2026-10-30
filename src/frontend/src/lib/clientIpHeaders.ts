/**
 * 「訪客位址標頭」的選項：常見 CDN / 代理把訪客位址放在哪個標頭（名字查過各家文件），加上管理員自己這次請求實際
 * 帶了哪些（`/api/auth/client-ip-check` 的 `headers`）。純函式，有測試；測試會讀後端的 `CANDIDATE_HEADERS`，
 * 這裡列的每個標頭後端都會在位址檢查裡回報。
 * Options for the visitor-address header: where common CDNs and proxies put the visitor's address (names checked
 * against each vendor's docs), plus the headers the admin's own request actually carried (`headers` of
 * `/api/auth/client-ip-check`). Pure, tested; the test reads the backend's `CANDIDATE_HEADERS`, so the address check
 * reports every header listed here.
 */
import type { HeaderSeen } from "./clientIp.ts";

export type KnownHeaderId = "cloudflare" | "trueClient" | "fastly" | "cloudfront" | "azure" | "fly" | "digitalocean" | "realIp" | "clientIp" | "cluster";

export interface KnownHeader {
    id: KnownHeaderId;
    /** 文件裡的寫法（比對時不分大小寫）。/ As the vendor writes it (matched case-insensitively). */
    name: string;
    /** CDN / 平台的邊緣自己設的（不是你架的代理）。/ Set by a CDN or platform edge rather than a proxy you run. */
    edge: boolean;
    /** 有條件才安全（訪客自己送的值可能被照傳）。/ Safe only under a condition (a visitor's own value may pass through). */
    caution: boolean;
}

export const KNOWN_HEADERS: readonly KnownHeader[] = [
    { id: "cloudflare", name: "CF-Connecting-IP", edge: true, caution: false },
    { id: "trueClient", name: "True-Client-IP", edge: true, caution: false },
    { id: "fastly", name: "Fastly-Client-IP", edge: true, caution: true },
    { id: "cloudfront", name: "CloudFront-Viewer-Address", edge: true, caution: false },
    { id: "azure", name: "X-Azure-ClientIP", edge: true, caution: false },
    { id: "fly", name: "Fly-Client-IP", edge: true, caution: false },
    { id: "digitalocean", name: "DO-Connecting-IP", edge: true, caution: false },
    { id: "realIp", name: "X-Real-IP", edge: false, caution: true },
    { id: "clientIp", name: "X-Client-IP", edge: false, caution: true },
    { id: "cluster", name: "X-Cluster-Client-IP", edge: false, caution: true },
];

export function knownHeader(name: string): KnownHeader | undefined {
    const n = name.trim().toLowerCase();
    return KNOWN_HEADERS.find((h) => h.name.toLowerCase() === n);
}

/** CDN / 平台自己設的標頭（小寫）；一個都沒收到 = 這個請求沒經過 CDN。/ Edge-set headers, lower case; none = no CDN on the way. */
export const EDGE_HEADERS: readonly string[] = KNOWN_HEADERS.filter((h) => h.edge).map((h) => h.name.toLowerCase());

/** 標頭名合不合 HTTP token 規則（跟後端存檔時的檢查一樣）。/ Whether a header name is an HTTP token (the backend's save check). */
export const isHeaderName = (s: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(s.trim());

export interface HeaderChoice {
    /** 要存的名字：認得的用文件寫法，否則用收到的。/ The name to save: the vendor's spelling when known, else as received. */
    name: string;
    known: KnownHeader | null;
    /** 這次請求帶了它（以及裡面的位址）。/ This request carried it (and these addresses). */
    seen: HeaderSeen | null;
    /** 目前存的就是它。/ It is the saved choice. */
    current: boolean;
}

/**
 * 給設定列的選項：這次收到的在前（帶公網位址的最前），再來是其他認得的；`Forwarded` 是一條鏈（像 X-Forwarded-For），
 * 不當單一來源，不列。
 * The choices for the setting: headers this request carried first (public addresses first), then the other known
 * ones. `Forwarded` is a chain like X-Forwarded-For, not a single source, so it is left out.
 */
export function headerChoices(seen: readonly HeaderSeen[], current: string): HeaderChoice[] {
    const cur = current.trim().toLowerCase();
    const arrived = seen
        .filter((h) => h.name.toLowerCase() !== "forwarded")
        .map((h) => {
            const known = knownHeader(h.name) ?? null;
            return { name: known?.name ?? h.name, known, seen: h, current: !!cur && h.name.toLowerCase() === cur };
        })
        .sort((a, b) => Number(hasPublic(b.seen)) - Number(hasPublic(a.seen)));
    const rest = KNOWN_HEADERS.filter((k) => !arrived.some((a) => a.name.toLowerCase() === k.name.toLowerCase())).map((k) => ({
        name: k.name,
        known: k,
        seen: null,
        current: k.name.toLowerCase() === cur,
    }));
    return [...arrived, ...rest];
}

const hasPublic = (h: HeaderSeen) => h.addresses.some((a) => a.scope === "public");
