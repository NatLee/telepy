/**
 * 日誌頁的小工具：事件種類 → 標籤色 / 分類、篩選。純函式，`gatewayLogs.test.ts` 有測試；依日期分組與高亮在 `timeline.ts`。
 * Logs page helpers: event kind → badge tone / category and filtering; day grouping and highlighting live in `timeline.ts`.
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
    standby_forward: { key: "logs.event.standby_forward", tone: "outline", category: "connection" },
    handover: { key: "logs.event.handover", tone: "default", category: "connection" },
    service_renamed: { key: "logs.event.service_renamed", tone: "outline", category: "change" },
    service_switched: { key: "logs.event.service_switched", tone: "outline", category: "change" },
    service_extra_removed: { key: "logs.event.service_extra_removed", tone: "outline", category: "change" },
    disconnect: { key: "logs.event.disconnect", tone: "secondary", category: "connection" },
    preauth_close: { key: "logs.event.preauth_close", tone: "outline", category: "connection" },
    recovered: { key: "logs.event.recovered", tone: "success", category: "connection" },
    ip_changed: { key: "logs.event.ip_changed", tone: "warning", category: "connection" },
    join: { key: "logs.event.join", tone: "outline", category: "connection" },
    refused_forward: { key: "logs.event.refused_forward", tone: "destructive", category: "problem" },
    refused_direct: { key: "logs.event.refused_direct", tone: "destructive", category: "problem" },
    refused_proxy: { key: "logs.event.refused_proxy", tone: "destructive", category: "problem" },
    proxy_unlisted: { key: "logs.event.proxy_unlisted", tone: "warning", category: "problem" },
    failed_publickey: { key: "logs.event.failed_publickey", tone: "destructive", category: "problem" },
    invalid_user: { key: "logs.event.invalid_user", tone: "destructive", category: "problem" },
    expired_key: { key: "logs.event.expired_key", tone: "destructive", category: "problem" },
    host_key_mismatch: { key: "logs.event.host_key_mismatch", tone: "destructive", category: "problem" },
    claim_refused: { key: "logs.event.claim_refused", tone: "destructive", category: "problem" },
    claim_attempt: { key: "logs.event.claim_attempt", tone: "destructive", category: "problem" },
    device_warning: { key: "logs.event.device_warning", tone: "warning", category: "problem" },
    degraded: { key: "logs.event.degraded", tone: "warning", category: "problem" },
    step_up_required: { key: "logs.event.step_up_required", tone: "warning", category: "problem" },
    terminal_open: { key: "logs.event.terminal_open", tone: "default", category: "session" },
    lan_terminal: { key: "logs.event.lan_terminal", tone: "default", category: "session" },
    terminal_close: { key: "logs.event.terminal_close", tone: "secondary", category: "session" },
    files_open: { key: "logs.event.files_open", tone: "default", category: "session" },
    files_close: { key: "logs.event.files_close", tone: "secondary", category: "session" },
    files_delete: { key: "logs.event.files_delete", tone: "warning", category: "change" },
    files_edit: { key: "logs.event.files_edit", tone: "outline", category: "change" },
    browser_open: { key: "logs.event.browser_open", tone: "default", category: "session" },
    browser_close: { key: "logs.event.browser_close", tone: "secondary", category: "session" },
    desktop_open: { key: "logs.event.desktop_open", tone: "default", category: "session" },
    desktop_close: { key: "logs.event.desktop_close", tone: "secondary", category: "session" },
    rustdesk_open: { key: "logs.event.rustdesk_open", tone: "default", category: "session" },
    rustdesk_close: { key: "logs.event.rustdesk_close", tone: "secondary", category: "session" },
    rustdesk_file_delete: { key: "logs.event.rustdesk_file_delete", tone: "warning", category: "change" },
    rustdesk_file_rename: { key: "logs.event.rustdesk_file_rename", tone: "outline", category: "change" },
    session_ended: { key: "logs.event.session_ended", tone: "warning", category: "session" },
    terminal_watch: { key: "logs.event.terminal_watch", tone: "warning", category: "session" },
    terminal_watch_end: { key: "logs.event.terminal_watch_end", tone: "secondary", category: "session" },
    terminal_control_granted: { key: "logs.event.terminal_control_granted", tone: "warning", category: "session" },
    terminal_control_revoked: { key: "logs.event.terminal_control_revoked", tone: "secondary", category: "session" },
    recording_setting: { key: "logs.event.recording_setting", tone: "outline", category: "change" },
    terminal_detach_setting: { key: "logs.event.terminal_detach_setting", tone: "outline", category: "change" },
    recording_deleted: { key: "logs.event.recording_deleted", tone: "outline", category: "change" },
    step_up_setting: { key: "logs.event.step_up_setting", tone: "outline", category: "change" },
    access_request: { key: "logs.event.access_request", tone: "outline", category: "change" },
    command_blocked: { key: "logs.event.command_blocked", tone: "destructive", category: "problem" },
    command_held: { key: "logs.event.command_held", tone: "warning", category: "session" },
    command_approved: { key: "logs.event.command_approved", tone: "success", category: "session" },
    command_denied: { key: "logs.event.command_denied", tone: "destructive", category: "session" },
    command_expired: { key: "logs.event.command_expired", tone: "secondary", category: "session" },
    command_cancelled: { key: "logs.event.command_cancelled", tone: "secondary", category: "session" },
    command_rule: { key: "logs.event.command_rule", tone: "outline", category: "change" },
    webhook: { key: "logs.event.webhook", tone: "outline", category: "change" },
    webhook_optout: { key: "logs.event.webhook_optout", tone: "outline", category: "change" },
    user_group: { key: "logs.event.user_group", tone: "outline", category: "change" },
    feature_grant: { key: "logs.event.feature_grant", tone: "outline", category: "change" },
    notify_default: { key: "logs.event.notify_default", tone: "outline", category: "change" },
    health_ack: { key: "logs.event.health_ack", tone: "outline", category: "change" },
    audit_reseal: { key: "logs.event.audit_reseal", tone: "warning", category: "change" },
    carriers_updated: { key: "logs.event.carriers_updated", tone: "outline", category: "change" },
    carriers_update_failed: { key: "logs.event.carriers_update_failed", tone: "warning", category: "problem" },
    api_token: { key: "logs.event.api_token", tone: "outline", category: "change" },
    user_key_import: { key: "logs.event.user_key_import", tone: "outline", category: "change" },
    token_call: { key: "logs.event.token_call", tone: "outline", category: "change" },
    host_key_pinned: { key: "logs.event.host_key_pinned", tone: "outline", category: "change" },
    service_key_migrated: { key: "logs.event.service_key_migrated", tone: "success", category: "change" },
    device_key_owner_disabled: { key: "logs.event.device_key_owner_disabled", tone: "warning", category: "change" },
    host_key_accepted: { key: "logs.event.host_key_accepted", tone: "warning", category: "change" },
    host_key_forgotten: { key: "logs.event.host_key_forgotten", tone: "secondary", category: "change" },
    device_key_changed: { key: "logs.event.device_key_changed", tone: "warning", category: "change" },
    reverse_port_changed: { key: "logs.event.reverse_port_changed", tone: "outline", category: "change" },
    lan_scan: { key: "logs.event.lan_scan", tone: "outline", category: "change" },
};

/** 頁面需要的欄位（`useLogsPage` 的 LogEntry 是它的超集）。/ The fields these helpers read (LogEntry is a superset). */
export interface LogLike {
    event: string;
    message: string;
    at: string;
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
