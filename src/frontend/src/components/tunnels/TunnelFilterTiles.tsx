/**
 * 隧道統計方塊兼篩選器：全部 / 線上 / 離線 / 分享給我，點一下就只看那一類。
 * Tunnel stat tiles that double as the filter: all / online / offline / shared with me — click to narrow the list.
 */
import React from "react";
import { Layers, Share2, WifiOff, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

export type TunnelFilter = "all" | "online" | "offline" | "shared";

const TILES: { id: TunnelFilter; icon: LucideIcon; label: TranslationKey; tone: string; activeRing: string }[] = [
    { id: "all", icon: Layers, label: "tunnels.filterAll", tone: "bg-foreground/5 text-foreground", activeRing: "ring-foreground/25" },
    { id: "online", icon: Zap, label: "tunnels.filterOnline", tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", activeRing: "ring-emerald-500/45" },
    { id: "offline", icon: WifiOff, label: "tunnels.filterOffline", tone: "bg-muted text-muted-foreground", activeRing: "ring-muted-foreground/40" },
    { id: "shared", icon: Share2, label: "tunnels.filterShared", tone: "bg-info/10 text-info", activeRing: "ring-info/45" },
];

interface TunnelFilterTilesProps {
    counts: Record<TunnelFilter, number>;
    value: TunnelFilter;
    onChange: (value: TunnelFilter) => void;
}

export function TunnelFilterTiles({ counts, value, onChange }: TunnelFilterTilesProps) {
    const { t } = useI18n();
    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" role="group" aria-label={t("tunnels.filterAria")}>
            {TILES.map(({ id, icon: Icon, label, tone, activeRing }) => {
                const active = value === id;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(active && id !== "all" ? "all" : id)}
                        className={cn(
                            "group flex items-center gap-3 rounded-2xl border bg-card/80 backdrop-blur-sm p-3.5 text-left shadow-card transition-all duration-200",
                            "hover:-translate-y-px hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active ? cn("border-transparent ring-2", activeRing) : "border-border"
                        )}
                    >
                        <span className={cn("grid place-items-center w-10 h-10 rounded-xl shrink-0", tone)} aria-hidden>
                            <Icon size={18} />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-2xl font-bold leading-none tabular-nums text-foreground">{counts[id]}</span>
                            <span className="mt-1 block text-xs font-medium text-muted-foreground truncate">{t(label)}</span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
