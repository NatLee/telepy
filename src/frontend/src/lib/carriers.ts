/**
 * 裝置載體（telepy-carrier）面板的純函式：解析 `GET /api/site/carriers`、每個平台的狀態、摘要、平台名稱、版本比較
 * （跟後端 `carriers::newer` 同一套），以及說明圖每一段的狀態。
 * Pure helpers for the device carriers panel: parsing the API, each platform's state, the summary, platform names,
 * version comparison (the same rule as the backend's `carriers::newer`) and the info diagram's spot states.
 */
import type { SpotState } from "./flow.ts";

export interface CarrierCached {
    /** 從哪個 release 抓的（手動放的 = null）。/ The release it came from (null = placed by hand). */
    version: string | null;
    sha256: string;
    size: number;
    fetched_at: string | null;
}

export interface CarrierTarget {
    target: string;
    os: string;
    arch: string;
    cached: CarrierCached | null;
    update_available: boolean;
    failure: { at: string; error: string } | null;
}

export interface CarrierUpdated {
    target: string;
    from: string | null;
    was: "missing" | "release" | "manual";
}

export interface CarrierRun {
    at: string;
    trigger: "auto" | "manual";
    by: string | null;
    tag: string | null;
    updated: CarrierUpdated[];
    current: string[];
    failed: [string, string][];
    error: string | null;
}

export interface CarriersView {
    auto_update: boolean;
    releases_url: string;
    dir: string;
    keys: { fingerprint: string; comment: string }[];
    latest: { tag: string | null; checked_at: string | null; error: string | null };
    next_check_at: string | null;
    updating: boolean;
    targets: CarrierTarget[];
    last_run: CarrierRun | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseRun(raw: unknown): CarrierRun | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const at = str(r.at);
    if (!at) return null;
    const updated = Array.isArray(r.updated)
        ? r.updated.flatMap((u): CarrierUpdated[] => {
              const o = (u ?? {}) as Record<string, unknown>;
              const t = str(o.target);
              const was = o.was === "missing" || o.was === "release" || o.was === "manual" ? o.was : "release";
              return t ? [{ target: t, from: str(o.from), was }] : [];
          })
        : [];
    const failed = Array.isArray(r.failed) ? r.failed.flatMap((f): [string, string][] => (Array.isArray(f) && typeof f[0] === "string" ? [[f[0], String(f[1] ?? "")]] : [])) : [];
    return {
        at,
        trigger: r.trigger === "auto" ? "auto" : "manual",
        by: str(r.by),
        tag: str(r.tag),
        updated,
        current: Array.isArray(r.current) ? r.current.filter((x): x is string => typeof x === "string") : [],
        failed,
        error: str(r.error),
    };
}

/** API 的回答；形狀不對 = null。/ The API answer; null when it isn't one. */
export function parseCarriers(raw: unknown): CarriersView | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.targets)) return null;
    const latest = (r.latest ?? {}) as Record<string, unknown>;
    const targets = r.targets.flatMap((x): CarrierTarget[] => {
        const t = (x ?? {}) as Record<string, unknown>;
        const name = str(t.target);
        if (!name) return [];
        const c = t.cached as Record<string, unknown> | null | undefined;
        const f = t.failure as Record<string, unknown> | null | undefined;
        return [
            {
                target: name,
                os: str(t.os) ?? "",
                arch: str(t.arch) ?? "",
                cached: c ? { version: str(c.version), sha256: str(c.sha256) ?? "", size: typeof c.size === "number" ? c.size : 0, fetched_at: str(c.fetched_at) } : null,
                update_available: t.update_available === true,
                failure: f && str(f.error) ? { at: str(f.at) ?? "", error: str(f.error) ?? "" } : null,
            },
        ];
    });
    return {
        auto_update: r.auto_update !== false,
        releases_url: str(r.releases_url) ?? "",
        dir: str(r.dir) ?? "",
        keys: Array.isArray(r.keys) ? r.keys.flatMap((k) => (k && typeof k === "object" && str((k as Record<string, unknown>).fingerprint) ? [{ fingerprint: str((k as Record<string, unknown>).fingerprint) ?? "", comment: str((k as Record<string, unknown>).comment) ?? "" }] : [])) : [],
        latest: { tag: str(latest.tag), checked_at: str(latest.checked_at), error: str(latest.error) },
        next_check_at: str(r.next_check_at),
        updating: r.updating === true,
        targets,
        last_run: parseRun(r.last_run),
    };
}

