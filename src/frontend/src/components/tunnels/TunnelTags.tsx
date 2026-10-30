/**
 * 釘選按鈕（每個人自己的）與標籤小方塊（大家共用；點一下就用 `label:x` 篩選列表）。卡片與表格共用。
 * The pin toggle (per user) and label chips (shared; clicking one filters the list by `label:x`).
 * Shared by the card and the table row.
 */
import React from "react";
import { Pin, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { quiet, type RowVariant } from "@/components/tunnels/quiet";

export function PinButton({ pinned, onToggle, className }: { pinned: boolean; onToggle?: () => void; className?: string }) {
    const { t } = useI18n();
    if (!onToggle) return null;
    const label = pinned ? t("tunnels.unpin") : t("tunnels.pin");
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={pinned}
            aria-label={label}
            title={label}
            className={cn(
                "grid size-6 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                pinned ? "text-primary hover:bg-primary/10" : "text-muted-foreground/50 hover:bg-muted hover:text-foreground",
                className
            )}
        >
            <Pin size={14} className={pinned ? "fill-current" : undefined} />
        </button>
    );
}

export function TunnelLabels({ labels, onLabel, variant = "chip", className }: { labels?: string[]; onLabel?: (label: string) => void; variant?: RowVariant; className?: string }) {
    const { t } = useI18n();
    if (!labels || labels.length === 0) return null;
    return (
        <span className={cn("inline-flex flex-wrap items-center", variant === "text" ? "gap-x-2" : "gap-1", className)}>
            {labels.map((l) => (
                <button
                    key={l}
                    type="button"
                    onClick={onLabel ? () => onLabel(l) : undefined}
                    disabled={!onLabel}
                    title={t("tunnels.filterByLabel", { label: l })}
                    className={
                        variant === "text"
                            ? quiet("muted", "disabled:pointer-events-none")
                            : "inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-px text-[0.75rem] text-foreground/75 transition-colors hover:border-foreground/30 hover:text-foreground disabled:pointer-events-none [&>svg]:size-3"
                    }
                >
                    <Tag aria-hidden /> {l}
                </button>
            ))}
        </span>
    );
}
