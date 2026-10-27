/**
 * API 頁「token 能打哪些端點」的純函式：後端 `GET /api/auth/tokens/routes`（跟伺服器用的白名單同一份）分組、搜尋，
 * 以及每列的 curl（基底網址填好、祕密用 `$TELEPY_TOKEN`，永遠不放真的 token）與對應的 `telepy` 指令。
 * `apiCatalogue.test.ts` 有測試。
 * Pure helpers for the API page's "what a token can call": grouping and searching the backend's catalogue (built
 * from the allow-list the server enforces), and each row's curl (base URL filled in, the secret as `$TELEPY_TOKEN`,
 * never a real token) and its `telepy` equivalent.
 */
import { TOKEN_SCOPES, type TokenScope } from "./apiTokens.ts";

export type TunnelRule = "path" | "handler" | "unrestricted" | "none";

export interface ApiRoute {
    method: string;
    path: string;
    tag: string;
    summary: string;
    /** token 能打。/ A token may call it. */
    token: boolean;
    scope: string | null;
    tunnel: TunnelRule | null;
    feature: string | null;
}

export interface RouteCatalogue {
    base_url: string;
    scopes: string[];
    routes: ApiRoute[];
}

/** 分組：任何 token 都行（`any`）→ 每個 scope → 只能在網頁上用（`web`）。/ Groups: any token → each scope → web only. */
export type RouteGroupId = "any" | TokenScope | "web";
export const GROUP_ORDER: readonly RouteGroupId[] = ["any", ...TOKEN_SCOPES, "web"];

