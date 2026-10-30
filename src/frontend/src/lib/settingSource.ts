/**
 * 站台設定從哪一層來：`.env`（環境變數，設了就贏、頁面上鎖住）→ 這一頁存的值 → 內建預設。純函式，有測試。
 * `GET /api/site/settings` 的 `env` 對照表每個可用環境變數設定的 key 一筆 `{var, set, value}`；舊後端沒有 `env`，
 * 那就全部是頁面 / 預設，什麼都不鎖。
 * Which layer a site setting comes from: `.env` (an environment variable; set = it wins and the page locks the
 * field) → the value saved on this page → the built-in default. Pure, tested. `GET /api/site/settings` carries
 * an `env` map with `{var, set, value}` for every env-backed key; an older backend has none, so everything is
 * page / default and nothing is locked.
 */

export type SettingLayer = "env" | "page" | "default";

export interface EnvEntry {
    /** 環境變數名稱。/ The variable's name. */
    var: string;
    /** 現在有設（存在且非空）。/ Present and non-empty right now. */
    set: boolean;
    /** 有設時的值。/ Its value when set. */
    value: string | null;
}

export type EnvMap = Record<string, EnvEntry>;

/** 後端 JSON → 對照表；形狀不對的項目略過。/ Backend JSON → map; malformed entries are skipped. */
export function parseEnvMap(raw: unknown): EnvMap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: EnvMap = {};
    for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        if (typeof o.var !== "string" || !o.var) continue;
        const value = typeof o.value === "string" ? o.value : o.value == null ? null : String(o.value);
        // 「有設」= 存在且非空；後端說有設但沒給值時仍算有設（值顯示成空）。/ set = present and non-empty.
        out[key] = { var: o.var, set: o.set === true, value: o.set === true ? value : null };
    }
    return out;
}

/** 這個設定被 .env 鎖住了嗎。/ Whether .env locks this setting. */
export const isLocked = (env: EnvMap, key: string) => env[key]?.set === true;

