/**
 * 管理區「伺服器狀態」（`GET /api/site/health` = `telepy-server doctor` 的檢查）：解析回應、總結哪一級最嚴重、
 * 排序（✗ 在前、✓ 在後，同級維持 doctor 的順序）。純函式，有測試。
 * The admin "Server health" page (`GET /api/site/health` = the `telepy-server doctor` checks): parse the answer,
 * the worst level, and the order (failures first, passes last, the doctor's order within a level). Pure, tested.
 */

export type HealthStatus = "ok" | "info" | "warn" | "fail";

/**
 * 後端每一項檢查的固定 id（`doctor.rs` 的 `Check.id`；改名或新增時兩邊一起改）。
 * The stable id of every backend check (`Check.id` in `doctor.rs`; change both together).
 */
export const CHECK_IDS = [
    "secret_key",
    "public_url",
    "internal_api_token",
    "data_dir",
    "log_dir",
    "database",
    "accounts",
    "tunnel_keys",
    "service_key",
    "shared_key",
    "gateway",
    "ssh_host",
    "guacd",
    "kasm",
    "geoip",
    "oui",
    "carriers",
    "client_addresses",
    "audit_log",
] as const;
export type HealthCheckId = (typeof CHECK_IDS)[number];

/** 頁面左側的分頁：總覽 + 每一組檢查。/ The page's side tabs: an overview plus one per group of checks. */
export const HEALTH_GROUPS = ["config", "storage", "keys", "services", "addresses"] as const;
export type HealthGroup = (typeof HEALTH_GROUPS)[number];
export type HealthTab = "overview" | HealthGroup;
export const HEALTH_TABS: HealthTab[] = ["overview", ...HEALTH_GROUPS];

export const GROUP_OF: Record<HealthCheckId, HealthGroup> = {
    secret_key: "config",
    public_url: "config",
    internal_api_token: "config",
    data_dir: "storage",
    log_dir: "storage",
    database: "storage",
    accounts: "storage",
    audit_log: "storage",
    tunnel_keys: "keys",
    service_key: "keys",
    shared_key: "keys",
    gateway: "keys",
    ssh_host: "keys",
    guacd: "services",
    kasm: "services",
    geoip: "services",
    oui: "services",
    carriers: "services",
    client_addresses: "addresses",
};

/** 較舊的後端沒有 `id`：用名稱認。/ Older backends send no `id`: recognise the name. */
const ID_BY_NAME: Record<string, HealthCheckId> = {
    SECRET_KEY: "secret_key",
    PUBLIC_URL: "public_url",
    INTERNAL_API_TOKEN: "internal_api_token",
    "data directory": "data_dir",
    "log directory": "log_dir",
    database: "database",
    accounts: "accounts",
    "tunnel keys": "tunnel_keys",
    "service key": "service_key",
    "shared key": "shared_key",
    "SSH gateway": "gateway",
    "SSH host": "ssh_host",
    "guacd (remote desktop)": "guacd",
    "kasm-browser (remote browser)": "kasm",
    GeoIP: "geoip",
    "OUI vendors": "oui",
    "device carriers": "carriers",
    "client addresses": "client_addresses",
    "audit log": "audit_log",
};

/** 管理員對一個 ⚠ / ✗ 的「已確認」。/ An admin's acknowledgement of a warning or failure. */
export interface HealthAck {
    by: string;
    at: string;
    note: string;
}

export interface HealthCheck {
    /** 認得的 id；更新的後端多出來、這版不認得的是 null（照原文顯示在「設定」組）。/ null = unknown to this build. */
    id: HealthCheckId | null;
    name: string;
    status: HealthStatus;
    detail: string;
    /** 這個結果的指紋：問題一變（新的列、新的表、更多不符）就變。/ Changes whenever the problem changes. "" from older backends. */
    fingerprint: string;
    /** 對「現在這個」結果的確認；有它就不再算警報。/ An acknowledgement of this exact result: no longer an alert. */
    ack: HealthAck | null;
    /** 之前確認過、但結果已經變了（又變紅）。/ Acknowledged earlier, but the result has changed since (red again). */
    staleAck: HealthAck | null;
}

export interface ServerHealth {
    checks: HealthCheck[];
    ok: number;
    info: number;
    warnings: number;
    failures: number;
    ranAt: string | null;
}

const STATUSES: HealthStatus[] = ["ok", "info", "warn", "fail"];
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

function parseAck(v: unknown): HealthAck | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.by !== "string" || typeof o.at !== "string") return null;
    return { by: o.by, at: o.at, note: typeof o.note === "string" ? o.note : "" };
}

/** 確認過的 ⚠ / ✗ 不再是警報（只有 warn / fail 能確認）。/ An acknowledged warning / failure is no longer an alert. */
export function isAcked(c: HealthCheck): boolean {
    return !!c.ack && (c.status === "warn" || c.status === "fail");
}

/** 還要人看的：沒確認過的 ⚠ / ✗。/ Still needs someone: unacknowledged warnings and failures. */
function alarming(c: HealthCheck): boolean {
    return (c.status === "warn" || c.status === "fail") && !isAcked(c);
}

