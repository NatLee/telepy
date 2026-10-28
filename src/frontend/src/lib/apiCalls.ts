/**
 * API 頁「活動」的純函式：委派 token 呼叫紀錄（`GET /api/auth/tokens/calls`）的型別、狀態分類（ok / 4xx / 5xx）、
 * 方法 / 狀態 / 搜尋篩選與計數，以及總覽圖「三條進 Telepy 的路，撤銷哪一個切掉哪一條」的狀態。`apiCalls.test.ts` 有測試。
 * Pure helpers for the API page's activity: the call-log row type, status classes, the method / status / search
 * filters with counts, and the overview diagram's "three ways in, and what each revoke cuts".
 */
import type { SpotState } from "./flow.ts";

export interface ApiCall {
    id: number;
    at: string;
    user: { id: number; username: string | null };
    token: { id: number; name: string | null; prefix: string | null } | null;
    grant_id: number | null;
    client_name: string;
    /** rest | mcp */
    kind: string;
    /** HTTP 方法，或 MCP（tool call）。/ The HTTP method, or MCP for a tool call. */
    method: string;
    /** 路由樣板或 MCP tool 名稱。/ The route template or the MCP tool. */
    route: string;
    tunnel: { id: number; name: string | null } | null;
    status: number;
    duration_ms: number;
    ip: string | null;
    error: string | null;
}

export interface ApiCallPage {
    calls: ApiCall[];
    limit: number;
    has_more: boolean;
    dropped: number | null;
}

export type StatusClass = "ok" | "4xx" | "5xx";
export const STATUS_FILTERS = ["all", "ok", "4xx", "5xx"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const METHOD_FILTERS = ["all", "GET", "POST", "PUT", "PATCH", "DELETE", "MCP"] as const;
export type MethodFilter = (typeof METHOD_FILTERS)[number];

export function statusClass(status: number): StatusClass {
    return status >= 500 ? "5xx" : status >= 400 ? "4xx" : "ok";
}

/** 每個字都要出現在方法、路由、狀態、token / app 名稱、隧道、IP、使用者或錯誤裡。/ Every word must appear somewhere. */
export function callMatches(c: ApiCall, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = [c.method, c.route, String(c.status), c.client_name, c.token?.name, c.token?.prefix, c.tunnel?.name, c.ip, c.user.username, c.error].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
}

export interface CallFilters {
    query: string;
    status: StatusFilter;
    method: MethodFilter;
}

export function filterApiCalls<T extends ApiCall>(rows: readonly T[], f: CallFilters): T[] {
    return rows.filter((c) => (f.status === "all" || statusClass(c.status) === f.status) && (f.method === "all" || c.method === f.method) && callMatches(c, f.query));
}

/** 篩選列上的數字：每個狀態（套用方法 + 搜尋）、每個方法（套用狀態 + 搜尋）。/ Counts for the filter bar. */
export function countApiCalls(rows: readonly ApiCall[], f: CallFilters): { status: Record<StatusFilter, number>; method: Record<MethodFilter, number> } {
    const status = Object.fromEntries(STATUS_FILTERS.map((s) => [s, 0])) as Record<StatusFilter, number>;
    const method = Object.fromEntries(METHOD_FILTERS.map((m) => [m, 0])) as Record<MethodFilter, number>;
    for (const c of rows) {
        if (!callMatches(c, f.query)) continue;
        if (f.method === "all" || c.method === f.method) {
            status.all += 1;
            status[statusClass(c.status)] += 1;
        }
        if (f.status === "all" || statusClass(c.status) === f.status) {
            method.all += 1;
            if ((METHOD_FILTERS as readonly string[]).includes(c.method)) method[c.method as MethodFilter] += 1;
        }
    }
    return { status, method };
}

/** 毫秒 → 「12 ms」/「1.4 s」。/ Milliseconds as text. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

// ---------------------------------------------------------------- the overview: four ways in

/** `cli` = `telepy login` 的瀏覽器登入：跟 MCP app 同一套 OAuth，但自成一條（列在 API 頁）。/ The CLI's own lane. */
export type WayId = "web" | "token" | "cli" | "app";
/** 「如果我…」：什麼都不做 / 撤銷一把 token / 登出一台電腦的 CLI / 中斷一個 app / 登出這個瀏覽器。
 *  What if I…: nothing / revoke a token / sign a CLI out / disconnect an app / sign out here. */
export type WhatIf = "none" | "token" | "cli" | "app" | "web";
export const WHAT_IFS: readonly WhatIf[] = ["none", "token", "cli", "app", "web"];

export interface Way {
    id: WayId;
    /** [你那端, 憑證那一段, Telepy, Telepy → 裝置] 的狀態。/ States of [your side, the credential, Telepy, Telepy → devices]. */
    from: SpotState;
    credential: SpotState;
    telepy: SpotState;
    devices: SpotState;
    /** 被這個動作切斷了。/ Cut by the chosen action. */
    cut: boolean;
}

/**
 * 每條路各用各的鑰匙：撤銷一把 token 只切 token 那條（它開的 session / 瀏覽器一起關）、登出一台電腦的 CLI 只切 CLI、
 * 中斷 app 只切 app、登出只切這個瀏覽器；其他照常——總覽圖要說的就是這件事。
 * Each way in has its own key: revoking a token cuts only the token lane (its sessions and browsers close), signing a
 * CLI out only the CLI lane, disconnecting an app only the app lane, signing out only this browser; the rest keep working.
 */
export function waysIn(whatIf: WhatIf): Way[] {
    const order: WayId[] = ["web", "token", "cli", "app"];
    return order.map((id) => {
        const cut = whatIf === id;
        return cut ? { id, from: "ok", credential: "failed", telepy: "waiting", devices: "waiting", cut } : { id, from: "ok", credential: "ok", telepy: "ok", devices: "ok", cut };
    });
}
