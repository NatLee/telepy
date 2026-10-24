/**
 * 日誌頁的小工具：事件種類 → 標籤色 / 分類、篩選、依日期分組、搜尋高亮切段。純函式，`gatewayLogs.test.ts` 有測試。
 * Logs page helpers: event kind → badge tone / category, filtering, grouping by day and highlight segments.
 */
import type { TranslationKey } from "@/locales/en";

/** 事件分類，給「需要注意 / 連線 / 工作階段 / 設定與操作」篩選用。/ Event categories behind the type filter. */
export type LogCategory = "problem" | "connection" | "session" | "change";
export type CategoryFilter = "all" | LogCategory;
export const CATEGORY_FILTERS: CategoryFilter[] = ["all", "problem", "connection", "session", "change"];

export type EventTone = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

export interface EventKind {
    key: TranslationKey;
    tone: EventTone;
    category: LogCategory;
}

// 標籤依 gateway 的 `event` 欄位決定（不是比對訊息字串），所以可以翻譯。不在表裡的種類照原字顯示，只出現在「全部」。
// Badges key off the gateway's `event` field (not message text), so their labels are translatable. Unknown kinds
// show verbatim and only under "all".
export const EVENT_KINDS: Record<string, EventKind> = {
    listening: { key: "logs.event.listening", tone: "outline", category: "connection" },
    accepted: { key: "logs.event.accepted", tone: "default", category: "connection" },
    forward: { key: "logs.event.forward", tone: "default", category: "connection" },
    forward_released: { key: "logs.event.forward_released", tone: "secondary", category: "connection" },
    disconnect: { key: "logs.event.disconnect", tone: "secondary", category: "connection" },
    preauth_close: { key: "logs.event.preauth_close", tone: "outline", category: "connection" },
    recovered: { key: "logs.event.recovered", tone: "success", category: "connection" },
    ip_changed: { key: "logs.event.ip_changed", tone: "warning", category: "connection" },
    join: { key: "logs.event.join", tone: "outline", category: "connection" },
    refused_forward: { key: "logs.event.refused_forward", tone: "destructive", category: "problem" },
    refused_direct: { key: "logs.event.refused_direct", tone: "destructive", category: "problem" },
    refused_proxy: { key: "logs.event.refused_proxy", tone: "destructive", category: "problem" },
    failed_publickey: { key: "logs.event.failed_publickey", tone: "destructive", category: "problem" },
    invalid_user: { key: "logs.event.invalid_user", tone: "destructive", category: "problem" },
    expired_key: { key: "logs.event.expired_key", tone: "destructive", category: "problem" },
    host_key_mismatch: { key: "logs.event.host_key_mismatch", tone: "destructive", category: "problem" },
    degraded: { key: "logs.event.degraded", tone: "warning", category: "problem" },
    step_up_required: { key: "logs.event.step_up_required", tone: "warning", category: "problem" },
    terminal_open: { key: "logs.event.terminal_open", tone: "default", category: "session" },
    lan_terminal: { key: "logs.event.lan_terminal", tone: "default", category: "session" },
    terminal_close: { key: "logs.event.terminal_close", tone: "secondary", category: "session" },
    files_open: { key: "logs.event.files_open", tone: "default", category: "session" },
    files_close: { key: "logs.event.files_close", tone: "secondary", category: "session" },
    browser_open: { key: "logs.event.browser_open", tone: "default", category: "session" },
    browser_close: { key: "logs.event.browser_close", tone: "secondary", category: "session" },
    desktop_open: { key: "logs.event.desktop_open", tone: "default", category: "session" },
    desktop_close: { key: "logs.event.desktop_close", tone: "secondary", category: "session" },
    session_ended: { key: "logs.event.session_ended", tone: "warning", category: "session" },
    recording_setting: { key: "logs.event.recording_setting", tone: "outline", category: "change" },
    recording_deleted: { key: "logs.event.recording_deleted", tone: "outline", category: "change" },
    step_up_setting: { key: "logs.event.step_up_setting", tone: "outline", category: "change" },
    access_request: { key: "logs.event.access_request", tone: "outline", category: "change" },
    host_key_pinned: { key: "logs.event.host_key_pinned", tone: "outline", category: "change" },
    host_key_accepted: { key: "logs.event.host_key_accepted", tone: "warning", category: "change" },
    host_key_forgotten: { key: "logs.event.host_key_forgotten", tone: "secondary", category: "change" },
    lan_scan: { key: "logs.event.lan_scan", tone: "outline", category: "change" },
};

