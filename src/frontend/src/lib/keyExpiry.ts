/**
 * 個人金鑰到期的小工具：選項（不到期 / 30 / 90 / 180 / 365 天 / 自選日期）轉成要送的 `expires_at`，以及卡片上的狀態。
 * 純函式，`keyExpiry.test.ts` 有測試。
 * Personal key expiry helpers: preset choices → the `expires_at` to send, and the state shown on a card.
 */
export const EXPIRY_PRESETS = ["never", "30", "90", "180", "365", "custom"] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

/** 本地日期 `YYYY-MM-DD`。/ A local `YYYY-MM-DD`. */
export function localDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天加 n 天（本地日期）。/ Today plus n days, as a local date. */
export function addDays(n: number, now: Date = new Date()): string {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return localDate(d);
}

/**
 * 選項 → 送給 API 的值：`undefined` = 不送（新增時讓伺服器用站台預設）；`null` = 不到期；
 * 其他是「那天本地時間結束」的 ISO 時間（帶時區，伺服器轉成 UTC）。
 * Choice → API value: undefined = omit (let the server apply its default), null = never, otherwise the end of
 * that local day as an ISO time with offset.
 */
export function expiryValue(preset: ExpiryPreset, customDate: string, mode: "create" | "update", now: Date = new Date()): string | null | undefined {
    if (preset === "never") return mode === "create" ? undefined : null;
    const date = preset === "custom" ? customDate : addDays(Number(preset), now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

export type ExpiryState = "none" | "ok" | "soon" | "expired";

/** 卡片上的狀態：7 天內到期是 soon。/ The card state; within 7 days is "soon". */
export function expiryState(expiresAt: string | null | undefined, now: number = Date.now()): ExpiryState {
    if (!expiresAt) return "none";
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) return "none";
    if (at <= now) return "expired";
    return at - now <= 7 * 86_400_000 ? "soon" : "ok";
}
