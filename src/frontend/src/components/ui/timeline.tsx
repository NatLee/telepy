/**
 * 依日期分組的事件列表的共用元件（日誌頁、AI 活動頁）：每天一段、標題黏在篩選列下方；搜尋命中標示。
 * 頁面自己整頁捲動，外層卡片用 overflow-clip（不建立捲動容器，sticky 才會跟著整頁），篩選列用 `useStickyBar`。
 * Shared pieces of the day-grouped event lists (Logs, AI activity): one section per day whose heading sticks under
 * the filter bar, and search-hit highlighting. The page scrolls as a whole; the card uses overflow-clip (no scroll
 * container, so sticky follows the page) and the filter bar uses `useStickyBar`.
 */
import React from "react";
import { highlightSegments } from "@/lib/timeline";

/** 搜尋命中處用螢光標示。/ Marks the search hits in a text. */
export function Highlighted({ text, query }: { text: string; query: string }) {
    return (
        <>
            {highlightSegments(text, query).map((seg, i) =>
                seg.hit ? (
                    <mark key={i} className="rounded-sm bg-primary/20 text-foreground">
                        {seg.text}
                    </mark>
                ) : (
                    <React.Fragment key={i}>{seg.text}</React.Fragment>
                )
            )}
        </>
    );
}

/**
 * 一天的區段：標題（日期 + 筆數）在手機黏在 Header 下方，sm 以上黏在篩選列下方（篩選列在手機不黏）。
 * One day: the heading (date + count) sticks under the header on phones and under the filter bar from sm
 * (the bar itself only sticks from sm).
 */
export function TimelineDay({ label, count, level = 2, children }: { label: string; count: string; level?: 2 | 3; children: React.ReactNode }) {
    const Heading = level === 3 ? "h3" : "h2";
    return (
        <section aria-label={label} className="border-t border-border first:border-t-0">
            <Heading className="sticky top-16 z-10 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-foreground sm:top-[calc(4rem+var(--sticky-bar))] lg:px-5">
                <span>{label}</span>
                <span className="text-muted-foreground tabular-nums">{count}</span>
            </Heading>
            <ol data-refresh-list className="divide-y divide-border">{children}</ol>
        </section>
    );
}
