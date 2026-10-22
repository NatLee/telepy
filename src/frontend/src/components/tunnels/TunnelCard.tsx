/**
 * 隧道卡片：狀態（圓點 + 文字 + 延遲）、名稱 / 埠 / 存取關係、三顆「開啟」按鈕，底部是埠轉發捷徑與「更多」選單。
 * 平的卡片：髮絲線邊框、hover 只加深邊框，沒有色條、光暈或位移。
 * Tunnel card: status (dot + text + latency), name / port / access, three labelled "open" buttons, and a footer
 * with the port-forwarding shortcut plus the grouped "More" menu. Flat: hairline border, hover only firms the
 * border — no accent bar, glow or lift.
 */
import React from "react";
import { ArrowLeftRight, Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { TunnelAccessBadges, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { TunnelEndpointChip } from "@/components/tunnels/TunnelEndpoint";
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
            className="group relative flex flex-col h-full overflow-hidden rounded-xl border border-border bg-card shadow-card transition-[border-color] duration-150 hover:border-foreground/25"
        >
            <div className="flex items-start gap-3 p-4 pb-3">
                <div
                    className={cn(
                        "grid place-items-center size-9 rounded-md shrink-0 border transition-colors",
                        isActive ? "border-success/25 bg-success/10 text-success" : "border-border bg-surface text-muted-foreground"
                    )}
                    aria-hidden
                >
                    <Server size={17} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-[1.125rem] text-foreground truncate leading-tight" title={tunnel.host_friendly_name}>
                        {tunnel.host_friendly_name}
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-px font-mono text-[0.75rem] text-foreground/80" title={t("tunnels.portTitle")}>
                            :{tunnel.reverse_port}
                        </span>
                        <TunnelEndpointChip endpoint={tunnel.endpoint} />
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
                        className="flex-1 justify-start text-muted-foreground hover:text-foreground"
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
