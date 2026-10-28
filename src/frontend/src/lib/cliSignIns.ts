/**
 * `telepy` CLI 的瀏覽器登入（`telepy login`）跟 MCP app 用的是同一套 OAuth 登入，所以伺服器上都是 OAuth grant。畫面上把兩者
 * 分開：CLI 登入列在 API 頁（跟 API token 一起，用量在 API 活動），MCP app 列在 MCP 頁 / 偏好設定。這裡是分類與排序的純函式。
 * 後端回 `kind`（`cli` | `app`）；較舊的後端沒有時，用 CLI 註冊的名字 `telepy CLI (<電腦>)` 判斷。`cliSignIns.test.ts` 有測試。
 * The CLI's browser sign-in (`telepy login`) uses the same OAuth sign-in as MCP apps, so both are OAuth grants on the
 * server. The UI keeps them apart: CLI sign-ins on the API page (next to API tokens, their usage in the API activity),
 * MCP apps on the MCP page / Preferences. Pure helpers to tell them apart and order them; the backend sends `kind`,
 * older backends fall back to the CLI's registered name.
 */
import { cliHost } from "./cliClient.ts";

/** 同時保留幾個 CLI 登入（後端 `oauth::MAX_CLI_SIGNINS`）；再多一個時最久沒用的那個自動登出。/ Mirrors the backend limit. */
export const CLI_SIGNIN_LIMIT = 10;

export interface GrantLike {
    id: number;
    client_name: string;
    kind?: "cli" | "app" | string;
    cli_host?: string | null;
    created_at: string;
    last_used_at: string | null;
}

export function isCliGrant(g: Pick<GrantLike, "client_name" | "kind">): boolean {
    return g.kind === "cli" || g.kind === "app" ? g.kind === "cli" : cliHost(g.client_name) !== null;
}

/** CLI 登入的電腦名稱（可能空字串 = 沒報）；不是 CLI = null。/ The CLI sign-in's computer ("" = unnamed); null for apps. */
export function grantHost(g: Pick<GrantLike, "client_name" | "kind" | "cli_host">): string | null {
    if (!isCliGrant(g)) return null;
    return g.cli_host ?? cliHost(g.client_name) ?? "";
}

/** 最後活動：用過就是最後使用時間，否則是登入時間。/ Last activity: the last use, else when it signed in. */
export function lastActivity(g: Pick<GrantLike, "created_at" | "last_used_at">): string {
    return g.last_used_at ?? g.created_at;
}

/** 分成 CLI 登入（最近用過的在前）與 MCP app（照伺服器順序）。/ CLI sign-ins (most recent first) and MCP apps. */
export function splitGrants<T extends GrantLike>(grants: readonly T[]): { cli: T[]; apps: T[] } {
    const cli = grants.filter((g) => isCliGrant(g)).sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || b.id - a.id);
    const apps = grants.filter((g) => !isCliGrant(g));
    return { cli, apps };
}

/**
 * 加一個新的 CLI 登入時，哪些會被登出（跟後端 `oauth::cli_overflow` 同一條規則：新的留下，其餘依最近活動留 `limit - 1` 個）。
 * 同意頁用它說「會登出 X」，清單用它標出「下一個要被登出的」。
 * Which sign-ins one more would sign out (the backend's rule): the new one stays, then the `limit - 1` most recent.
 */
export function overflowOnNext<T extends GrantLike>(signIns: readonly T[], limit = CLI_SIGNIN_LIMIT): T[] {
    const sorted = [...signIns].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || b.id - a.id);
    return sorted.slice(Math.max(0, limit - 1));
}
