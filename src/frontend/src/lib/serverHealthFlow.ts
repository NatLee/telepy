/**
 * 「伺服器狀態」的說明圖：把 doctor 的每一項檢查放到 Telepy 伺服器圖上的某一站，算出每站的狀態、它屬於頁面的哪個分頁，
 * 以及沿著請求的路「卡在哪一站」。純函式，有測試。
 * The Server health info diagram: each doctor check placed on a spot of the server picture, the state of every spot,
 * the page tab it belongs to, and "where it stopped" along the request path. Pure, tested.
 *
 * 主線（訪客的請求怎麼走）：訪客的瀏覽器 ─ 代理 / Traefik（client_addresses）─ Telepy 後端（設定）─ 磁碟上的資料。
 * 從後端分出去：SSH 閘道（金鑰）─ 裝置、guacd、kasm-browser、本機的 GeoIP + OUI 檔。
 * Main path: visitor's browser ─ proxy / Traefik (client_addresses) ─ backend (configuration) ─ data on disk.
 * Branches from the backend: SSH gateway (keys) ─ devices, guacd, kasm-browser, local GeoIP + OUI files.
 */
import { isAcked, type HealthCheck, type HealthCheckId, type HealthStatus, type HealthTab, type ServerHealth } from "./serverHealth.ts";

/**
 * 一站的狀態：PathFlow 的 waiting / ok / failed，再加 warn（能用但要看一下）。info（附註）算 ok。
 * A spot's state: PathFlow's waiting / ok / failed plus warn (works, needs a look). Notes (info) count as ok.
 */
export type HealthSpotState = "waiting" | "ok" | "warn" | "failed";

export const HEALTH_SPOTS = ["visitor", "proxy", "backend", "disk", "gateway", "devices", "guacd", "kasm", "lookups"] as const;
export type HealthSpot = (typeof HEALTH_SPOTS)[number];

/** 沿著請求的路、再到旁支的順序：「卡在哪」取第一個。/ Request path first, then the branches: "where it stopped" takes the first. */
export const PATH_ORDER: HealthSpot[] = ["proxy", "backend", "disk", "gateway", "guacd", "kasm", "lookups"];

/** 每站對應的檢查（null = 不檢查：訪客自己、裝置）。/ The checks of each spot (null = nothing is checked there). */
export const SPOT_CHECKS: Record<HealthSpot, readonly HealthCheckId[] | null> = {
    visitor: null,
    proxy: ["client_addresses"],
    backend: ["secret_key", "public_url", "internal_api_token"],
    disk: ["data_dir", "log_dir", "database", "accounts", "audit_log"],
    gateway: ["tunnel_keys", "service_key", "shared_key", "gateway", "ssh_host"],
    devices: null,
    guacd: ["guacd"],
    kasm: ["kasm"],
    lookups: ["geoip", "oui"],
};

/** 點一站打開哪個分頁。/ The tab a click on the spot opens. */
export const SPOT_TAB: Record<HealthSpot, HealthTab> = {
    visitor: "addresses",
    proxy: "addresses",
    backend: "config",
    disk: "storage",
    gateway: "keys",
    devices: "keys",
    guacd: "services",
    kasm: "services",
    lookups: "services",
};

export interface SpotInfo {
    state: HealthSpotState;
    /** 這站最嚴重的一級（含 info）；null = 沒資料 / 不檢查。/ The worst level incl. notes; null = no data / not checked. */
    status: HealthStatus | null;
    /** 這站的檢查，最嚴重的在前（確認過的算在備註那級）。/ The spot's checks, worst first (acknowledged ones rank as notes). */
    checks: HealthCheck[];
    /** 確認過的 ⚠ / ✗：不讓這站變紅 / 黃，狀態文字說「已確認」。/ Acknowledged problems: they don't colour the spot. */
    acked: HealthCheck[];
    tab: HealthTab;
    /** 這站本來就不檢查（訪客、裝置）。/ Nothing is checked at this spot. */
    unchecked: boolean;
}

const RANK: Record<HealthStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/**
 * 一項檢查在圖上算哪一級：確認過的 ⚠ / ✗ 算備註（不亮紅 / 黃，等結果一變才又亮）。
 * The level a check counts as on the picture: an acknowledged warning / failure counts as a note.
 */
export function effectiveStatus(c: HealthCheck): HealthStatus {
    return isAcked(c) ? "info" : c.status;
}

export function stateOf(status: HealthStatus | null): HealthSpotState {
    if (status === "fail") return "failed";
    if (status === "warn") return "warn";
    if (status === "ok" || status === "info") return "ok";
    return "waiting";
}

/** 一項檢查落在哪一站；不認得的（更新的後端多的）放在後端，跟頁面把它放在「設定」一致。/ Which spot a check lands on; unknown ones go to the backend, as the page puts them under configuration. */
export function spotOf(check: HealthCheck): HealthSpot {
    if (check.id) {
        for (const s of HEALTH_SPOTS) if (SPOT_CHECKS[s]?.includes(check.id)) return s;
    }
    return "backend";
}

/** 每一站的狀態；health 為 null（還沒載入）= 全部待命。/ Every spot's state; null health = everything waiting. */
export function healthSpots(health: ServerHealth | null): Record<HealthSpot, SpotInfo> {
    const out = {} as Record<HealthSpot, SpotInfo>;
    for (const s of HEALTH_SPOTS) {
        const unchecked = SPOT_CHECKS[s] === null;
        const checks = health ? health.checks.filter((c) => !unchecked && spotOf(c) === s) : [];
        checks.sort((a, b) => RANK[effectiveStatus(a)] - RANK[effectiveStatus(b)]);
        let status: HealthStatus | null = checks.length ? effectiveStatus(checks[0]) : null;
        // 訪客：頁面能載入就代表瀏覽器到得了。/ The visitor: the page loaded, so the browser got through.
        if (s === "visitor" && health) status = "ok";
        out[s] = { state: stateOf(status), status, checks, acked: checks.filter(isAcked), tab: SPOT_TAB[s], unchecked };
    }
    return out;
}

/** 線的狀態：每段線跟著它通往的那一站。/ A link takes the state of the spot it leads to. */
export function linkState(spots: Record<HealthSpot, SpotInfo>, to: HealthSpot): HealthSpotState {
    return spots[to].state;
}

export type HealthNow =
    | { kind: "loading" }
    | { kind: "ok" }
    | { kind: "warn" | "fail"; spot: HealthSpot; check: HealthCheck; tab: HealthTab; more: number };

/**
 * 「現在」：沿路第一個失敗的站；沒有失敗就第一個要注意的；都沒有 = 全部正常。`more` = 其他同級的站數。
 * "Right now": the first failing spot along the path, else the first warning one, else all fine. `more` = other
 * spots at that level.
 */
export function healthNow(health: ServerHealth | null): HealthNow {
    if (!health) return { kind: "loading" };
    const spots = healthSpots(health);
    for (const level of ["failed", "warn"] as const) {
        const hits = PATH_ORDER.filter((s) => spots[s].state === level);
        if (hits.length) {
            const spot = hits[0];
            return { kind: level === "failed" ? "fail" : "warn", spot, check: spots[spot].checks[0], tab: spots[spot].tab, more: hits.length - 1 };
        }
    }
    return { kind: "ok" };
}
