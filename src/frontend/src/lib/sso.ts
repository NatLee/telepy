/**
 * OIDC 單一登入的純函式：登入按鈕的網址、從身分提供者回來時網址上的票券 / 錯誤、錯誤 code → 字典 key、
 * 管理頁的網域清單與代號。後端在 `src/backend-api/src/api/oidc.rs`。
 * Pure helpers for OIDC sign-in: the button's URL, the ticket / error the callback puts on the page's URL, error
 * codes → dictionary keys, and the admin form's domain list and slug. The backend is `api/oidc.rs`.
 */
import type { TranslationKey } from "@/locales/en";

/** 登入頁上的一個單一登入按鈕。/ One single sign-on button on the sign-in page. */
export interface SsoButton {
    slug: string;
    name: string;
}

/** 公開端點的 `sso` → 按鈕（看不懂的丟掉）；不是陣列 = null（舊後端，不知道）。/ The endpoint's `sso`; null = unknown. */
export function parseSsoButtons(raw: unknown): SsoButton[] | null {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter((b): b is { slug: string; name: string } => !!b && typeof b === "object" && typeof (b as SsoButton).slug === "string" && typeof (b as SsoButton).name === "string")
        .filter((b) => /^[a-z0-9-]{1,32}$/.test(b.slug))
        .map((b) => ({ slug: b.slug, name: b.name.trim() || b.slug }));
}

/**
 * 按鈕要整頁打開的網址（不加 API base：後端回來時用相對路徑導向 `/login`，必須是同一個網址）。`next` 只收站內路徑。
 * The URL the button navigates to (no API base: the callback redirects to a relative `/login`, so it must be this
 * origin). `next` is kept only when it is a same-site path.
 */
export function ssoStartUrl(slug: string, next?: string | null): string {
    const base = `/api/auth/oidc/${encodeURIComponent(slug)}/start`;
    return next && isLocalPath(next) && next !== "/tunnels" ? `${base}?next=${encodeURIComponent(next)}` : base;
}

function isLocalPath(p: string): boolean {
    return p.startsWith("/") && !p.startsWith("//") && !p.includes("\\");
}

/** 從身分提供者回到 `/login` 時網址上帶的東西。/ What the callback leaves on `/login`'s URL. */
export interface SsoReturn {
    ticket: string | null;
    error: string | null;
    provider: string | null;
}

export function readSsoReturn(search: string): SsoReturn {
    const q = new URLSearchParams(search);
    const v = (k: string) => {
        const x = q.get(k);
        return x && x.trim() ? x.trim() : null;
    };
    return { ticket: v("sso"), error: v("sso_error"), provider: v("sso_provider") };
}

/** 處理完把那幾個參數拿掉（`next` 留著），重新整理就不會再做一次。/ Drop them once handled (`next` stays). */
export function withoutSsoParams(pathAndSearch: string): string {
    const [path, query = ""] = pathAndSearch.split("?");
    const q = new URLSearchParams(query);
    for (const k of ["sso", "sso_error", "sso_provider"]) q.delete(k);
    const rest = q.toString();
    return rest ? `${path}?${rest}` : path;
}

/** 錯誤 code → 字典 key（登入頁、`/tunnels/sso` 頁、兌換票券的回應）。/ Error codes → dictionary keys. */
export const SSO_ERROR_KEYS: Record<string, TranslationKey> = {
    sso_failed: "sso.err.failed",
    sso_unreachable: "sso.err.unreachable",
    sso_unknown: "sso.err.unknown",
    sso_expired: "sso.err.expired",
    sso_browser: "sso.err.browser",
    sso_denied: "sso.err.denied",
    sso_provider_error: "sso.err.providerError",
    sso_no_email: "sso.err.noEmail",
    sso_domain_not_allowed: "sso.err.domain",
    sso_not_linked: "sso.err.notLinked",
    sso_no_username: "sso.err.noUsername",
    sso_username_taken: "sso.err.usernameTaken",
    sso_linked_elsewhere: "sso.err.linkedElsewhere",
    sso_already_linked: "sso.err.alreadyLinked",
    sso_no_groups: "sso.err.noGroups",
    sso_group_not_allowed: "sso.err.groupNotAllowed",
    account_disabled: "login.accountDisabled",
};

export function ssoErrorKey(code: string | null | undefined): TranslationKey {
    return (code && SSO_ERROR_KEYS[code]) || "sso.err.failed";
}

/** 按鈕顯示的名字（不認得的代號就顯示代號）。/ The provider's display name (the slug when unknown). */
export function providerName(buttons: readonly SsoButton[] | null | undefined, slug: string | null): string {
    if (!slug) return "";
    return buttons?.find((b) => b.slug === slug)?.name ?? slug;
}

/** 從回呼網址的開頭算出「登出後回來的網址」（跟後端 `post_logout_url` 一樣）。/ The post-logout URL, as the backend's. */
export function postLogoutUrl(callbackBase: string): string {
    return `${callbackBase.replace(/\/api\/auth\/oidc\/?$/, "")}/login`;
}

/** 名字 → 代號（跟後端 `oidc::slugify` 一樣）。/ Name → slug (as the backend's `oidc::slugify`). */
export function slugify(name: string): string {
    let out = "";
    // 只把 ASCII 轉小寫（跟 Rust 的 to_ascii_lowercase 一樣）。/ ASCII-only lowercasing, as Rust's.
    for (const ch of name.trim()) {
        const c = /[A-Z]/.test(ch) ? ch.toLowerCase() : ch;
        if (/^[a-z0-9]$/.test(c)) out += c;
        else if (!out.endsWith("-") && out) out += "-";
        if (out.length >= 32) break;
    }
    out = out.replace(/-+$/, "");
    return out || "sso";
}

