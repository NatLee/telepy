/**
 * 隧道卡片：上半是這條通道（狀態、名稱 / 埠 / 存取關係、說明），整塊點了就進通道頁面；下半是一條細線隔開的按鈕列
 * （開啟按鈕、埠轉發、「更多」選單），點這裡不會換頁。平的卡片：髮絲線邊框、hover 只加深邊框與名稱底線，沒有色條、
 * 光暈或位移。
 * Tunnel card: the upper part is the tunnel (status, name / port / access, description) and a click anywhere on it opens
 * the tunnel's page; below a hairline sits the button tray (open buttons, port forwarding, "More"), which never
 * navigates. Flat: hairline border, hover only firms the border and underlines the name — no accent bar, glow or lift.
 */
import React from "react";
import Link from "next/link";
import { tunnelPageUrl } from "@/lib/tunnelPage";
import { ArrowLeftRight, ChevronRight, Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { HEALTH_TILE, TunnelAccessBadges, TunnelLastSeen, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { liveHealth } from "@/lib/tunnelHealth";
import { TunnelEndpointChip, TunnelLanChip } from "@/components/tunnels/TunnelEndpoint";
import { HostKeyAlert } from "@/components/tunnels/HostKeyAlert";
import { DeviceWarningChip } from "@/components/tunnels/DeviceFacts";
import { DeviceNameChip } from "@/components/tunnels/DeviceInstall";
import { DeviceOsChip, TransportBadge } from "@/components/tunnels/DevicePlatform";
import { SshNameChip } from "@/components/tunnels/TunnelNameHelp";
import { TunnelPresenceButton } from "@/components/tunnels/TunnelPresence";
import { PinButton, TunnelLabels } from "@/components/tunnels/TunnelTags";
import { Button } from "@/components/ui/button";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { useRowLink } from "@/hooks/useRowLink";
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
    const health = liveHealth(tunnel, isActive);
    const href = tunnelPageUrl(tunnel.id);
    const open = useRowLink(href);
    return (
        <article
            data-refresh-item
            {...open}
            className="group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card transition-[border-color] duration-150 hover:border-foreground/25"
        >
            {/* 上半：整塊都能點（名稱仍是真的連結，給鍵盤與右鍵）。/ Upper part: all of it opens the page (the name stays a real link). */}
            <div className="group/open flex flex-1 flex-col transition-colors hover:bg-surface/50">
            <div className="flex items-start gap-3 p-4 pb-3">
                <div
                    className={cn(
                        "grid place-items-center size-9 rounded-md shrink-0 border transition-colors",
                        HEALTH_TILE[health]
                    )}
                    aria-hidden
                >
                    <Server size={17} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1">
                        {/* 名稱 = 通道頁面的連結（Ctrl / ⌘ 點開新分頁）。/ The name links to the tunnel's page. */}
                        <h3 className="flex min-w-0 items-center text-[1.125rem] leading-tight text-foreground" title={tunnel.host_friendly_name}>
                            <Link href={href} prefetch={false} className="min-w-0 truncate rounded-sm underline-offset-4 group-hover/open:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                                {tunnel.host_friendly_name}
                            </Link>
                            <ChevronRight size={16} className="shrink-0 text-muted-foreground/60 transition-colors group-hover/open:text-foreground" aria-hidden />
                        </h3>
                        <PinButton pinned={!!tunnel.pinned} onToggle={actions.onTogglePin ? () => actions.onTogglePin!(tunnel.id, !tunnel.pinned) : undefined} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-px font-mono text-[0.75rem] text-foreground/80" title={t("tunnels.portTitle")}>
                            :{tunnel.reverse_port}
                        </span>
                        <TransportBadge tunnel={tunnel} canManage={!!tunnel.can_share} onOpen={() => actions.onDetails(tunnel.id, "connection")} />
                        <DeviceOsChip endpoint={tunnel.endpoint} onOpen={() => actions.onDetails(tunnel.id, "device")} />
                        <TunnelEndpointChip endpoint={tunnel.endpoint} />
                        <TunnelLanChip endpoint={tunnel.endpoint} />
                        <HostKeyAlert changed={tunnel.host_key_changed} claimed={tunnel.device_claimed} onOpen={() => actions.onDetails(tunnel.id, "identity")} />
                        <DeviceWarningChip endpoint={tunnel.endpoint} onOpen={() => actions.onDetails(tunnel.id, "device")} />
                        <DeviceNameChip summary={tunnel.device_install} onOpen={() => actions.onDetails(tunnel.id, "connection")} />
                        <SshNameChip name={tunnel.host_friendly_name} onOpen={() => actions.onDetails(tunnel.id, "settings")} />
                        <TunnelAccessBadges tunnel={tunnel} sharedCount={sharedCount} onRequests={() => actions.onShare(tunnel.id)} onShare={() => actions.onShare(tunnel.id)} />
                        <TunnelPresenceButton presence={tunnel.presence} tunnelId={tunnel.id} />
                        <TunnelLabels labels={tunnel.labels} onLabel={actions.onLabel} />
                    </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                    <TunnelStatusPill health={health} lastSeenAt={tunnel.last_seen_at} />
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                    {health === "offline" && <TunnelLastSeen at={tunnel.last_seen_at} />}
                </div>
            </div>

            <div className="flex-1 px-4 pb-3">
                {tunnel.description ? (
                    <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2 break-words" title={tunnel.description}>
                        {tunnel.description}
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground/50 italic">{t("tunnels.noDescription")}</p>
                )}
            </div>
            </div>

            {/* 下半：按鈕列，點空白處也不換頁。/ Lower part: the button tray; a click on its gaps never navigates. */}
            <div data-row-ignore className="cursor-auto space-y-2 border-t border-border/70 p-4 pt-3">
                <TunnelOpenButtons tunnel={tunnel} online={isActive} degraded={health === "degraded"} />
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
