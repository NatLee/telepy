/**
 * 「你的裝置」的純邏輯：session 排序 / 依裝置分組、效期換成人話的單位，以及說明圖的資料（純函式，有測試）。
 * Pure helpers for "Your devices": ordering and grouping sessions by device, lifetimes in readable units, and
 * the model behind the explainer diagram (pure, tested).
 */
import { parseUserAgent } from "./userAgent.ts";
import type { IpGeo } from "./geo.ts";

export interface WebSessionRow {
    id: number;
    ip: string | null;
    geo?: IpGeo | null;
    user_agent: string | null;
    device?: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    current: boolean;
    sign_in_method: string | null;
    mfa_method: string | null;
}

export interface WebSessionList {
    sessions: WebSessionRow[];
    /** 秒：多久沒用就要重新登入（網站設定 `signin_lifetime`）。/ Seconds of no use before a sign-in ends. */
    signin_lifetime: number;
    /** 秒：access token 多久換一次（`signin_access_lifetime`）。/ Seconds between access-token renewals. */
    access_lifetime: number;
}

export type DeviceKind = "phone" | "computer" | "unknown";

/** 手機 / 電腦（決定圖示）。/ Phone or computer, for the icon. */
export function deviceKind(ua: string | null | undefined): DeviceKind {
    const { os } = parseUserAgent(ua);
    if (os === "iOS" || os === "Android") return "phone";
    if (os) return "computer";
    return "unknown";
}

export interface DeviceGroup {
    /** 「瀏覽器 · 作業系統」；認不出來為 null。/ "browser · OS"; null when unrecognised. */
    label: string | null;
    kind: DeviceKind;
    /** 這組裡有這個瀏覽器。/ This browser is in the group. */
    current: boolean;
    sessions: WebSessionRow[];
}

const time = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
};

/** 這個瀏覽器排第一，其餘最近用過的在前。/ This browser first, then the most recently used. */
export function orderSessions(rows: WebSessionRow[]): WebSessionRow[] {
    return [...rows].sort((a, b) => Number(b.current) - Number(a.current) || time(b.last_seen_at) - time(a.last_seen_at) || b.id - a.id);
}

function labelOf(row: WebSessionRow): string | null {
    const { browser, os } = parseUserAgent(row.user_agent);
    const parts = [browser, os].filter(Boolean);
    return parts.length ? parts.join(" · ") : row.device ?? null;
}

/**
 * 同一種瀏覽器 + 系統的 session 放一組（同一台電腦的兩個設定檔、手機換了網路後重登…）；有這個瀏覽器的那組排第一，
 * 其餘依組內最近一次使用。組內也是 `orderSessions` 的順序。
 * Group sessions by browser + OS (two profiles on one computer, a phone that signed in again…). The group with
 * this browser comes first, the rest by their latest use; sessions inside follow `orderSessions`.
 */
export function groupSessions(rows: WebSessionRow[]): DeviceGroup[] {
    const groups = new Map<string, DeviceGroup>();
    for (const row of orderSessions(rows)) {
        const label = labelOf(row);
        const key = label ?? "\u0000unknown";
        let g = groups.get(key);
        if (!g) {
            g = { label, kind: deviceKind(row.user_agent), current: false, sessions: [] };
            groups.set(key, g);
        }
        g.sessions.push(row);
        g.current ||= row.current;
    }
    // Map 保留插入順序，而第一筆就是最新的（或這個瀏覽器），所以已經排好了。
    // Insertion order is already right: rows arrive current-first, then newest first.
    return [...groups.values()];
}

export type LifetimeUnit = "days" | "hours" | "minutes" | "seconds";

/** 秒數換成最大的整數單位（30 天、1 小時、90 分鐘）。/ Seconds in the largest whole unit (30 days, 1 hour, 90 minutes). */
export function lifetimeParts(seconds: number): { value: number; unit: LifetimeUnit } {
    const s = Math.max(0, Math.round(seconds));
    if (s >= 86_400 && s % 86_400 === 0) return { value: s / 86_400, unit: "days" };
    if (s >= 3_600 && s % 3_600 === 0) return { value: s / 3_600, unit: "hours" };
    if (s >= 60 && s % 60 === 0) return { value: s / 60, unit: "minutes" };
    if (s >= 86_400) return { value: Math.round(s / 86_400), unit: "days" };
    if (s >= 3_600) return { value: Math.round(s / 3_600), unit: "hours" };
    if (s >= 60) return { value: Math.round(s / 60), unit: "minutes" };
    return { value: s, unit: "seconds" };
}

export interface SessionDiagram {
    /** access token 多久換一次（秒）。/ Seconds between renewals. */
    accessSeconds: number;
    /** 多久沒用就結束（秒）。/ Seconds of no use before the sign-in ends. */
    signinSeconds: number;
    /** 這個瀏覽器的 session（列表裡沒有 = 升級前的登入或管理員在看別人）。/ This browser's session, if listed. */
    current: WebSessionRow | null;
    /** 這個瀏覽器還剩多久（秒，沒有再用的話）。/ Seconds left for this browser without further use. */
    currentLeft: number | null;
    /** 其他瀏覽器數量與前幾個名字。/ How many other browsers, and the first few names. */
    others: number;
    otherLabels: string[];
    /** 沒列出名字的其他裝置種類數（> 0 才顯示「…」）。/ Device types left out of `otherLabels`. */
    moreDevices: number;
    /** 每天大約續期幾次（一直開著的分頁）。/ Renewals per day for a tab left open. */
    renewalsPerDay: number;
}

/** 說明圖要畫的東西：兩個效期、這個瀏覽器、其他瀏覽器。/ What the explainer draws. */
export function sessionDiagram(list: WebSessionList, now: number = Date.now(), maxLabels = 3): SessionDiagram {
    const current = list.sessions.find((s) => s.current) ?? null;
    const others = list.sessions.filter((s) => !s.current);
    const groups = groupSessions(others);
    const labels = groups.map((g) => {
        const name = g.label ?? "?";
        return g.sessions.length > 1 ? `${name} ×${g.sessions.length}` : name;
    });
    const access = Math.max(1, list.access_lifetime);
    return {
        accessSeconds: list.access_lifetime,
        signinSeconds: list.signin_lifetime,
        current,
        currentLeft: current ? Math.max(0, Math.round((time(current.expires_at) - now) / 1000)) : null,
        others: others.length,
        otherLabels: labels.slice(0, maxLabels),
        moreDevices: Math.max(0, labels.length - maxLabels),
        renewalsPerDay: Math.round(86_400 / access),
    };
}

const INTL_UNIT: Record<LifetimeUnit, string> = { days: "day", hours: "hour", minutes: "minute", seconds: "second" };

/** 「30 天」「1 hour」「90 分」：Intl 依 locale 產生，不用字典。/ A lifetime in words via Intl, no dictionary. */
export function formatLifetime(seconds: number, locale: string): string {
    const { value, unit } = lifetimeParts(seconds);
    try {
        return new Intl.NumberFormat(locale, { style: "unit", unit: INTL_UNIT[unit], unitDisplay: "long" }).format(value);
    } catch {
        return `${value} ${unit}`;
    }
}
