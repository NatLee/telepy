/**
 * 清單底下的分頁列：「第 11–20 筆，共 47 筆」、每頁筆數、上一頁 / 頁碼 / 下一頁（手機只留「2 / 5」）。
 * 資料不超過最小的每頁筆數時整列不出現。換頁時若清單頂端已捲出畫面，就捲回清單頂端。
 * The pager under a list: "11–20 of 47", page size, previous / page numbers / next ("2 / 5" on phones). Hidden
 * while everything fits on the smallest page. Changing pages scrolls back to the list's top when it is off screen.
 */
import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pageWindow, PAGE_SIZES } from "@/lib/pagination";
import type { PaginationState } from "@/hooks/usePagination";

export function Pagination({
    pager,
    anchor,
    className,
}: {
    pager: PaginationState;
    /** 換頁後若它已捲出畫面就捲回來（清單或段落的頂端）。/ Scrolled back into view after a page change when off screen. */
    anchor?: React.RefObject<HTMLElement | null> | (() => HTMLElement | null);
    className?: string;
}) {
    const { t } = useI18n();
    if (pager.total <= PAGE_SIZES[0]) return null;
    const go = (p: number) => {
        pager.setPage(p);
        requestAnimationFrame(() => {
            const el = typeof anchor === "function" ? anchor() : anchor?.current;
            if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
        });
    };
    return (
        <nav aria-label={t("ui.page.aria")} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground", className)}>
            <span className="tabular-nums">{t("ui.page.range", { from: pager.from, to: pager.to, total: pager.total })}</span>
            <div className="flex flex-wrap items-center gap-2">
                <NativeSelect value={pager.size} onChange={(e) => pager.setSize(Number(e.target.value))} aria-label={t("ui.page.size")} className="w-auto [&>select]:h-8 [&>select]:text-xs">
                    {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>
                            {t("ui.page.sizeOption", { size: n })}
                        </option>
                    ))}
                </NativeSelect>
                {pager.count > 1 && (
                    <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon-sm" disabled={pager.page <= 1} onClick={() => go(pager.page - 1)} aria-label={t("ui.page.prev")} title={t("ui.page.prev")}>
                            <ChevronLeft />
                        </Button>
                        {pageWindow(pager.page, pager.count).map((p, i) =>
                            p === "gap" ? (
                                <span key={`gap-${i}`} className="hidden w-6 text-center sm:inline" aria-hidden>
                                    …
                                </span>
                            ) : (
                                <button
                                    key={p}
                                    type="button"
                                    onClick={() => go(p)}
                                    aria-label={t("ui.page.goto", { page: p })}
                                    aria-current={p === pager.page ? "page" : undefined}
                                    className={cn(
                                        "hidden h-8 min-w-8 place-items-center rounded-md px-1.5 tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:grid",
                                        p === pager.page ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                    )}
                                >
                                    {p}
                                </button>
                            )
                        )}
                        <span className="px-1.5 tabular-nums text-foreground sm:hidden">
                            {pager.page} / {pager.count}
                        </span>
                        <Button variant="ghost" size="icon-sm" disabled={pager.page >= pager.count} onClick={() => go(pager.page + 1)} aria-label={t("ui.page.next")} title={t("ui.page.next")}>
                            <ChevronRight />
                        </Button>
                    </div>
                )}
            </div>
        </nav>
    );
}
