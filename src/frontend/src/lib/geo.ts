/**
 * IP 的位址範圍與地理資訊（後端離線 GeoIP 的結果）：國旗、依語系的國家名稱、非公網位址判斷。
 * Address scope and geolocation (from the backend's offline GeoIP): flag, localized country name, and
 * whether the address is a public one.
 */

/** 後端 `geo` 物件。/ The backend's `geo` object. */
export interface IpGeo {
    /** public / private / loopback / link_local / shared_nat / reserved */
    scope: string;
    /** ISO 3166-1 alpha-2 */
    country: string | null;
    org: string | null;
    asn: number | null;
    /** DB-IP / MaxMind（顯示出處）。/ Data source, for attribution. */
    source: string | null;
}

/** "TW" → 🇹🇼（區域指示符號）。/ Country code → flag emoji (regional indicator symbols). */
export function flagEmoji(code: string | null | undefined): string {
    if (!code || !/^[A-Za-z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** 依語系的國家名稱（Intl.DisplayNames，不需要字典）。/ Localized country name via Intl.DisplayNames. */
export function countryName(code: string | null | undefined, locale: string): string | null {
    if (!code) return null;
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? code;
    } catch {
        return code;
    }
}

/** 不是公網位址（私有、loopback、CGNAT…）：真實來源被前面的代理遮住了，或根本在同一個網路裡。/ Not a public address. */
export function isNonPublic(geo: IpGeo | null | undefined): boolean {
    return !!geo && geo.scope !== "public";
}

/**
 * 裝置真正的對外 IP：裝置 / 查詢網址回報的公網 IP，不然是 gateway 看到的來源（只在它是公網位址時）；都不是 = null（不明）。
 * 不拿代理 / Docker 的內部位址充當裝置的 IP。
 * The device's real public IP: the reported one, else the gateway's peer when that is public; null = unknown.
 */
export function devicePublicIp(endpoint: { ip: string; public_ip?: string | null; geo?: IpGeo | null } | null | undefined): string | null {
    if (!endpoint) return null;
    if (endpoint.public_ip) return endpoint.public_ip;
    return isNonPublic(endpoint.geo) ? null : endpoint.ip;
}

/** 「台灣 · Chunghwa Telecom」；沒有資料回 null。/ "Taiwan · Chunghwa Telecom", or null without data. */
export function placeLabel(geo: IpGeo | null | undefined, locale: string): string | null {
    if (!geo) return null;
    const parts = [countryName(geo.country, locale), geo.org].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
}
