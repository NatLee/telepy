/**
 * 隧道表格列（≥1200px 的清單檢視）：名稱 + 說明、狀態 + 延遲、埠、存取關係、帶標籤的開啟按鈕與「更多」選單。
 * （埠那一欄下方是裝置的公網 IP；存取標籤旁是「N 人使用中」按鈕，點開才列出誰在用。）
 * Tunnel table row (list view, ≥1200px): name + description, status + latency, port (+ device IP), access (+ the
 * "N using" button that opens who is connected), labelled open buttons and the grouped "More" menu.
 */
import React from "react";
import { Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { HEALTH_TILE, TunnelAccessBadges, TunnelLastSeen, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { liveHealth } from "@/lib/tunnelHealth";
import { PinButton, TunnelLabels } from "@/components/tunnels/TunnelTags";
import { TunnelEndpointChip } from "@/components/tunnels/TunnelEndpoint";
import { TunnelPresenceButton } from "@/components/tunnels/TunnelPresence";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { cn } from "@/lib/utils";

interface TunnelTableRowProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    isActive: boolean;
    latencyMs: number | null;
    sharedCount: number;
}

export function TunnelTableRow({ tunnel, isActive, latencyMs, sharedCount, ...actions }: TunnelTableRowProps) {
    const health = liveHealth(tunnel, isActive);
    return (
        <tr className="group hover:bg-surface transition-colors">
            <td className="px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div
                        className={cn(
                            "grid place-items-center size-8 rounded-md shrink-0 border",
                            HEALTH_TILE[health]
                        )}
                        aria-hidden
                    >
                        <Server size={15} />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-1">
                            <p className="text-sm text-foreground truncate max-w-[18rem]" title={tunnel.host_friendly_name}>
                                {tunnel.host_friendly_name}
                            </p>
                            <PinButton pinned={!!tunnel.pinned} onToggle={actions.onTogglePin ? () => actions.onTogglePin!(tunnel.id, !tunnel.pinned) : undefined} />
                        </div>
                        {tunnel.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[18rem]" title={tunnel.description}>
                                {tunnel.description}
                            </p>
                        )}
                        <TunnelLabels labels={tunnel.labels} onLabel={actions.onLabel} className="mt-1" />
                    </div>
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2.5">
                    <TunnelStatusPill health={health} lastSeenAt={tunnel.last_seen_at} />
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                </div>
                {health === "offline" && <TunnelLastSeen at={tunnel.last_seen_at} className="mt-0.5 block" />}
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-col items-start gap-1">
                    <span className="rounded-sm bg-muted px-1.5 py-px font-mono text-xs text-foreground/80">:{tunnel.reverse_port}</span>
                    <TunnelEndpointChip endpoint={tunnel.endpoint} />
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-wrap items-center gap-1">
                    <TunnelAccessBadges tunnel={tunnel} sharedCount={sharedCount} />
                    <TunnelPresenceButton presence={tunnel.presence} />
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-2">
                    <TunnelOpenButtons tunnel={tunnel} online={isActive} degraded={health === "degraded"} variant="compact" />
                    <TunnelActions tunnel={tunnel} {...actions} />
                </div>
            </td>
        </tr>
    );
}
