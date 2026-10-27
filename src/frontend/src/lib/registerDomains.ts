/**
 * 允許註冊的 email 網域（站台設定 `valid_register_domains`）：正規化、驗證、加入多個、以及「這個信箱能不能用 Google 登入」。
 * 與後端 `api::site_settings::normalize_domain` / `db::settings::register_domains` / `api::auth::google_sign_in` 一致。
 * Allowed email domains (site setting `valid_register_domains`): normalising, validating, adding many at once and
 * "could this address sign in with Google". Mirrors the backend functions named above.
 */

/** 存的字串長度上限。/ Limit of the stored string. */
export const DOMAINS_MAX = 512;
/** 清單空白時後端使用的預設（`Config.default_register_domains`）。/ What the backend falls back to when the list is blank. */
export const DEFAULT_DOMAINS: readonly string[] = ["gmail.com"];

export type DomainProblem = "empty" | "wildcard" | "unicode" | "tooLong" | "noDot" | "emptyPart" | "partTooLong" | "badChar" | "hyphen" | "numericTld";

export type DomainResult = { ok: true; domain: string } | { ok: false; reason: DomainProblem };

/** 一個值 → 網域：小寫、去掉 `@` 前面的部分與結尾的點，再驗證主機名稱。/ One value → a domain, or why not. */
export function normalizeDomain(raw: string): DomainResult {
    let d = raw.trim();
    const at = d.lastIndexOf("@");
    if (at >= 0) d = d.slice(at + 1);
    d = d.trim().replace(/\.+$/, "").toLowerCase();
    if (!d) return { ok: false, reason: "empty" };
    if (d.includes("*")) return { ok: false, reason: "wildcard" };
    if (/[^\x00-\x7f]/.test(d)) return { ok: false, reason: "unicode" };
    if (d.length > 253) return { ok: false, reason: "tooLong" };
    if (!d.includes(".")) return { ok: false, reason: "noDot" };
    const labels = d.split(".");
    for (const label of labels) {
        if (!label) return { ok: false, reason: "emptyPart" };
        if (label.length > 63) return { ok: false, reason: "partTooLong" };
        if (!/^[a-z0-9-]+$/.test(label)) return { ok: false, reason: "badChar" };
        if (label.startsWith("-") || label.endsWith("-")) return { ok: false, reason: "hyphen" };
    }
    if (/^[0-9]+$/.test(labels[labels.length - 1])) return { ok: false, reason: "numericTld" };
    return { ok: true, domain: d };
}

/** 貼上的一大段文字 → 各個值（逗號、分號、空白、換行）。/ Pasted text → its values. */
export function splitInput(raw: string): string[] {
    return raw.split(/[\s,;]+/).filter(Boolean);
}

/** 存好的字串 → 清單（後端的切法：逗號、去空白、小寫）。/ The stored string → a list, the way the backend splits it. */
export function parseStored(stored: string): string[] {
    return stored.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export function joinDomains(list: readonly string[]): string {
    return list.join(",");
}

export interface AddResult {
    list: string[];
    added: string[];
    /** 本來就在清單裡的。/ Already in the list. */
    duplicates: string[];
    rejected: { value: string; reason: DomainProblem }[];
}

/** 加入一段輸入（可能很多個）：壞的挑出來、重複的略過，其餘接在後面。/ Add input: bad ones set aside, repeats skipped. */
export function addDomains(current: readonly string[], raw: string): AddResult {
    const list = [...current];
    const added: string[] = [];
    const duplicates: string[] = [];
    const rejected: AddResult["rejected"] = [];
    for (const value of splitInput(raw)) {
        const r = normalizeDomain(value);
        if (!r.ok) rejected.push({ value, reason: r.reason });
        else if (list.includes(r.domain)) duplicates.push(r.domain);
        else {
            list.push(r.domain);
            added.push(r.domain);
        }
    }
    return { list, added, duplicates, rejected };
}

/** 存起來的長度（字元）。/ Length of the stored text. */
export function storedLength(list: readonly string[]): number {
    return [...joinDomains(list)].length;
}

export function fitsLimit(list: readonly string[]): boolean {
    return storedLength(list) <= DOMAINS_MAX;
}

export type AddressCheck =
    | { kind: "invalid" }
    | { kind: "allowed" | "blocked"; domain: string; usingDefault: boolean };

/**
 * 這個信箱的 Google 登入會不會被網域清單放行（網域要完全相符，子網域不算；清單空白時用預設）。
 * 就算信箱的帳號已經存在也要通過這一關；新帳號還需要「開放註冊」。
 * Would the list let this address's Google sign-in through — exact domain, subdomains don't count, blank list = the
 * default. Existing accounts pass this gate too; a new account also needs registration to be open.
 */
export function checkAddress(address: string, list: readonly string[]): AddressCheck {
    const a = address.trim();
    const at = a.indexOf("@");
    if (at <= 0 || at === a.length - 1) return { kind: "invalid" };
    const domain = a.slice(at + 1).toLowerCase();
    const usingDefault = list.length === 0;
    const effective = usingDefault ? DEFAULT_DOMAINS : list;
    return { kind: effective.includes(domain) ? "allowed" : "blocked", domain, usingDefault };
}

/** 被擋下的網域是不是清單裡某個網域的子網域（提示用）。/ The blocked domain's parent in the list, when it is a subdomain of one. */
export function parentInList(domain: string, list: readonly string[]): string | null {
    return list.find((d) => domain.endsWith(`.${d}`)) ?? null;
}

/** 清單判斷需要的帳號欄位。/ The account fields the list is judged on. */
export interface DomainAccount {
    id: number;
    username: string;
    email: string;
    is_active: boolean;
}

function emailDomain(email: string): string | null {
    const at = email.trim().indexOf("@");
    if (at <= 0 || at === email.trim().length - 1) return null;
    return email.trim().slice(at + 1).toLowerCase();
}

function allows(list: readonly string[], domain: string): boolean {
    return (list.length === 0 ? DEFAULT_DOMAINS : list).includes(domain);
}

/**
 * 改清單後，哪些「現在可以、之後會被擋」的啟用中帳號（用 email 的網域判斷；空清單 = 預設）。停用的帳號本來就不能登入。
 * After a change: the active accounts that the current list lets through and the next one refuses (judged by their
 * email's domain; an empty list = the default). Disabled accounts cannot sign in anyway.
 */
export function newlyRefused<T extends DomainAccount>(accounts: readonly T[], current: readonly string[], next: readonly string[]): T[] {
    return accounts.filter((a) => {
        if (!a.is_active) return false;
        const d = emailDomain(a.email);
        return d !== null && allows(current, d) && !allows(next, d);
    });
}

/** 有多少啟用中的帳號用這個網域的 email。/ How many active accounts have an email on this domain. */
export function coverage(accounts: readonly DomainAccount[], domain: string): number {
    return accounts.filter((a) => a.is_active && emailDomain(a.email) === domain).length;
}
