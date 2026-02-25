import React from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, MonitorPlay, Share2, TerminalSquare } from "lucide-react";
import { Tunnel } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";

interface TunnelCardProps {
    tunnel: Tunnel;
    isActive: boolean;
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
                        <span>Port: <span className="font-mono font-medium text-foreground">{tunnel.reverse_port}</span></span>
                        {!tunnel.is_owner && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300">
                                <Share2 size={10} /> Shared with you
                            </Badge>
                        )}
                        {tunnel.is_owner && tunnel.can_share && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300">
                                <Share2 size={10} /> Owner
                            </Badge>
                        )}
                        {tunnel.is_owner && sharedCount > 0 && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-1 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300">
                                <Share2 size={10} /> {sharedCount === 1 ? "Shared with 1" : `Shared with ${sharedCount}`}
                            </Badge>
                        )}
                    </div>
                </div>
                <div className="shrink-0">{getStatus(tunnel.reverse_port)}</div>
            </CardHeader>
            <CardContent className="flex-1 p-4 pt-1">
                <div className="space-y-3">
                    <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Public Key</p>
                        <div className="bg-muted rounded px-2 py-1.5 font-mono text-[11px] truncate text-muted-foreground" title={tunnel.key ?? ''}>
                            {tunnel.key ? `${tunnel.key.substring(0, 45)}...` : '—'}
                        </div>
                    </div>
                    {tunnel.description && (
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Description</p>
                            <p className="text-xs text-foreground break-words line-clamp-2" title={tunnel.description}>
                                {tunnel.description}
                            </p>
                        </div>
                    )}
                </div>
            </CardContent>
            <CardFooter className="p-3 border-t border-border flex flex-col gap-2 bg-muted/10 rounded-b-xl">
                <div className="flex w-full gap-1.5">
                    <Button asChild variant={isActive ? "default" : "secondary"} size="sm" className={`flex-1 h-8 text-xs ${!isActive ? "opacity-60" : ""}`}>
                        <Link href={getTerminalPageUrl(tunnel)}>
                            <TerminalSquare size={14} className="mr-1.5 shrink-0" /> Terminal
                        </Link>
                    </Button>
                    <Button asChild variant={isActive ? "outline" : "secondary"} size="sm" className={`flex-1 h-8 text-xs ${!isActive ? "opacity-60" : ""}`}>
                        <Link href={getTerminalPageUrl(tunnel, { mainView: "browser" })}>
                            <MonitorPlay size={14} className="mr-1.5 shrink-0" /> Browser
                        </Link>
                    </Button>
                </div>
                <div className="flex w-full justify-center">
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
            </CardFooter>
        </Card>
    );
}
