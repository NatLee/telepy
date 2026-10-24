/**
 * 限時分享的小工具：選項（一直有效 / 1 小時 / 8 小時 / 1 天 / 7 天 / 30 天 / 到某天）轉成要送的 `expires_at`，以及顯示用的狀態。
 * 純函式，`shareExpiry.test.ts` 有測試。
 * Timed sharing helpers: a choice → the `expires_at` to send, and the state to show.
 */
import { addDays } from "./keyExpiry.ts";

export const SHARE_EXPIRY_PRESETS = ["never", "1h", "8h", "1d", "7d", "30d", "date"] as const;
export type ShareExpiryPreset = (typeof SHARE_EXPIRY_PRESETS)[number];

const HOUR = 3_600_000;
const SPAN: Record<Exclude<ShareExpiryPreset, "never" | "date">, number> = {
    "1h": HOUR,
    "8h": 8 * HOUR,
    "1d": 24 * HOUR,
    "7d": 7 * 24 * HOUR,
    "30d": 30 * 24 * HOUR,
};

/** 自選日期的最早值：明天（本地日期）。/ The earliest date to pick: tomorrow. */
export const minShareDate = (now: Date = new Date()) => addDays(1, now);

/**
 * 選項 → 送給 API 的值：`null` = 一直有效；時長從現在算；`date` = 那天本地時間結束；日期還沒選 = `undefined`。
 * Choice → API value: null = no end; spans count from now; `date` = the end of that local day; undefined while no date is picked.
 */
export function shareExpiryValue(preset: ShareExpiryPreset, date: string, now: Date = new Date()): string | null | undefined {
    if (preset === "never") return null;
    if (preset === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
        const [y, m, d] = date.split("-").map(Number);
        return new Date(y, m - 1, d, 23, 59, 59).toISOString();
    }
    return new Date(now.getTime() + SPAN[preset]).toISOString();
}

export type ShareExpiryState = "none" | "ok" | "soon" | "ending";

/** 一天內結束是 soon；過了但還沒被收掉（最多 30 秒）是 ending。/ Within a day = soon; past but not yet ended = ending. */
export function shareExpiryState(expiresAt: string | null | undefined, now: number = Date.now()): ShareExpiryState {
    if (!expiresAt) return "none";
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) return "none";
    if (at <= now) return "ending";
    return at - now <= 24 * HOUR ? "soon" : "ok";
}

/**
 * 「8 小時後」：四捨五入（剛設 8 小時不會顯示成 7 小時）；一小時內用分鐘，兩天內用小時。
 * "in 8 hours", rounded (a fresh 8-hour share doesn't read as 7); minutes under an hour, hours under two days.
 */
export function shareEndsIn(expiresAt: string, locale: string, now: number = Date.now()): string {
    const ms = Date.parse(expiresAt) - now;
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (ms < HOUR) return fmt.format(Math.max(1, Math.ceil(ms / 60_000)), "minute");
    if (ms < 48 * HOUR) return fmt.format(Math.round(ms / HOUR), "hour");
    return fmt.format(Math.round(ms / (24 * HOUR)), "day");
}
