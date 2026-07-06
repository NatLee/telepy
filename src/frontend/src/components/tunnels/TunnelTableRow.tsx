import React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { MonitorPlay, Share2, TerminalSquare } from "lucide-react";
import { Tunnel } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { Button } from "@/components/ui/button";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { useI18n } from "@/lib/i18n";

interface TunnelTableRowProps {
    tunnel: Tunnel;
    isActive: boolean;
    latencyMs: number | null;
    sharedCount: number;
    getStatus: (port: number) => React.ReactNode;
    onDetails: (tunnelId: number) => void;
    onConfig: (tunnelId: number) => void;
    onScript: (tunnelId: number) => void;
    onUsers: (tunnelId: number, readOnly: boolean) => void;
    onShare: (tunnelId: number) => void;
    onLeave: (tunnelId: number, name: string) => void;
    onDelete: (tunnelId: number, name: string) => void;
}

export function TunnelTableRow({
    tunnel,
    isActive,
    latencyMs,
    sharedCount,
    getStatus,
    onDetails,
    onConfig,
    onScript,
    onUsers,
    onShare,
    onLeave,
    onDelete,
}: TunnelTableRowProps) {
    const { t } = useI18n();
    return (
        <tr className="hover:bg-muted/50 transition-colors">
            <td className="px-4 py-3 text-sm font-medium text-foreground whitespace-nowrap">
                {tunnel.host_friendly_name}
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono">{tunnel.reverse_port}</span>
                    {getStatus(tunnel.reverse_port)}
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="bg-muted/50 rounded px-2 py-1 font-mono text-[11px] truncate text-muted-foreground max-w-[150px]" title={tunnel.key ?? ''}>
                    {tunnel.key ? `${tunnel.key.substring(0, 15)}...` : '—'}
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-1">
                    {!tunnel.is_owner && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300">
                            <Share2 size={10} /> {t("tunnels.sharedWithYou")}
                        </Badge>
                    )}
                    {tunnel.is_owner && tunnel.can_share && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300">
                            <Share2 size={10} /> {t("tunnels.owner")}
                        </Badge>
                    )}
                    {tunnel.is_owner && sharedCount > 0 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300">
                            <Share2 size={10} /> {sharedCount === 1 ? "1" : sharedCount}
                        </Badge>
                    )}
                    {tunnel.is_owner && !tunnel.can_share && sharedCount === 0 && (
                        <span className="text-muted-foreground text-xs">—</span>
                    )}
                </div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-0.5">
                    {/* prefetch={false}：見 TunnelCard —— terminal 是重頁，每列 2 條連結，N 列 = 2N 次
                        prefetch，載入時湧出塞爆連線、拖慢真正在等的 dashboard/profile。點了才載入。
                        Don't prefetch the heavy terminal route per row (2N prefetch storm). */}
                    <Button asChild variant="ghost" size="sm" className={`h-8 px-2 text-xs transition-colors mr-0.5 ${isActive ? "text-primary hover:text-primary hover:bg-primary/10" : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50 opacity-60"}`}>
                        <Link href={getTerminalPageUrl(tunnel)} prefetch={false}>
                            <TerminalSquare size={14} className="mr-1.5" /> {t("common.terminal")}
                        </Link>
                    </Button>
                    <Button asChild variant="ghost" size="sm" className={`h-8 px-2 text-xs transition-colors mr-0.5 ${isActive ? "text-primary hover:text-primary hover:bg-primary/10" : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50 opacity-60"}`}>
                        <Link href={getTerminalPageUrl(tunnel, { mainView: "browser" })} prefetch={false}>
                            <MonitorPlay size={14} className="mr-1.5" /> {t("common.browser")}
                        </Link>
                    </Button>

                    <TunnelActions
                        tunnel={tunnel}
                        onDetails={onDetails}
                        onConfig={onConfig}
                        onScript={onScript}
                        onUsers={onUsers}
                        onShare={onShare}
                        onLeave={onLeave}
                        onDelete={onDelete}
                    />
                </div>
            </td>
        </tr>
    );
}
