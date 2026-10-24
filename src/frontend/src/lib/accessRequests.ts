/**
 * 存取申請的小工具：可選的時長、比現在高的權限、錯誤碼對應的字典鍵。純函式，`accessRequests.test.ts` 有測試。
 * Access request helpers: duration choices, the permissions above the current one, error code → dictionary key.
 */
import type { TranslationKey } from "@/locales/en";
import type { SharePermission } from "@/types/accessRequest";

const H = 3600;
const D = 24 * H;

/** 可選的時長（秒）與標籤。/ Duration choices (seconds) and their labels. */
export const REQUEST_DURATIONS: { secs: number; label: TranslationKey }[] = [
    { secs: H, label: "share.request.h1" },
    { secs: 4 * H, label: "share.request.h4" },
    { secs: 8 * H, label: "share.request.h8" },
    { secs: D, label: "share.request.d1" },
    { secs: 3 * D, label: "share.request.d3" },
    { secs: 7 * D, label: "share.request.d7" },
];

/** 時長的標籤；不在選項裡的（核准時改過）就用最接近的單位。/ Label for a duration, falling back to the nearest unit. */
export function durationLabel(secs: number): { key: TranslationKey; n?: number } {
    const preset = REQUEST_DURATIONS.find((d) => d.secs === secs);
    if (preset) return { key: preset.label };
    if (secs % D === 0) return { key: "share.request.days", n: secs / D };
    if (secs % H === 0) return { key: "share.request.hours", n: secs / H };
    return { key: "share.request.minutes", n: Math.ceil(secs / 60) };
}

const ORDER: SharePermission[] = ["view", "edit", "admin"];

/** 比現在高、而且能要的權限（admin 以上什麼都沒有）。/ Permissions above the current one. */
export function higherPermissions(current: string): SharePermission[] {
    const i = ORDER.indexOf(current as SharePermission);
    if (i < 0) return [];
    return ORDER.slice(i + 1);
}

const ERRORS: Record<string, TranslationKey> = {
    request_pending: "share.request.err.pending",
    nothing_requested: "share.request.err.nothing",
    permission_not_higher: "share.request.err.notHigher",
    bad_duration: "share.request.err.duration",
    reason_too_long: "share.request.err.reason",
    already_decided: "share.request.err.decided",
    share_gone: "share.request.err.shareGone",
    not_sharee: "share.request.err.notSharee",
};

/** 後端錯誤碼 → 字典鍵（沒對應的回 null，畫面就顯示後端訊息）。/ Error code → key (null: show the server's text). */
export function requestErrorKey(code: unknown): TranslationKey | null {
    return typeof code === "string" && code in ERRORS ? ERRORS[code] : null;
}
