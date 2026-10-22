/**
 * 隧道卡片：狀態（頂部色條 + 膠囊 + 延遲）、名稱 / 埠 / 存取關係、三顆「開啟」方塊，底部是埠轉發捷徑與「更多」選單。
 * Tunnel card: status (top accent + pill + latency), name / port / access, three labelled "open" tiles, and a
 * footer with the port-forwarding shortcut plus the grouped "More" menu.
 */
import React from "react";
import { ArrowLeftRight, Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { TunnelAccessBadges, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { Button } from "@/components/ui/button";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface TunnelCardProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    isActive: boolean;
    latencyMs: number | null;
    sharedCount: number;
}

export function TunnelCard({ tunnel, isActive, latencyMs, sharedCount, ...actions }: TunnelCardProps) {
    const { t } = useI18n();
    return (
        <article
            className={cn(
                "group relative flex flex-col h-full overflow-hidden rounded-2xl border bg-card shadow-card transition-[box-shadow,border-color,translate] duration-300",
                isActive
                    ? "border-border/80 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-glow"
                    : "border-border/80 hover:shadow-card-hover"
            )}
        >
            {/* 頂部狀態色條 / Status accent bar */}
            <div className={cn("h-1 w-full", isActive ? "bg-brand-gradient" : "bg-muted-foreground/15")} aria-hidden />

            <div className="flex items-start gap-3 p-4 pb-3">
                <div
                    className={cn(
                        "grid place-items-center w-10 h-10 rounded-xl shrink-0 ring-1 ring-inset transition-colors",
                        isActive ? "bg-primary/10 text-primary ring-primary/20" : "bg-muted text-muted-foreground ring-border"
                    )}
                    aria-hidden
                >
                    <Server size={18} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-[17px] text-foreground truncate leading-tight" title={tunnel.host_friendly_name}>
                        {tunnel.host_friendly_name}
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80" title={t("tunnels.portTitle")}>
                            :{tunnel.reverse_port}
                        </span>
                        <TunnelAccessBadges tunnel={tunnel} sharedCount={sharedCount} />
                    </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                    <TunnelStatusPill online={isActive} />
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                </div>
            </div>

            <div className="flex-1 px-4">
                {tunnel.description ? (
                    <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2 break-words" title={tunnel.description}>
                        {tunnel.description}
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground/50 italic">{t("tunnels.noDescription")}</p>
                )}
            </div>

            <div className="p-4 pt-3 space-y-2">
                <TunnelOpenButtons tunnel={tunnel} online={isActive} />
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 justify-start text-muted-foreground hover:text-primary hover:bg-primary/8"
                        onClick={() => actions.onCommands(tunnel.id)}
                        title={t("tunnelActions.portForwardingHint")}
                    >
                        <ArrowLeftRight size={14} />
                        {t("tunnelActions.portForwarding")}
                    </Button>
                    <TunnelActions tunnel={tunnel} {...actions} />
                </div>
            </div>
        </article>
    );
}
