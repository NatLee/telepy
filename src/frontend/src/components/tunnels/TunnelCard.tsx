import React from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, MonitorPlay, Share2, TerminalSquare } from "lucide-react";
import { Tunnel } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { useI18n } from "@/lib/i18n";

interface TunnelCardProps {
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

export function TunnelCard({
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
}: TunnelCardProps) {
    const { t } = useI18n();
    return (
        <Card
            className={`flex flex-col h-full hover:shadow-md transition-shadow ${!isActive ? "border-muted bg-muted/30 dark:bg-muted/40" : ""}`}
        >
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 p-4">
                <div className="space-y-1 min-w-0 pr-4">
                    <CardTitle className="text-lg font-semibold text-primary truncate" title={tunnel.host_friendly_name}>
                        {tunnel.host_friendly_name}
                    </CardTitle>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                        <Activity size={13} />
                        <span>{t("tunnels.portLabel")} <span className="font-mono font-medium text-foreground">{tunnel.reverse_port}</span></span>
                        {!tunnel.is_owner && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300">
                                <Share2 size={10} /> {t("tunnels.sharedWithYou")}
                            </Badge>
                        )}
                        {tunnel.is_owner && tunnel.can_share && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300">
                                <Share2 size={10} /> {t("tunnels.owner")}
                            </Badge>
                        )}
                        {tunnel.is_owner && sharedCount > 0 && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300">
                                <Share2 size={10} /> {t("tunnels.sharedWithCount", { count: sharedCount })}
                            </Badge>
                        )}
                    </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                    {getStatus(tunnel.reverse_port)}
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="sm" />}
                </div>
            </CardHeader>
            <CardContent className="flex-1 p-4 pt-1">
                <div className="space-y-3">
                    <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t("tunnels.publicKey")}</p>
                        <div className="bg-muted rounded px-2 py-1.5 font-mono text-[11px] truncate text-muted-foreground" title={tunnel.key ?? ''}>
                            {tunnel.key ? `${tunnel.key.substring(0, 45)}...` : '—'}
                        </div>
                    </div>
                    {tunnel.description && (
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{t("common.description")}</p>
                            <p className="text-xs text-foreground break-words line-clamp-2" title={tunnel.description}>
                                {tunnel.description}
                            </p>
                        </div>
                    )}
                </div>
            </CardContent>
            <CardFooter className="p-3 border-t border-border flex items-center gap-1.5 bg-muted/10 rounded-b-xl">
                {/* prefetch={false}：terminal 是「點了才進」的重頁（xterm/VNC），每張卡有兩條連結，
                    N 條隧道 = 2N 次 route prefetch，載入時一次湧出把伺服器/連線塞爆，害真正在等的
                    dashboard/profile 排隊變慢。點擊時才載入，代價僅是點下去多幾百毫秒，值得。
                    Don't prefetch the heavy terminal route for every tunnel — the 2N prefetch storm
                    starves the requests that actually gate the list spinner. */}
                <Button asChild variant={isActive ? "default" : "secondary"} size="sm" className={`flex-1 h-8 text-xs ${!isActive ? "opacity-60" : ""}`}>
                    <Link href={getTerminalPageUrl(tunnel)} prefetch={false}>
                        <TerminalSquare size={14} className="mr-1.5 shrink-0" /> {t("common.terminal")}
                    </Link>
                </Button>
                <Button asChild variant={isActive ? "outline" : "secondary"} size="sm" className={`flex-1 h-8 text-xs ${!isActive ? "opacity-60" : ""}`}>
                    <Link href={getTerminalPageUrl(tunnel, { mainView: "browser" })} prefetch={false}>
                        <MonitorPlay size={14} className="mr-1.5 shrink-0" /> {t("common.browser")}
                    </Link>
                </Button>
                <TunnelActions
                    tunnel={tunnel}
                    variant="card"
                    onDetails={onDetails}
                    onConfig={onConfig}
                    onScript={onScript}
                    onUsers={onUsers}
                    onShare={onShare}
                    onLeave={onLeave}
                    onDelete={onDelete}
                />
            </CardFooter>
        </Card>
    );
}