/** 網域清單：逗號 / 空白分開、去掉 @、小寫、不重複。/ The domain list: split, lowercased, de-duplicated. */
export function parseDomains(raw: string): string[] {
    const out: string[] = [];
    for (const d of raw.split(/[\s,]+/)) {
        const x = d.trim().replace(/^@+/, "").toLowerCase();
        if (x && !out.includes(x)) out.push(x);
    }
    return out;
}

/** 看起來不像網域的那個（沒有 = null）。/ The first entry that isn't a domain, if any. */
export function badDomain(domains: readonly string[]): string | null {
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    return domains.find((d) => !d.includes(".") || !d.split(".").every((l) => label.test(l))) ?? null;
}

/** 試登入時 Telepy 會怎麼做。/ What Telepy would do with a test sign-in. */
export type WouldAction = "sign_in" | "link_by_email" | "link_provisioned" | "create" | "refuse";

/** 試登入時角色會怎麼變（沒規則就沒有）。/ How roles would change in a test (absent without rules). */
export interface RoleChange {
    join: string[];
    leave: string[];
    admin: "grant" | "revoke" | "keep_last" | null;
}

export interface SsoTestResult {
    provider: { id: number; slug: string; name: string };
    claims: Record<string, unknown>;
    groups_claim?: string;
    /** 從群組 claim 讀到的；null = id_token 沒有這個 claim。/ null = no such claim. */
    groups?: string[] | null;
    would: { action: WouldAction; username?: string; code?: string; roles?: RoleChange };
}

/** 身分提供者的群組 → Telepy 角色。/ A provider group → Telepy role. */
export interface GroupRule {
    idp_group: string;
    target: "admin" | "group";
    group_id: number | null;
    /** 後端回的群組名；群組已刪 = null。/ From the backend; null when the group is gone. */
    group_name?: string | null;
}

/** 一行一個群組（去空白、去重複、空行不算）。/ One group per line: trimmed, unique, blank lines dropped. */
export function groupLines(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const g = line.trim();
        if (g && !out.includes(g)) out.push(g);
    }
    return out;
}

/** 送出前整理規則：去空白，重複的拿掉；有問題回第一個問題。/ Tidy rules before saving, or the first problem. */
export function tidyRules(rules: readonly GroupRule[]): { rules: GroupRule[]; problem: "group_name" | "target" | null } {
    const out: GroupRule[] = [];
    for (const r of rules) {
        const idp = r.idp_group.trim();
        if (!idp) return { rules: out, problem: "group_name" };
        if (r.target === "group" && r.group_id == null) return { rules: out, problem: "target" };
        const rule: GroupRule = { idp_group: idp, target: r.target, group_id: r.target === "group" ? r.group_id : null };
        if (!out.some((x) => x.idp_group === rule.idp_group && x.target === rule.target && x.group_id === rule.group_id)) out.push(rule);
    }
    return { rules: out, problem: null };
}

/** 有沒有規則會給管理員。/ Whether any rule makes people administrators. */
export function grantsAdmin(rules: readonly GroupRule[]): boolean {
    return rules.some((r) => r.target === "admin");
}

/** 規則選單的值：`admin` 或 `group:<id>`。/ The rule select's value. */
export function ruleValue(r: Pick<GroupRule, "target" | "group_id">): string {
    return r.target === "admin" ? "admin" : r.group_id == null ? "" : `group:${r.group_id}`;
}

export function fromRuleValue(v: string): Pick<GroupRule, "target" | "group_id"> {
    if (v === "admin") return { target: "admin", group_id: null };
    const id = Number(v.replace(/^group:/, ""));
    return { target: "group", group_id: Number.isFinite(id) && id > 0 ? id : null };
}

/** claim 依重要性排：先是 Telepy 會讀的，再照字母。/ Claims ordered: the ones Telepy reads first, then A–Z. */
export const READ_CLAIMS = ["sub", "email", "email_verified", "preferred_username", "name", "given_name", "family_name"] as const;

export function orderedClaims(claims: Record<string, unknown>): [string, unknown, boolean][] {
    const read: [string, unknown, boolean][] = READ_CLAIMS.filter((k) => k in claims).map((k) => [k, claims[k], true]);
    const rest: [string, unknown, boolean][] = Object.keys(claims)
        .filter((k) => !(READ_CLAIMS as readonly string[]).includes(k))
        .sort()
        .map((k) => [k, claims[k], false]);
    return [...read, ...rest];
}

/** `GET /api/auth/oidc/links`。/ Your single sign-on links. */
export interface SsoLinks {
    providers: { id: number; slug: string; name: string; enabled: boolean; linked: boolean }[];
    has_password: boolean;
    google: boolean;
    passkeys: number;
}

/**
 * 解除這個連結之後還進得來嗎：密碼、passkey、Google、別的單一登入（跟後端 `other_ways_in` 同一條規則）。
 * Whether you can still sign in after unlinking this one (the backend's `other_ways_in` rule).
 */
export function canUnlink(links: SsoLinks, providerId: number): boolean {
    return links.has_password || links.passkeys > 0 || links.google || links.providers.some((p) => p.linked && p.id !== providerId);
}
