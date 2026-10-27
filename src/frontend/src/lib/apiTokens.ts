/**
 * 個人 API token 的純函式：scope 清單（MCP 的 + tunnels:manage）、到期選項 → `expires_at`、卡片狀態、
 * 說明圖的三條路（網頁登入 / MCP app / token）與「撤銷切掉哪一段」、CLI / curl 範例。`apiTokens.test.ts` 有測試。
 * Pure helpers for personal API tokens: the scope list (MCP's plus tunnels:manage), expiry presets → `expires_at`,
 * the card state, the explainer's three lanes (web sign-in / MCP apps / token) and what a revoke cuts, and the
 * CLI / curl examples.
 */
import { addDays } from "./keyExpiry.ts";
import type { SpotState } from "./flow.ts";

/** 順序 = 後端 `auth::api_tokens::all_scopes`。/ Same order as the backend. */
export const TOKEN_SCOPES = ["tunnels:read", "ssh:exec", "ssh:files", "network:scan", "browser:use", "tunnels:manage"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** 新 token 預設勾的：只讀。/ Ticked by default for a new token: read-only. */
export const DEFAULT_SCOPES: TokenScope[] = ["tunnels:read"];

export const TOKEN_EXPIRY_PRESETS = ["7", "30", "90", "365", "custom"] as const;
export type TokenExpiryPreset = (typeof TOKEN_EXPIRY_PRESETS)[number];
export const MAX_DAYS = 365;

export interface ApiToken {
    id: number;
    name: string;
    prefix: string;
    scopes: string[];
    tunnels: { id: number; name: string | null }[] | null;
    expires_at: string;
    created_at: string;
    last_used_at: string | null;
    last_used_ip: string | null;
    revoked_at: string | null;
    expired: boolean;
    active: boolean;
    sessions: number;
    /** 開著的腳本瀏覽器。/ Scripted browsers open right now. */
    browsers?: number;
    /** 建立以來的呼叫次數（紀錄只留 90 天）。/ Calls since it was created (the log keeps 90 days). */
    call_count?: number;
    /** 最近的呼叫摘要。/ The recent-call summary. */
    calls?: { calls_24h: number; calls_7d: number; errors_7d: number; last_call_at: string | null; last_status: number | null };
}

/** 選項 → 「那天本地時間結束」的 ISO 時間；自選日期不合法 / 超過一年 = undefined（還不能送）。
 *  Choice → the end of that local day as ISO; an invalid or too-late custom date = undefined. */
export function tokenExpiryValue(preset: TokenExpiryPreset, customDate: string, now: Date = new Date()): string | undefined {
    const date = preset === "custom" ? customDate : addDays(Number(preset), now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
    const [y, m, d] = date.split("-").map(Number);
    const end = new Date(y, m - 1, d, 23, 59, 59);
    if (end.getTime() <= now.getTime()) return undefined;
    if (date > addDays(MAX_DAYS, now)) return undefined;
    return end.toISOString();
}

export type TokenState = "active" | "soon" | "expired" | "revoked";

/** 7 天內到期 = soon。/ Within 7 days = soon. */
export function tokenState(t: Pick<ApiToken, "revoked_at" | "expires_at">, now: number = Date.now()): TokenState {
    if (t.revoked_at) return "revoked";
    const at = Date.parse(t.expires_at);
    if (Number.isNaN(at) || at <= now) return "expired";
    return at - now <= 7 * 86_400_000 ? "soon" : "active";
}

/** 可以撤銷的（還沒撤銷、還沒到期）在前，新的在前。/ Live ones first, newest first. */
export function sortTokens(list: ApiToken[], now: number = Date.now()): ApiToken[] {
    const live = (t: ApiToken) => (tokenState(t, now) === "active" || tokenState(t, now) === "soon" ? 0 : 1);
    return [...list].sort((a, b) => live(a) - live(b) || b.id - a.id);
}

// ---------------------------------------------------------------- explainer lanes

export type LaneId = "token" | "web" | "apps";

export interface Lane {
    id: LaneId;
    /** [你那端, 憑證那一段, Telepy, Telepy → 裝置] 的狀態。/ States of [your side, the credential hop, Telepy, Telepy → devices]. */
    from: SpotState;
    credential: SpotState;
    telepy: SpotState;
    devices: SpotState;
    /** 這條路被這次撤銷切掉了。/ This lane is the one the revoke cuts. */
    cut: boolean;
}

/**
 * 三條路：token（筆電 / 腳本 / CI）、網頁登入、MCP app。撤銷一把 token 只切掉 token 那條（它開的 session 一起關），
 * 另外兩條照常——這就是這張圖要說的事。
 * The three lanes; revoking a token cuts only the token lane (its sessions close with it), the other two keep working.
 */
export function tokenLanes(revoked: boolean): Lane[] {
    const up = (id: LaneId): Lane => ({ id, from: "ok", credential: "ok", telepy: "ok", devices: "ok", cut: false });
    const token: Lane = revoked ? { id: "token", from: "ok", credential: "failed", telepy: "waiting", devices: "waiting", cut: true } : up("token");
    return [token, up("web"), up("apps")];
}

/** token 能做的事（說明圖上 Telepy → 裝置那一段的標籤）。/ What the token may do, for the Telepy → devices link. */
export function scopeAbilities(scopes: readonly string[]): TokenScope[] {
    return TOKEN_SCOPES.filter((s) => scopes.includes(s));
}

/** 不改東西的 scope。/ Scopes that change nothing. */
export function isReadOnly(scope: string): boolean {
    return scope === "tunnels:read" || scope === "network:scan";
}

// ---------------------------------------------------------------- examples

/** CLI 登入、curl、MCP 設定三種用法。/ The CLI login, a curl call and an MCP client config. */
export function tokenExamples(origin: string, secret: string): { cli: string; curl: string; mcp: string } {
    const base = origin.replace(/\/+$/, "");
    return {
        cli: `telepy login ${base} --token ${secret}`,
        curl: `curl -H "Authorization: Bearer ${secret}" ${base}/api/reverse/server/dashboard`,
        mcp: JSON.stringify({ mcpServers: { telepy: { url: `${base}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2),
    };
}
