/**
 * 管理區「伺服器狀態」（`GET /api/site/health` = `telepy-server doctor` 的檢查）：解析回應、總結哪一級最嚴重、
 * 排序（✗ 在前、✓ 在後，同級維持 doctor 的順序）。純函式，有測試。
 * The admin "Server health" page (`GET /api/site/health` = the `telepy-server doctor` checks): parse the answer,
 * the worst level, and the order (failures first, passes last, the doctor's order within a level). Pure, tested.
 */

export type HealthStatus = "ok" | "info" | "warn" | "fail";

export interface HealthCheck {
    name: string;
    status: HealthStatus;
    detail: string;
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

/** 後端 JSON → 型別；形狀不對回 null。/ Backend JSON → typed; null when the shape is wrong. */
export function parseServerHealth(raw: unknown): ServerHealth | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.checks)) return null;
    const checks: HealthCheck[] = r.checks.flatMap((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        if (typeof o.name !== "string" || !o.name) return [];
        const status: HealthStatus = STATUSES.includes(o.status as HealthStatus) ? (o.status as HealthStatus) : "info";
        return [{ name: o.name, status, detail: typeof o.detail === "string" ? o.detail : "" }];
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
    if (checks.some((c) => c.status === "fail")) return "fail";
    if (checks.some((c) => c.status === "warn")) return "warn";
    return "ok";
}

const ORDER: Record<HealthStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/** 需要看的在上面：✗、!、i、✓；同一級維持原本（doctor）的順序。/ Failures first, passes last; stable within a level. */
export function sortChecks(checks: HealthCheck[]): HealthCheck[] {
    return checks.map((c, i) => ({ c, i })).sort((a, b) => ORDER[a.c.status] - ORDER[b.c.status] || a.i - b.i).map(({ c }) => c);
}