/** 頁面需要的欄位（`useLogsPage` 的 LogEntry 是它的超集）。/ The fields these helpers read (LogEntry is a superset). */
export interface LogLike {
    event: string;
    message: string;
    at: string;
    /** 本地日期鍵 YYYY-MM-DD。/ Local day key, YYYY-MM-DD. */
    day: string;
    /** 依 locale 格式化的時間與日期（給搜尋比對）。/ Locale-formatted time and date (searched too). */
    time: string;
    date: string;
}

export interface LogFilter {
    query: string;
    category: CategoryFilter;
    /** 事件標籤的顯示文字，讓搜尋也能比對翻譯後的標籤。/ Badge text, so the search also matches translated labels. */
    label?: (event: string) => string;
}

export function categoryOf(event: string): LogCategory | null {
    return EVENT_KINDS[event]?.category ?? null;
}

function matchesQuery<T extends LogLike>(log: T, q: string, label?: (event: string) => string): boolean {
    if (!q) return true;
    return (
        log.message.toLowerCase().includes(q) ||
        log.event.includes(q) ||
        (label ? label(log.event).toLowerCase().includes(q) : false) ||
        log.time.toLowerCase().includes(q) ||
        log.date.toLowerCase().includes(q) ||
        log.at.toLowerCase().includes(q)
    );
}

export function filterLogs<T extends LogLike>(logs: T[], f: LogFilter): T[] {
    const q = f.query.trim().toLowerCase();
    return logs.filter((log) => (f.category === "all" || categoryOf(log.event) === f.category) && matchesQuery(log, q, f.label));
}

/** 套用搜尋後每個分類各有幾筆（分類鈕上的數字）。/ Per-category counts after the search (the numbers on the filter). */
export function countByCategory<T extends LogLike>(logs: T[], query: string, label?: (event: string) => string): Record<CategoryFilter, number> {
    const q = query.trim().toLowerCase();
    const counts: Record<CategoryFilter, number> = { all: 0, problem: 0, connection: 0, session: 0, change: 0 };
    for (const log of logs) {
        if (!matchesQuery(log, q, label)) continue;
        counts.all += 1;
        const c = categoryOf(log.event);
        if (c) counts[c] += 1;
    }
    return counts;
}

export interface DayGroup<T> {
    day: string;
    items: T[];
}

/** 依本地日期把連續的事件分組，保留原順序（頁面是新的在上）。/ Group consecutive events per local day, keeping the order. */
export function groupByDay<T extends LogLike>(logs: T[]): DayGroup<T>[] {
    const groups: DayGroup<T>[] = [];
    for (const log of logs) {
        const last = groups[groups.length - 1];
        if (last && last.day === log.day) last.items.push(log);
        else groups.push({ day: log.day, items: [log] });
    }
    return groups;
}

/** 本地時區的 YYYY-MM-DD。/ YYYY-MM-DD in the local time zone. */
export function dayKey(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 這一天是今天、昨天，還是更早。/ Whether a day key is today, yesterday or earlier. */
export function dayRelation(day: string, now: Date): "today" | "yesterday" | null {
    if (day === dayKey(now)) return "today";
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return day === dayKey(y) ? "yesterday" : null;
}

export interface Segment {
    text: string;
    hit: boolean;
}

/** 把文字切成命中 / 未命中搜尋字的片段（不分大小寫）。/ Split text into search hits and the rest (case-insensitive). */
export function highlightSegments(text: string, query: string): Segment[] {
    const q = query.trim().toLowerCase();
    if (!q) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    // 少數字元轉小寫後長度會變（例如 İ），位置就對不上，乾脆不標。/ A few characters change length when lower-cased; skip then.
    if (lower.length !== text.length) return [{ text, hit: false }];
    const out: Segment[] = [];
    let from = 0;
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, from)) {
        if (i > from) out.push({ text: text.slice(from, i), hit: false });
        out.push({ text: text.slice(i, i + q.length), hit: true });
        from = i + q.length;
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out;
}