/** 後端 JSON → 型別；形狀不對回 null。/ Backend JSON → typed; null when the shape is wrong. */
export function parseServerHealth(raw: unknown): ServerHealth | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.checks)) return null;
    const checks: HealthCheck[] = r.checks.flatMap((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        if (typeof o.name !== "string" || !o.name) return [];
        const status: HealthStatus = STATUSES.includes(o.status as HealthStatus) ? (o.status as HealthStatus) : "info";
        const id = CHECK_IDS.includes(o.id as HealthCheckId) ? (o.id as HealthCheckId) : (ID_BY_NAME[o.name] ?? null);
        return [{ id, name: o.name, status, detail: typeof o.detail === "string" ? o.detail : "", fingerprint: typeof o.fingerprint === "string" ? o.fingerprint : "", ack: parseAck(o.ack), staleAck: parseAck(o.stale_ack) }];
    });
    return {
        checks,
        ok: count(r.ok),
        info: count(r.info),
        warnings: count(r.warnings),
        failures: count(r.failures),
        ranAt: typeof r.ran_at === "string" && r.ran_at ? r.ran_at : null,
    };
}

/** 整體最嚴重的一級：有 ✗ 就是 fail，再來 warn，否則 ok（info 不算問題）。/ The worst level; notes don't count. */
export function worstStatus(checks: HealthCheck[]): "ok" | "warn" | "fail" {
    if (checks.some((c) => c.status === "fail" && alarming(c))) return "fail";
    if (checks.some((c) => c.status === "warn" && alarming(c))) return "warn";
    return "ok";
}

const ORDER: Record<HealthStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/** 需要看的在上面：✗、!、i、✓；同一級維持原本（doctor）的順序。/ Failures first, passes last; stable within a level. */
export function sortChecks(checks: HealthCheck[]): HealthCheck[] {
    return checks.map((c, i) => ({ c, i })).sort((a, b) => ORDER[a.c.status] - ORDER[b.c.status] || a.i - b.i).map(({ c }) => c);
}

/** 一項檢查在哪個分頁；不認得的放「設定」。/ Which tab a check sits on; unknown ones go to config. */
export function groupOf(check: HealthCheck): HealthGroup {
    return check.id ? GROUP_OF[check.id] : "config";
}

/** 某一組的檢查，排好序。/ A group's checks, sorted (failures first). */
export function checksIn(checks: HealthCheck[], group: HealthGroup): HealthCheck[] {
    return sortChecks(checks.filter((c) => groupOf(c) === group));
}

/** 每一組最嚴重的一級（側欄的點、總覽的格子）。/ The worst level per group (the tab dots, overview tiles). */
export function groupStatuses(checks: HealthCheck[]): Record<HealthGroup, "ok" | "warn" | "fail"> {
    const out = {} as Record<HealthGroup, "ok" | "warn" | "fail">;
    for (const g of HEALTH_GROUPS) out[g] = worstStatus(checks.filter((c) => groupOf(c) === g));
    return out;
}

/** `?tab=` → 分頁；不認得的回總覽。/ `?tab=` → a tab; anything else = the overview. */
export function parseHealthTab(raw: string | null | undefined): HealthTab {
    return HEALTH_TABS.includes(raw as HealthTab) ? (raw as HealthTab) : "overview";
}

export interface StatusCounts {
    ok: number;
    info: number;
    /** 沒確認的。/ Unacknowledged ones. */
    warn: number;
    fail: number;
    /** 確認過的 ⚠ / ✗。/ Acknowledged warnings and failures. */
    acked: number;
}

/** 一串檢查各級幾項。/ How many checks sit at each level. */
export function countStatuses(checks: HealthCheck[]): StatusCounts {
    const out: StatusCounts = { ok: 0, info: 0, warn: 0, fail: 0, acked: 0 };
    for (const c of checks) {
        if (isAcked(c)) out.acked += 1;
        else out[c.status] += 1;
    }
    return out;
}

/** 每一組各級幾項（側欄的數字、總覽格子的一行）。/ Counts per group (the tab badges, the overview tiles' line). */
export function groupCounts(checks: HealthCheck[]): Record<HealthGroup, StatusCounts> {
    const out = {} as Record<HealthGroup, StatusCounts>;
    for (const g of HEALTH_GROUPS) out[g] = countStatuses(checks.filter((c) => groupOf(c) === g));
    return out;
}

/** 要處理的（✗ 與 !），✗ 在前；總覽最上面列出來。/ What needs action (failures, then warnings) for the overview's top list. */
export function problems(checks: HealthCheck[]): HealthCheck[] {
    return sortChecks(checks.filter(alarming));
}

/**
 * 舊連結 `…/health#client-ip`（位址檢查以前在同一頁的最下面）沒有 `?tab=`：打開「訪客位址」分頁。
 * Old links `…/health#client-ip` (the address check used to sit at the bottom of one long page) carry no `?tab=`:
 * open the addresses tab for them.
 */
export function initialHealthTab(rawTab: string | null | undefined, hash: string | null | undefined): HealthTab {
    if (!rawTab && hash === "#client-ip") return "addresses";
    return parseHealthTab(rawTab);
}
