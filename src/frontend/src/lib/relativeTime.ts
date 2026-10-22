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

export function formatRelativeTime(iso: string, locale: string, now: number = Date.now()): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    let value = (at - now) / 1000;
    for (const [unit, size] of STEPS) {
        if (Math.abs(value) < size) {
            return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.trunc(value), unit);
        }
        value /= size;
    }
    return iso;
}