/** 環境變數的開關寫法（true / 1 / yes / on）。/ How a variable spells "on". */
export function envBool(value: string | null | undefined): boolean {
    return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

/**
 * 內建預設（後端 meta 有 `default` 時以它為準）。對照合約的表。
 * Built-in defaults (the backend meta's `default` wins when present), from the contract's table.
 */
export const BUILTIN_DEFAULTS: Record<string, string | boolean> = {
    client_ip_hops: "auto",
    client_ip_header: "",
    client_ip_cloudflare: "auto",
    server_device_probe: true,
    server_keep_shared_service_key: false,
    server_gateway_proxy_protocol_from: "",
    server_log_level: "",
    server_openapi_enabled: true,
    server_google_client_id: "",
    server_public_url: "",
};

/** 同一個值嗎（字串比較，開關用 true / false）。/ Same value (compared as strings). */
const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

export interface SettingSource {
    /** 決定的那一層。/ The deciding layer. */
    layer: SettingLayer;
    /** 實際生效的值（.env 的開關已轉成布林）。/ The value in effect (an env switch is parsed to a boolean). */
    value: unknown;
    locked: boolean;
    /** 頁面存的值跟預設不同。/ The saved value differs from the default. */
    pageChanged: boolean;
}

/**
 * 誰決定這個設定：.env 有設 → env；不然頁面存的值跟預設不同 → page；否則 default。沒有預設可比時，有存值就算 page。
 * Who decides: env when set; otherwise page when the saved value differs from the default; else default. With no
 * default to compare against, a saved value counts as page.
 */
export function settingSource(env: EnvEntry | undefined, saved: unknown, defaultValue: unknown): SettingSource {
    const hasDefault = defaultValue !== undefined;
    const pageChanged = hasDefault ? !same(saved, defaultValue) : saved !== undefined && saved !== null && saved !== "";
    if (env?.set) {
        const boolish = typeof saved === "boolean" || typeof defaultValue === "boolean";
        return { layer: "env", value: boolish ? envBool(env.value) : env.value ?? "", locked: true, pageChanged };
    }
    if (pageChanged) return { layer: "page", value: saved, locked: false, pageChanged };
    return { layer: "default", value: hasDefault ? defaultValue : saved, locked: false, pageChanged };
}

export type LayerState = "decides" | "notSet" | "overridden";

/**
 * 圖上每一層的狀態：決定的那層亮起；比它優先卻沒設的 = 沒設；排在它後面的 = 被蓋過（頁面跟預設一樣時算沒設）。
 * Each layer's state on the diagram: the decider is lit; higher layers that are empty = not set; lower layers =
 * overridden (the page counts as not set when it equals the default).
 */
export function layerStates(src: SettingSource): Record<SettingLayer, LayerState> {
    const order: SettingLayer[] = ["env", "page", "default"];
    const at = order.indexOf(src.layer);
    const state = (l: SettingLayer): LayerState => {
        const i = order.indexOf(l);
        if (i === at) return "decides";
        if (i < at) return "notSet";
        if (l === "page" && !src.pageChanged) return "notSet";
        return "overridden";
    };
    return { env: state("env"), page: state("page"), default: state("default") };
}

/** 伺服器分頁的分組（key 的順序就是畫面上的順序）。/ The Server tab's groups, in display order. */
export const SERVER_GROUPS = [
    { id: "visitor", keys: ["client_ip_hops", "client_ip_header", "client_ip_cloudflare"] },
    { id: "devices", keys: ["server_device_probe", "server_keep_shared_service_key", "server_gateway_proxy_protocol_from"] },
    { id: "logs", keys: ["server_log_level", "server_openapi_enabled"] },
    { id: "signin", keys: ["server_google_client_id", "server_public_url"] },
] as const;

export type ServerGroupId = (typeof SERVER_GROUPS)[number]["id"];

/** 屬於伺服器分頁的 key。/ Keys that belong on the Server tab. */
export const isServerKey = (key: string) => key.startsWith("client_ip_") || key.startsWith("server_");

/** 沒在已知分組裡的伺服器 key 收進最後一組（較新的後端）。/ Unknown server keys go into the last group (newer backends). */
export function groupServerKeys(keys: string[]): { id: ServerGroupId; keys: string[] }[] {
    const known = new Set<string>(SERVER_GROUPS.flatMap((g) => [...g.keys]));
    const present = new Set(keys);
    const extra = keys.filter((k) => isServerKey(k) && !known.has(k)).sort();
    return SERVER_GROUPS.map((g, i) => ({
        id: g.id,
        keys: [...g.keys.filter((k) => present.has(k)), ...(i === SERVER_GROUPS.length - 1 ? extra : [])],
    })).filter((g) => g.keys.length > 0);
}

export type EnvOnlyReason = "beforeStart" | "compose" | "shared" | "secret";

/**
 * 只能在 .env 設的變數與原因。/ Variables that stay in .env only, and why.
 */
export const ENV_ONLY: { vars: string[]; reasons: EnvOnlyReason[] }[] = [
    { vars: ["SECRET_KEY"], reasons: ["secret", "beforeStart"] },
    { vars: ["INTERNAL_API_TOKEN"], reasons: ["secret", "shared"] },
    { vars: ["WEB_SERVER_PORT", "REVERSE_SERVER_SSH_PORT"], reasons: ["compose"] },
    { vars: ["SERVER_DOMAIN"], reasons: ["compose", "beforeStart"] },
    { vars: ["PROJECT_NAME"], reasons: ["compose"] },
    { vars: ["GEOIP_DIR", "OUI_DIR"], reasons: ["beforeStart", "compose"] },
];

/** 可用環境變數設定的 key，依伺服器分頁的順序（不認得的排最後）。/ Env-backed keys in the Server tab's order, unknown last. */
export function envBackedKeys(env: EnvMap): string[] {
    const order: string[] = SERVER_GROUPS.flatMap((g) => [...g.keys]);
    const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
    return Object.keys(env).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** 對話框一打開要選哪個：指定的，否則第一個被鎖住的，否則第一個。/ Which key the dialog opens on. */
export function initialKey(env: EnvMap, wanted?: string | null): string | null {
    const keys = envBackedKeys(env);
    if (wanted && keys.includes(wanted)) return wanted;
    return keys.find((k) => isLocked(env, k)) ?? keys[0] ?? null;
}
