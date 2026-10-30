/**
 * 伺服器健康頁的「即時狀態」：解析 `GET /api/site/health/stats`（每個欄位都可能缺——舊的或部分的後端也能畫出有的部分）、
 * 位元組 / 運作時間格式、通道狀態長條的比例、每小時長條圖的刻度。全部是純函式（有測試）。
 * The Server health page's live status: parsing `GET /api/site/health/stats` (every field may be missing, so an older
 * or partial backend still renders what it has), byte / uptime formatting, the tunnel bar's shares and the hourly
 * charts' scale. All pure (tested).
 */

export type TunnelState = "online" | "degraded" | "offline" | "never";
export const TUNNEL_STATES: TunnelState[] = ["online", "degraded", "offline", "never"];

/** 已知的 session 種類（順序 = 顯示順序）；其他種類照原名接在後面。/ Known session kinds in display order; others follow by name. */
export const KNOWN_SESSION_KINDS = ["terminal", "files", "browser", "desktop", "rustdesk", "ssh", "watch", "ai"] as const;

export const HOURS = 24;

export interface ServerStats {
    server: { version: string | null; started_at: string | null; uptime_secs: number | null; now: string | null } | null;
    tunnels: { total: number | null; online: number | null; degraded: number | null; offline: number | null; never: number | null } | null;
    gateway: { connections: number | null; forwards: number | null } | null;
    sessions: { total: number | null; by_kind: Record<string, number> } | null;
    users: { total: number | null; active: number | null; admins: number | null; signed_in_24h: number | null } | null;
    storage: {
        db_bytes: number | null;
        wal_bytes: number | null;
        data_dir: { path: string | null; free_bytes: number | null; total_bytes: number | null } | null;
        recordings_bytes: number | null;
        logs_bytes: number | null;
    } | null;
    activity: {
        hours: string[] | null;
        gateway_events: number[] | null;
        gateway_problems: number[] | null;
        sign_ins: number[] | null;
        sign_ins_failed: number[] | null;
        api_calls: number[] | null;
        api_errors: number[] | null;
    } | null;
    webhooks: { total: number | null; enabled: number | null; paused: number | null; failing_recent: number | null } | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** 24 個非負數字，否則當作沒有。/ Exactly 24 non-negative numbers, else missing. */
function series(v: unknown): number[] | null {
    if (!Array.isArray(v) || v.length !== HOURS) return null;
    return v.every((x) => num(x) !== null) ? (v as number[]) : null;
}

function hourList(v: unknown): string[] | null {
    if (!Array.isArray(v) || v.length !== HOURS) return null;
    return v.every((x) => typeof x === "string" && !Number.isNaN(Date.parse(x))) ? (v as string[]) : null;
}

/** 一個物件裡全部欄位都是 null 時當作整塊沒有。/ A block whose fields are all null counts as missing. */
function some<T extends Obj>(o: T): T | null {
    return Object.values(o).some((v) => v !== null) ? o : null;
}

export function parseServerStats(raw: unknown): ServerStats | null {
    const r = obj(raw);
    if (!r) return null;
    const s = obj(r.server);
    const t = obj(r.tunnels);
    const g = obj(r.gateway);
    const se = obj(r.sessions);
    const u = obj(r.users);
    const st = obj(r.storage);
    const a = obj(r.activity);
    const w = obj(r.webhooks);

    let sessions: ServerStats["sessions"] = null;
    if (se) {
        const by_kind: Record<string, number> = {};
        const kinds = obj(se.by_kind);
        if (kinds) for (const [k, v] of Object.entries(kinds)) if (num(v) !== null) by_kind[k] = v as number;
        const total = num(se.total);
        if (total !== null || Object.keys(by_kind).length) sessions = { total, by_kind };
    }
    const dd = st ? obj(st.data_dir) : null;
    const out: ServerStats = {
        server: s ? some({ version: str(s.version), started_at: str(s.started_at), uptime_secs: num(s.uptime_secs), now: str(s.now) }) : null,
        tunnels: t ? some({ total: num(t.total), online: num(t.online), degraded: num(t.degraded), offline: num(t.offline), never: num(t.never) }) : null,
        gateway: g ? some({ connections: num(g.connections), forwards: num(g.forwards) }) : null,
        sessions,
        users: u ? some({ total: num(u.total), active: num(u.active), admins: num(u.admins), signed_in_24h: num(u.signed_in_24h) }) : null,
        storage: st
            ? some({
                db_bytes: num(st.db_bytes),
                wal_bytes: num(st.wal_bytes),
                data_dir: dd ? some({ path: str(dd.path), free_bytes: num(dd.free_bytes), total_bytes: num(dd.total_bytes) }) : null,
                recordings_bytes: num(st.recordings_bytes),
                logs_bytes: num(st.logs_bytes),
            })
            : null,
        activity: a
            ? some({
                hours: hourList(a.hours),
                gateway_events: series(a.gateway_events),
                gateway_problems: series(a.gateway_problems),
                sign_ins: series(a.sign_ins),
                sign_ins_failed: series(a.sign_ins_failed),
                api_calls: series(a.api_calls),
                api_errors: series(a.api_errors),
            })
            : null,
        webhooks: w ? some({ total: num(w.total), enabled: num(w.enabled), paused: num(w.paused), failing_recent: num(w.failing_recent) }) : null,
    };
    return Object.values(out).some((v) => v !== null) ? out : null;
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"] as const;

/** 1024 進位、最大的單位、最多一位小數（10 以上不帶小數）；單位名稱交給 Intl。/ Base 1024, the largest unit, Intl unit names. */
export function formatBytes(bytes: number, locale: string): string {
    let v = Math.max(0, bytes);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
        v /= 1024;
        i++;
    }
    // 不到 1 KB 用「B」：Intl 的 byte 單位在中日文會寫成「0 byte」。/ Under 1 KB use "B": Intl's byte unit reads "0 byte" in zh / ja.
    if (i === 0) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v)} B`;
    const digits = v >= 10 ? 0 : 1;
    return new Intl.NumberFormat(locale, { style: "unit", unit: BYTE_UNITS[i], unitDisplay: "short", maximumFractionDigits: digits }).format(v);
}

/** 秒 → 天 / 時 / 分。/ Seconds → whole days / hours / minutes. */
export function uptimeParts(secs: number): { days: number; hours: number; minutes: number } {
    const s = Math.max(0, Math.floor(secs));
    return { days: Math.floor(s / 86_400), hours: Math.floor((s % 86_400) / 3_600), minutes: Math.floor((s % 3_600) / 60) };
}

/** 「3 天 4 小時」：最大的兩個非零單位（不到一分鐘 = 0 分鐘）。/ The two largest non-zero units ("3 days 4 hr"). */
export function formatUptime(secs: number, locale: string): string {
    const p = uptimeParts(secs);
    const parts: [number, "day" | "hour" | "minute"][] = [
        [p.days, "day"],
        [p.hours, "hour"],
        [p.minutes, "minute"],
    ];
    const first = parts.findIndex(([v]) => v > 0);
    if (first < 0) return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(0);
    return parts
        .slice(first, first + 2)
        .filter(([v]) => v > 0)
        .map(([v, unit]) => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(v))
        .join(" ");
}

export interface Segment {
    state: TunnelState;
    count: number;
    /** 整數百分比，所有段加起來剛好 100（最大餘數法）。/ Whole percent; all segments sum to exactly 100 (largest remainder). */
    pct: number;
}

/** 通道狀態長條：只留非零的段；全部是零 = 空陣列。/ The tunnel bar: non-zero segments only; nothing at all = []. */
export function tunnelSegments(t: Partial<Record<TunnelState, number | null>>): Segment[] {
    const counts = TUNNEL_STATES.map((state) => ({ state, count: Math.max(0, t[state] ?? 0) })).filter((s) => s.count > 0);
    const sum = counts.reduce((a, s) => a + s.count, 0);
    if (sum === 0) return [];
    const raw = counts.map((s) => ({ ...s, exact: (s.count / sum) * 100 }));
    const out = raw.map((s) => ({ state: s.state, count: s.count, pct: Math.floor(s.exact) }));
    let left = 100 - out.reduce((a, s) => a + s.pct, 0);
    const order = raw.map((s, i) => ({ i, rem: s.exact - Math.floor(s.exact) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (const { i } of order) {
        if (left <= 0) break;
        out[i].pct++;
        left--;
    }
    return out;
}

/** 刻度上限：≥ n 的最小 1 / 2 / 5 × 10^k；0 → 1。/ The axis top: the smallest 1 / 2 / 5 × 10^k ≥ n; 0 → 1. */
export function niceMax(n: number): number {
    if (!(n > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(n));
    for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
    return 10 * p;
}

/** 每小時一根：總數（含問題）與其中的問題數，問題不超過總數。/ One bar per hour: total (problems included) and the problems. */
export interface HourBar {
    total: number;
    sub: number;
}

export function hourBars(total: number[] | null, sub: number[] | null): HourBar[] | null {
    if (!total && !sub) return null;
    return Array.from({ length: HOURS }, (_, i) => {
        const s = sub?.[i] ?? 0;
        return { total: Math.max(total?.[i] ?? 0, s), sub: s };
    });
}

export function barsSummary(bars: HourBar[]): { total: number; sub: number; max: number; maxAt: number } {
    let total = 0;
    let sub = 0;
    let max = 0;
    let maxAt = 0;
    bars.forEach((b, i) => {
        total += b.total;
        sub += b.sub;
        if (b.total > max) {
            max = b.total;
            maxAt = i;
        }
    });
    return { total, sub, max, maxAt };
}

/** 24 小時內三張圖全部是零（或沒有資料）= 安靜。/ Nothing in any of the charts = quiet. */
export function isQuiet(a: ServerStats["activity"]): boolean {
    if (!a) return true;
    const all = [a.gateway_events, a.gateway_problems, a.sign_ins, a.sign_ins_failed, a.api_calls, a.api_errors];
    return all.every((s) => !s || s.every((v) => v === 0));
}

/** 磁碟剩餘比例（0–1），不知道 = null。/ Free share of the data disk, null when unknown. */
export function diskFree(d: { free_bytes: number | null; total_bytes: number | null } | null | undefined): number | null {
    if (!d || d.free_bytes === null || !d.total_bytes) return null;
    return Math.min(1, Math.max(0, d.free_bytes / d.total_bytes));
}

export const LOW_DISK = 0.1;

/** 已知種類照固定順序，其餘照名字；零的不列。/ Known kinds in fixed order, then the rest by name; zeros left out. */
export function sessionKinds(byKind: Record<string, number>): [string, number][] {
    const known = KNOWN_SESSION_KINDS as readonly string[];
    const rest = Object.keys(byKind).filter((k) => !known.includes(k)).sort();
    return [...known, ...rest].filter((k) => (byKind[k] ?? 0) > 0).map((k) => [k, byKind[k]]);
}

/** 在第幾根畫時間標：每 6 小時一個。/ Which bars carry an hour label: every 6 hours. */
export const LABEL_EVERY = 6;
export function labelIndexes(): number[] {
    return Array.from({ length: HOURS / LABEL_EVERY }, (_, i) => i * LABEL_EVERY);
}
