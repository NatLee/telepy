/**
 * 側欄分頁:放在 Modal 的 `nav` 槽。桌面是一欄直排(圖示 + 標籤 + 可選的一行說明),手機是一列橫排。
 * 目前那一頁用中性底 + 品牌色圖示標出,和 Segmented 的選取樣式一致。
 * Side tabs for Modal's `nav` slot: a vertical list from `sm` up (icon + label + optional hint), a
 * horizontal row on phones. The current tab gets a neutral fill and a primary icon, like Segmented.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export interface NavTab<T extends string> {
    value: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
    /** 桌面上標籤下的一行小字。/ One-line hint under the label (desktop only). */
    hint?: React.ReactNode;
}

interface NavTabsProps<T extends string> {
    tabs: NavTab<T>[];
    value: T;
    onChange: (value: T) => void;
    "aria-label"?: string;
    className?: string;
    /**
     * `nav` = 頁面上的分頁（換的是網址）：導覽清單 + aria-current，目前那頁底下可以放 `below`（例如這一頁有哪幾塊），
     * 跟它框在同一格裡。預設 `tabs` = 對話框裡的分頁（tablist）。
     * `nav` = a page's tabs (they change the URL): a navigation list with aria-current, and `below` sits under the current
     * one inside the same box (e.g. the blocks of that tab). The default `tabs` = a dialog's tabs (a tablist).
     */
    as?: "tabs" | "nav";
    below?: React.ReactNode;
}

const ITEM = "flex items-start gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0";
const ACTIVE = "bg-card text-foreground ring-1 ring-border dark:bg-secondary [&_svg]:text-primary max-sm:bg-muted max-sm:ring-0";
const IDLE = "text-muted-foreground hover:bg-muted/70 hover:text-foreground";

function Label({ tab }: { tab: NavTab<string> }) {
    return (
        <>
            {tab.icon}
            <span className="min-w-0">
                <span className="block whitespace-nowrap sm:whitespace-normal">{tab.label}</span>
                {/* 目前那頁底下列出它的區塊時，這行說明就交給那份清單。/ When the current tab lists its blocks below, that list replaces the hint. */}
                {tab.hint && <span className="hidden text-xs leading-snug text-muted-foreground sm:block group-has-[[data-tab-below]]/item:hidden">{tab.hint}</span>}
            </span>
        </>
    );
}

export function NavTabs<T extends string>({ tabs, value, onChange, className, as = "tabs", below, ...rest }: NavTabsProps<T>) {
    if (as === "nav") {
        return (
            <nav aria-label={rest["aria-label"]}>
                <ul className={cn("flex min-w-max gap-1 sm:min-w-0 sm:flex-col", className)}>
                    {tabs.map((tab) => {
                        const active = tab.value === value;
                        return (
                            <li key={tab.value} className={cn("group/item rounded-md", active && ACTIVE)}>
                                <button
                                    type="button"
                                    aria-current={active ? "page" : undefined}
                                    onClick={() => onChange(tab.value)}
                                    className={cn(ITEM, "w-full", !active && IDLE)}
                                >
                                    <Label tab={tab} />
                                </button>
                                {active && below}
                            </li>
                        );
                    })}
                </ul>
            </nav>
        );
    }
    return (
        <div role="tablist" aria-orientation="vertical" aria-label={rest["aria-label"]} className={cn("flex min-w-max gap-1 sm:min-w-0 sm:flex-col", className)}>
            {tabs.map((tab) => {
                const active = tab.value === value;
                return (
                    <button
                        key={tab.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(tab.value)}
                        className={cn(ITEM, active ? ACTIVE : IDLE)}
                    >
                        <Label tab={tab} />
                    </button>
                );
            })}
        </div>
    );
}

/** 分頁標籤加一個點：有沒存的改動（品牌色）或要修正的欄位（紅）。/ A tab label with a dot for unsaved changes or a field to fix. */
export function NavTabLabel({ label, mark }: { label: React.ReactNode; mark: "error" | "dirty" | null }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1.5">
            {label}
            {mark && (
                <span
                    className={cn("size-1.5 shrink-0 rounded-full", mark === "error" ? "bg-destructive" : "bg-primary")}
                    role="img"
                    aria-label={t(mark === "error" ? "ui.tabHasError" : "ui.tabUnsaved")}
                />
            )}
        </span>
    );
}
