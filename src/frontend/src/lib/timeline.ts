/**
 * 依日期分組的事件列表（日誌頁、AI 活動頁）共用的純函式：本地日期鍵、今天 / 昨天、分組與標題、搜尋高亮切段。
 * `timeline.test.ts` 有測試。
 * Pure helpers shared by the day-grouped event lists (Logs, AI activity): local day keys, today / yesterday,
 * grouping with headings, and search-hit segments.
 */
import type { TranslationKey } from "@/locales/en";

type Translate = (k: TranslationKey, v?: Record<string, string | number>) => string;

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

export interface DayGroup<T> {
    day: string;
    items: T[];
}

/** 依本地日期把連續的項目分組，保留原順序（列表是新的在上）。/ Group consecutive items per local day, keeping the order. */
export function groupByDay<T extends { day: string }>(items: T[]): DayGroup<T>[] {
    const groups: DayGroup<T>[] = [];
    for (const item of items) {
        const last = groups[groups.length - 1];
        if (last && last.day === item.day) last.items.push(item);
        else groups.push({ day: item.day, items: [item] });
    }
    return groups;
}

export interface LabeledDayGroup<T> extends DayGroup<T> {
    /** 「今天 · 10月24日 週五」或只有日期。/ "Today · Fri, Oct 24", or just the date. */
    label: string;
}

/** 分組並加上標題；`date` 是依 locale 格式化好的日期。/ Group and add headings; `date` is the locale-formatted date. */
export function labelDays<T extends { day: string; date: string }>(items: T[], now: Date, t: Translate): LabeledDayGroup<T>[] {
    return groupByDay(items).map((g) => {
        const rel = dayRelation(g.day, now);
        const date = g.items[0].date;
        return { ...g, label: rel ? `${t(rel === "today" ? "ui.today" : "ui.yesterday")} · ${date}` : date };
    });
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
