/**
 * 隧道篩選列：全部 / 線上 / 離線 / 分享給我，每格帶數量，點一下就只看那一類。
 * 做成一條帶外框的分段控制（像 Teleport 資源頁的篩選），不是四張統計卡。
 * Tunnel filter bar: all / online / offline / shared with me, each with its count — click to narrow the list.
 * A bordered segmented control (like the Teleport resources page filters), not four stat cards.
 */
import React from "react";
import { Layers, Share2, WifiOff, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

export type TunnelFilter = "all" | "online" | "offline" | "shared";

const TILES: { id: TunnelFilter; icon: LucideIcon; label: TranslationKey; iconClass: string }[] = [
    { id: "all", icon: Layers, label: "tunnels.filterAll", iconClass: "" },
    { id: "online", icon: Zap, label: "tunnels.filterOnline", iconClass: "text-success" },
    { id: "offline", icon: WifiOff, label: "tunnels.filterOffline", iconClass: "" },
    { id: "shared", icon: Share2, label: "tunnels.filterShared", iconClass: "text-info" },
];

interface TunnelFilterTilesProps {
    counts: Record<TunnelFilter, number>;
    value: TunnelFilter;
    onChange: (value: TunnelFilter) => void;
}

export function TunnelFilterTiles({ counts, value, onChange }: TunnelFilterTilesProps) {
    const { t } = useI18n();
    return (
        <div
            className="grid grid-cols-2 gap-0.5 rounded-md border border-border bg-surface p-0.5 sm:inline-grid sm:auto-cols-fr sm:grid-flow-col"
            role="group"
            aria-label={t("tunnels.filterAria")}
        >
            {TILES.map(({ id, icon: Icon, label, iconClass }) => {
                const active = value === id;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(active && id !== "all" ? "all" : id)}
                        className={cn(
                            "flex min-w-0 items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                            active ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Icon size={15} className={cn("shrink-0", active ? iconClass : "")} aria-hidden />
                        <span className="truncate">{t(label)}</span>
                        <span className={cn("rounded-sm px-1.5 py-px font-mono text-xs tabular-nums", active ? "bg-muted text-foreground" : "bg-muted/70 text-muted-foreground")}>
                            {counts[id]}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
