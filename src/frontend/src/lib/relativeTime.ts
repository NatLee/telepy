/**
 * 「3 小時前」這類相對時間：交給 Intl.RelativeTimeFormat 依 locale 產生，不需要字典。
 * Locale-aware relative time ("3 hours ago") via Intl.RelativeTimeFormat; no dictionary keys needed.
 */
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Infinity],
];

export function formatRelativeTime(iso: string, locale: string, now: number = Date.now(), style: Intl.RelativeTimeFormatStyle = "long"): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    let value = (at - now) / 1000;
    for (const [unit, size] of STEPS) {
        if (Math.abs(value) < size) {
            return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style }).format(Math.trunc(value), unit);
        }
        value /= size;
    }
    return iso;
}

/** 秒 → 「3 分鐘」「2.5 小時」「4 天」（Intl 依語系翻單位）。/ Seconds → a localized duration in its largest unit. */
export function formatSpan(seconds: number, locale: string): string {
    const [value, unit] =
        seconds >= 86_400 ? [seconds / 86_400, "day"] : seconds >= 3_600 ? [seconds / 3_600, "hour"] : seconds >= 60 ? [seconds / 60, "minute"] : [seconds, "second"];
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(value);
}