export function groupOf(r: ApiRoute): RouteGroupId {
    if (!r.token) return "web";
    if (!r.scope) return "any";
    return (TOKEN_SCOPES as readonly string[]).includes(r.scope) ? (r.scope as TokenScope) : "any";
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** 每個字都要出現在方法、路徑、tag、摘要或 scope 裡（不分大小寫）。/ Every word must appear somewhere. */
export function routeMatches(r: ApiRoute, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = `${r.method} ${r.path} ${r.tag} ${r.summary} ${r.scope ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}

export interface RouteGroup {
    id: RouteGroupId;
    routes: ApiRoute[];
}

/** 篩選 + 分組（空的組不回），組內依路徑、再依方法排。/ Filter and group (no empty groups), sorted by path then method. */
export function groupRoutes(routes: readonly ApiRoute[], opts: { query?: string; tokenOnly?: boolean } = {}): RouteGroup[] {
    const keep = routes.filter((r) => (!opts.tokenOnly || r.token) && routeMatches(r, opts.query ?? ""));
    const by = new Map<RouteGroupId, ApiRoute[]>();
    for (const r of keep) {
        const g = groupOf(r);
        by.set(g, [...(by.get(g) ?? []), r]);
    }
    return GROUP_ORDER.filter((g) => by.has(g)).map((id) => ({
        id,
        routes: [...(by.get(id) ?? [])].sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)),
    }));
}

/** 每組有幾個端點（不受搜尋影響之外的那些）。/ How many routes each group has. */
export function groupCounts(routes: readonly ApiRoute[]): Record<RouteGroupId, number> {
    const out = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<RouteGroupId, number>;
    for (const r of routes) out[groupOf(r)] += 1;
    return out;
}

/**
 * 路徑參數 → shell 變數：隧道規則是 path 的路由，第一個參數就是隧道 id（`$TUNNEL_ID`），其他照名字大寫（`{host_id}` → `$HOST_ID`）。
 * Path params → shell variables: on `path` routes the first one is the tunnel id; others by name.
 */
export function fillPath(r: Pick<ApiRoute, "path" | "tunnel">): string {
    let first = true;
    return r.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) => {
        const v = first && r.tunnel === "path" ? "TUNNEL_ID" : name.toUpperCase();
        first = false;
        return `$${v}`;
    });
}

/** 已知路由的範例 body（其他寫入給 `{}`）。/ Example bodies for known routes (other writes get `{}`). */
const EXAMPLE_BODIES: Record<string, unknown> = {
    "POST /api/browser/sessions": { tunnel_id: "$TUNNEL_ID", url: "http://192.168.1.1/" },
    "POST /api/browser/sessions/{id}/navigate": { url: "http://192.168.1.1/status" },
    "POST /api/browser/sessions/{id}/click": { text: "Save" },
    "POST /api/browser/sessions/{id}/type": { selector: "#password", text: "…", press_enter: true },
    "POST /api/reverse/server/{id}/lan/hosts": { address: "192.168.1.20", label: "nas", username: "pi" },
    "PATCH /api/reverse/server/{id}/lan/hosts/{host_id}": { label: "storage" },
    "POST /api/ai/sessions": { tunnel_id: "$TUNNEL_ID" },
    "POST /api/ai/sessions/{id}/exec": { command: "uptime" },
    "PUT /api/reverse/server/{id}/labels": { labels: ["env=prod"] },
    "POST /api/reverse/server/{id}/lan/scan": {},
};

/** body 裡的 `"$VAR"` 字串在 shell 裡要能展開，所以 body 用雙引號、變數留在外面。/ Bodies keep `$VAR` expandable. */
function shellBody(body: unknown): string {
    const json = JSON.stringify(body);
    // 數字型的變數不加引號（`"tunnel_id":"$TUNNEL_ID"` → `"tunnel_id":$TUNNEL_ID`）。/ Numeric variables unquoted.
    const unquoted = json.replace(/"\$([A-Z_]+)"/g, "$$$1");
    if (!unquoted.includes("$")) return `'${unquoted}'`;
    return `"${unquoted.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\\\$/g, "$")}"`;
}

/** 一列的 curl：`$TELEPY_TOKEN` 當祕密；截圖寫成檔案。/ The row's curl, with `$TELEPY_TOKEN` as the secret. */
export function curlFor(r: Pick<ApiRoute, "method" | "path" | "tunnel">, base: string): string {
    const url = `${base.replace(/\/+$/, "")}${fillPath(r)}`;
    const parts = ["curl -sS"];
    if (r.method !== "GET") parts.push(`-X ${r.method}`);
    parts.push('-H "Authorization: Bearer $TELEPY_TOKEN"');
    if (["POST", "PUT", "PATCH"].includes(r.method)) {
        parts.push('-H "Content-Type: application/json"');
        parts.push(`-d ${shellBody(EXAMPLE_BODIES[`${r.method} ${r.path}`] ?? {})}`);
    }
    if (r.path.endsWith("/screenshot")) parts.push("-o page.png");
    parts.push(`"${url}"`);
    return parts.join(" ");
}

/** 有對應的 `telepy` 指令就回它。/ The `telepy` CLI equivalent, when there is one. */
const CLI: Record<string, string> = {
    "GET /api/auth/user/profile": "telepy whoami",
    "GET /api/auth/tokens": "telepy api tokens",
    "GET /api/auth/tokens/calls": "telepy api activity",
    "GET /api/reverse/server/dashboard": "telepy ls",
    "GET /api/reverse/server/keys": "telepy ls --json",
    "GET /api/reverse/server/keys/{id}": "telepy status <tunnel>",
    "GET /api/reverse/server/{id}/connections": "telepy status <tunnel>",
    "GET /tunnels/server/config/{id}": "telepy ssh <tunnel>  # or: telepy config install",
    "GET /api/sessions": "telepy sessions",
    "DELETE /api/sessions/{id}": "telepy sessions end <id>",
    "POST /api/ai/sessions": "telepy exec <tunnel> -- <command>",
    "POST /api/ai/sessions/{id}/exec": "telepy exec <tunnel> -- <command>",
    "GET /api/snippets": "telepy snippets ls",
    "GET /api/recordings": "telepy recordings ls",
    "GET /api/recordings/{id}/cast": "telepy recordings play <id>",
    "GET /api/sftp/download/{id}/{username}": "telepy cp <tunnel>:<path> ./",
    "POST /api/sftp/upload/{id}/{username}": "telepy cp ./file <tunnel>:<path>",
    "GET /api/reverse/server/{id}/lan/hosts": "telepy lan ls <tunnel>",
    "POST /api/reverse/server/{id}/lan/hosts": "telepy lan add <tunnel> <address> --label <name>",
    "DELETE /api/reverse/server/{id}/lan/hosts/{host_id}": "telepy lan rm <tunnel> <host>",
    "GET /api/browser/sessions": "telepy browse ls",
    "POST /api/browser/sessions": "telepy browse <tunnel> [url]",
    "POST /api/browser/sessions/{id}/navigate": "telepy browse go <id> <url>",
    "GET /api/browser/sessions/{id}/text": "telepy browse text <id> [--selector <css>]",
    "GET /api/browser/sessions/{id}/screenshot": "telepy browse shot <id> -o page.png",
    "POST /api/browser/sessions/{id}/click": "telepy browse click <id> <selector>  # or --text <label>",
    "POST /api/browser/sessions/{id}/type": "telepy browse type <id> <selector> <text> [--enter]",
    "DELETE /api/browser/sessions/{id}": "telepy browse close <id>",
};

export function cliFor(method: string, path: string): string | null {
    return CLI[`${method} ${path}`] ?? null;
}

/**
 * 遠端瀏覽器的範例腳本（curl 與 CLI）：開 → 去只有裝置那邊連得到的網址 → 讀字 / 截圖 → 關。
 * The remote-browser example script (curl and CLI): open → a URL only the device's network reaches → read / shot → close.
 */
export function browserScript(base: string, tunnelId: number | string = "$TUNNEL_ID"): { curl: string; cli: string } {
    const b = base.replace(/\/+$/, "");
    const auth = '-H "Authorization: Bearer $TELEPY_TOKEN"';
    const json = '-H "Content-Type: application/json"';
    const curl = [
        "# 1. open a browser on the device's network",
        `ID=$(curl -sS ${auth} ${json} -d "{\\"tunnel_id\\": ${tunnelId}, \\"url\\": \\"http://192.168.1.1/\\"}" ${b}/api/browser/sessions | jq -r .id)`,
        `# 2. read the page, take a screenshot`,
        `curl -sS ${auth} "${b}/api/browser/sessions/$ID/text" | jq -r .text`,
        `curl -sS ${auth} -o router.png "${b}/api/browser/sessions/$ID/screenshot"`,
        `# 3. close it (it also closes itself when idle)`,
        `curl -sS -X DELETE ${auth} "${b}/api/browser/sessions/$ID"`,
    ].join("\n");
    const cli = [
        `ID=$(telepy browse <tunnel> http://192.168.1.1/)`,
        `telepy browse text "$ID"`,
        `telepy browse shot "$ID" -o router.png`,
        `telepy browse close "$ID"`,
    ].join("\n");
    return { curl, cli };
}