/** `v2.12.0` → [2, 12, 0]；看不懂 = null（跟後端一樣）。/ A release tag as numbers (same rule as the backend). */
export function parseVersion(tag: string): [number, number, number] | null {
    const core = tag.trim().replace(/^v/, "").split(/[-+]/)[0];
    const parts = core.split(".");
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    return [Number(parts[0]), Number(parts[1]), Number(parts[2] ?? 0)];
}

/** `latest` 比 `current` 新。/ Whether `latest` is newer. */
export function newer(latest: string, current: string): boolean {
    const l = parseVersion(latest);
    const c = parseVersion(current);
    if (!l || !c) return false;
    for (let i = 0; i < 3; i++) if (l[i] !== c[i]) return l[i] > c[i];
    return false;
}

/**
 * 一個平台的狀態：`current` 是最新版；`update` 有新版；`manual` 手動放的；`missing` 還沒有；`failed` 最近抓不到；
 * `unknown` 有快取但還沒問過最新版。/ A platform's state.
 */
export type CarrierState = "current" | "update" | "manual" | "missing" | "failed" | "unknown";

export function carrierState(t: CarrierTarget, latest: string | null): CarrierState {
    if (t.failure && !t.cached) return "failed";
    if (!t.cached) return "missing";
    if (t.cached.version === null) return "manual";
    if (t.update_available || (latest !== null && newer(latest, t.cached.version))) return "update";
    if (latest === null) return "unknown";
    return "current";
}

/** 狀態的語氣（點的顏色）。/ The state's tone (the dot's colour). */
export const STATE_TONE: Record<CarrierState, "success" | "warning" | "danger" | "muted" | "info"> = {
    current: "success",
    update: "warning",
    manual: "info",
    missing: "muted",
    failed: "danger",
    unknown: "muted",
};

export interface CarrierSummary {
    total: number;
    cached: number;
    outdated: number;
    manual: number;
    failed: number;
}

export function carrierSummary(v: CarriersView): CarrierSummary {
    const states = v.targets.map((t) => carrierState(t, v.latest.tag));
    return {
        total: v.targets.length,
        cached: v.targets.filter((t) => t.cached).length,
        outdated: states.filter((s) => s === "update").length,
        manual: states.filter((s) => s === "manual").length,
        failed: states.filter((s) => s === "failed").length,
    };
}

/** 平台名稱（產品名不翻譯）：`Linux x86_64`、`macOS Apple silicon`、`Windows x86_64`。/ A platform's name. */
export function platformLabel(t: { os: string; arch: string }): string {
    const os = t.os === "darwin" ? "macOS" : t.os === "windows" ? "Windows" : t.os === "linux" ? "Linux" : t.os;
    const arch = t.os === "darwin" ? (t.arch === "x86_64" ? "Intel" : "Apple silicon") : t.arch === "armv7l" ? "ARMv7 (32-bit)" : t.arch === "armv6l" ? "ARMv6 (32-bit)" : t.arch === "aarch64" ? "ARM64" : t.arch;
    return `${os} ${arch}`;
}

/** 說明圖每一段：release 頁 ─ 驗簽 ─ Telepy 的快取 ─ 裝置。/ The info diagram's spots. */
export interface CarrierFlow {
    release: SpotState;
    signature: SpotState;
    cache: SpotState;
    devices: SpotState;
}

export function carrierFlow(v: CarriersView | null): CarrierFlow {
    if (!v) return { release: "waiting", signature: "waiting", cache: "waiting", devices: "waiting" };
    const s = carrierSummary(v);
    const release: SpotState = v.latest.error ? "failed" : v.latest.tag ? "ok" : "waiting";
    const lastFailedSignature = (v.last_run?.failed ?? []).some(([, e]) => /signature|SHA256SUMS/i.test(e));
    const signature: SpotState = lastFailedSignature ? "failed" : s.cached > 0 && s.cached > s.manual ? "ok" : "waiting";
    // 正在更新才轉圈；有比較舊的不算錯，用文字說。/ Spinning only while updating; older copies are said in words, not as an error.
    const cache: SpotState = v.updating ? "active" : s.cached === 0 ? "waiting" : "ok";
    return { release, signature, cache, devices: s.cached > 0 ? "ok" : "waiting" };
}
