/**
 * 「IP 與網卡廠商資料」面板的純函式：解析 `GET /api/site/datasets`、每一項的狀態、這次更新的摘要，以及說明圖每一段的狀態。
 * Pure helpers for the "IP and vendor data" panel: parsing the API, each item's state, a run's summary and the info
 * diagram's spot states.
 */
import type { SpotState } from "./flow.ts";

export type DatasetId = "country" | "asn" | "oui";
export const DATASET_IDS: readonly DatasetId[] = ["country", "asn", "oui"];

export interface DatasetInUse {
    file: string;
    source: string;
    built: string | null;
}

export interface DatasetItem {
    id: DatasetId;
    path: string;
    present: boolean;
    size: number | null;
    modified: string | null;
    /** DB-IP：哪個月的。/ DB-IP: which month. */
    release: string | null;
    in_use: DatasetInUse | null;
    vendors: number | null;
    due: boolean;
    failure: { at: string; error: string } | null;
}

export interface DatasetRunItem {
    id: DatasetId;
    outcome: "updated" | "current" | "failed";
    from: string | null;
    to: string | null;
    error: string | null;
}

export interface DatasetRun {
    at: string;
    trigger: "auto" | "manual";
    by: string | null;
    items: DatasetRunItem[];
}

export interface DatasetsView {
    auto_update: boolean;
    items: DatasetItem[];
    geoip_dir: string;
    oui_dir: string;
    sources: { dbip: string; oui: string };
    checked_at: string | null;
    next_check_at: string | null;
    updating: boolean;
    last_run: DatasetRun | null;
    attribution: string;
    refresh_days: number;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isId = (v: unknown): v is DatasetId => v === "country" || v === "asn" || v === "oui";
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function parseRun(raw: unknown): DatasetRun | null {
    const r = obj(raw);
    const at = str(r?.at);
    if (!r || !at) return null;
    const items = Array.isArray(r.items)
        ? r.items.flatMap((x): DatasetRunItem[] => {
              const o = obj(x);
              if (!o || !isId(o.id)) return [];
              const outcome = o.outcome === "updated" || o.outcome === "failed" ? o.outcome : "current";
              return [{ id: o.id, outcome, from: str(o.from), to: str(o.to), error: str(o.error) }];
          })
        : [];
    return { at, trigger: r.trigger === "auto" ? "auto" : "manual", by: str(r.by), items };
}

/** API 的回答 → 面板資料；看不懂 = null。/ The API answer, or null when it is not one. */
export function parseDatasets(raw: unknown): DatasetsView | null {
    const r = obj(raw);
    if (!r || !Array.isArray(r.items)) return null;
    const items = r.items.flatMap((x): DatasetItem[] => {
        const o = obj(x);
        if (!o || !isId(o.id)) return [];
        const u = obj(o.in_use);
        const f = obj(o.failure);
        return [
            {
                id: o.id,
                path: str(o.path) ?? "",
                present: o.present === true,
                size: num(o.size),
                modified: str(o.modified),
                release: str(o.release),
                in_use: u && str(u.file) ? { file: str(u.file)!, source: str(u.source) ?? "", built: str(u.built) } : null,
                vendors: num(o.vendors),
                due: o.due === true,
                failure: f && str(f.error) ? { at: str(f.at) ?? "", error: str(f.error)! } : null,
            },
        ];
    });
    const sources = obj(r.sources);
    return {
        auto_update: r.auto_update !== false,
        items,
        geoip_dir: str(r.geoip_dir) ?? "",
        oui_dir: str(r.oui_dir) ?? "",
        sources: { dbip: str(sources?.dbip) ?? "", oui: str(sources?.oui) ?? "" },
        checked_at: str(r.checked_at),
        next_check_at: str(r.next_check_at),
        updating: r.updating === true,
        last_run: parseRun(r.last_run),
        attribution: str(r.attribution) ?? "",
        refresh_days: num(r.refresh_days) ?? 30,
    };
}

/**
 * 一項的狀態：failed = 上次抓失敗；missing = 沒有任何資料；other = Telepy 的檔不在、但用著別的（MaxMind 之類）；
 * due = 裝著、自動更新會去看有沒有新的；current = 裝著而且是新的。
 * An item's state: the last fetch failed / no data at all / another file in use (MaxMind…) / due for a refresh / current.
 */
export type DatasetState = "current" | "due" | "other" | "missing" | "failed";

export function datasetState(item: DatasetItem): DatasetState {
    if (item.failure) return "failed";
    if (!item.present) return item.in_use ? "other" : "missing";
    return item.due ? "due" : "current";
}

export const STATE_TONE: Record<DatasetState, "success" | "warning" | "danger" | "info" | "muted"> = {
    current: "success",
    due: "info",
    other: "info",
    missing: "muted",
    failed: "danger",
};

/** 按鈕說「下載」還是「更新」。/ Whether the button says "Download" or "Update". */
export function needsDownload(item: DatasetItem): boolean {
    return !item.present;
}

/** 一次更新的摘要。/ A run's summary. */
export function runSummary(run: DatasetRun): { updated: DatasetRunItem[]; current: DatasetId[]; failed: DatasetRunItem[] } {
    return {
        updated: run.items.filter((i) => i.outcome === "updated"),
        current: run.items.filter((i) => i.outcome === "current").map((i) => i.id),
        failed: run.items.filter((i) => i.outcome === "failed"),
    };
}

/**
 * 說明圖：來源（DB-IP / IEEE）─ 下載 ─ Telepy 的資料夾 ─ 本機查詢 ─ 頁面上的地點與廠商。
 * The diagram: source ─ download ─ Telepy's folder ─ local lookups ─ places and vendors on the pages.
 */
export function datasetsFlow(view: DatasetsView | null): { source: SpotState; download: SpotState; telepy: SpotState; lookups: SpotState } {
    if (!view) return { source: "waiting", download: "waiting", telepy: "waiting", lookups: "waiting" };
    const anyFailed = view.items.some((i) => i.failure);
    const anyPresent = view.items.some((i) => i.present);
    const anyInUse = view.items.some((i) => i.in_use);
    return {
        source: anyPresent ? "ok" : "waiting",
        download: view.updating ? "active" : anyFailed ? "failed" : anyPresent ? "ok" : "waiting",
        telepy: anyInUse ? "ok" : "waiting",
        lookups: anyInUse ? "ok" : "waiting",
    };
}
