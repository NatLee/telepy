/**
 * 隧道表格列（≥1200px 的清單檢視）：名稱 + 說明、狀態 + 延遲、埠、存取關係、帶標籤的開啟按鈕與「更多」選單。
 * （埠那一欄下方是裝置的公網 IP。）
 * Tunnel table row (list view, ≥1200px): name + description, status + latency, port (+ device IP), access, labelled open
 * buttons and the grouped "More" menu.
 */
import React from "react";
import { Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { TunnelAccessBadges, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { TunnelEndpointChip } from "@/components/tunnels/TunnelEndpoint";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { cn } from "@/lib/utils";

interface TunnelTableRowProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    isActive: boolean;
    latencyMs: number | null;
    sharedCount: number;
}

export function TunnelTableRow({ tunnel, isActive, latencyMs, sharedCount, ...actions }: TunnelTableRowProps) {
    return (
        <tr className="group hover:bg-primary/[0.03] transition-colors">
            <td className="px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div
                        className={cn(
                            "grid place-items-center w-8 h-8 rounded-lg shrink-0 ring-1 ring-inset",
                            isActive ? "bg-primary/10 text-primary ring-primary/20" : "bg-muted text-muted-foreground ring-border"
                        )}
                        aria-hidden
                    >
                        <Server size={15} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate max-w-[18rem]" title={tunnel.host_friendly_name}>
                            {tunnel.host_friendly_name}
                        </p>
                        {tunnel.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[18rem]" title={tunnel.description}>
                                {tunnel.description}
                            </p>
                        )}
                    </div>
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2.5">
                    <TunnelStatusPill online={isActive} />
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-col items-start gap-1">
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80">:{tunnel.reverse_port}</span>
                    <TunnelEndpointChip endpoint={tunnel.endpoint} />
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <TunnelAccessBadges tunnel={tunnel} sharedCount={sharedCount} />
            </td>
            <td className="px-4 py-3 whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-2">
                    <TunnelOpenButtons tunnel={tunnel} online={isActive} variant="compact" />
                    <TunnelActions tunnel={tunnel} {...actions} />
                </div>
            </td>
        </tr>
    );
}
