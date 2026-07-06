"use client";

/**
 * 通道列表頁：列出通道、WebSocket 通知、操作選單與彈窗。
 * Tunnels list page: list tunnels, WebSocket notifications, actions menu and modals.
 */
import React from "react";
import Link from "next/link";
import { TunnelModals } from "@/components/tunnels/TunnelModals";
import { Plus, Server, Info, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import { TunnelCard } from "@/components/tunnels/TunnelCard";
import { TunnelTableRow } from "@/components/tunnels/TunnelTableRow";
import { ViewToggle } from "@/components/ui/ViewToggle";

import { useTunnelsPage } from "@/hooks/useTunnelsPage";
import { useViewMode } from "@/hooks/useViewMode";
import { useI18n } from "@/lib/i18n";

export default function TunnelsPage() {
    const { t } = useI18n();
    const {
        tunnels,
        portsMap,
        latencyMap,
        loading,
        fetchData,
        handleDelete,
        handleLeaveTunnel,
        modals: {
            configModal, setConfigModal,
            scriptModal, setScriptModal,
            usersModal, setUsersModal,
            detailsModal, setDetailsModal,
            shareModal, setShareModal,
            deleteConfirm, setDeleteConfirm,
            leaveConfirm, setLeaveConfirm
        }
    } = useTunnelsPage();

    const [viewMode, setViewMode] = useViewMode("tunnels-view");

    const getStatus = (port: number) => {
        const isActive = portsMap[String(port)] === true;
        return (
            <Badge variant={isActive ? "default" : "secondary"} className={`${isActive ? 'bg-success hover:bg-success/90 text-success-foreground' : ''}`}>
                <span className={`w-2.5 h-2.5 rounded-full mr-1.5 ${isActive ? "bg-white animate-pulse" : "bg-muted-foreground"}`}></span>
                {isActive ? t("tunnels.online") : t("tunnels.offline")}
            </Badge>
        );
    };

    return (
        <div className="space-y-6 animate-fade-in-up">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground flex items-center gap-2 tracking-tight">
                        <Server className="text-primary animate-float" />
                        {t("tunnels.title")}
                        <TooltipProvider delayDuration={100}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button className="text-muted-foreground hover:text-primary transition-colors focus:outline-none" aria-label={t("tunnels.aboutAria")}>
                                        <Info size={18} />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs text-sm" sideOffset={8}>
                                    <p>
                                        {t("tunnels.aboutTooltip")}
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <WebSocketStatusBadge />
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {t("tunnels.subtitle")}
                    </p>
                </div>
                <div className="flex gap-2 items-center">
                    <div className="hidden min-[1200px]:flex items-center">
                        <ViewToggle value={viewMode} onChange={setViewMode} storageKey="tunnels-view" />
                        <div className="h-5 w-px bg-border mx-2"></div>
                    </div>
                    <Button variant="outline" onClick={fetchData} disabled={loading} aria-label={t("tunnels.refreshAria")}>
                        <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
                        {t("common.refresh")}
                    </Button>
                    <Button asChild>
                        <Link href="/tunnels/create" prefetch={false}>
                            <Plus size={16} className="mr-2" />
                            {t("tunnels.create")}
                        </Link>
                    </Button>
                </div>
            </div>



            {loading && tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                    {t("tunnels.loading")}
                </div>
            ) : tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-16 border-2 border-dashed border-border rounded-lg bg-card text-center">
                    <Server size={48} className="text-muted-foreground mb-4 opacity-50" />
                    <h3 className="text-xl font-semibold text-foreground tracking-tight">{t("tunnels.emptyTitle")}</h3>
                    <p className="mt-2 text-sm text-muted-foreground max-w-sm">{t("tunnels.emptyBody")}</p>
                    <div className="mt-6">
                        <Button asChild>
                            <Link href="/tunnels/create" prefetch={false}>
                                <Plus size={16} className="mr-2" />
                                {t("tunnels.new")}
                            </Link>
                        </Button>
                    </div>
                </div>
            ) : viewMode === "card" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tunnels.map((tunnel) => {
                        const isActive = portsMap[String(tunnel.reverse_port)] === true;
                        const latencyMs = latencyMap[String(tunnel.reverse_port)] ?? null;
                        const sharedCount = tunnel.shared_with_count ?? 0;
                        return (
                            <TunnelCard
                                key={tunnel.id}
                                tunnel={tunnel}
                                isActive={isActive}
                                latencyMs={latencyMs}
                                sharedCount={sharedCount}
                                getStatus={getStatus}
                                onDetails={(tunnelId: number) => setDetailsModal({ isOpen: true, tunnelId })}
                                onConfig={(tunnelId: number) => setConfigModal({ isOpen: true, tunnelId })}
                                onScript={(tunnelId: number) => setScriptModal({ isOpen: true, tunnelId, sshPort: 22 })}
                                onUsers={(tunnelId: number, readOnly: boolean) => setUsersModal({ isOpen: true, tunnelId, readOnly })}
                                onShare={(tunnelId: number) => setShareModal({ isOpen: true, tunnelId })}
                                onLeave={(tunnelId: number, name: string) => setLeaveConfirm({ isOpen: true, tunnelId, name })}
                                onDelete={(tunnelId: number, name: string) => setDeleteConfirm({ isOpen: true, tunnelId, name })}
                            />
                        );
                    })}
                </div>
            ) : (
                <div className="border border-border rounded-lg overflow-x-auto bg-card shadow-sm">
                    <table className="min-w-full divide-y divide-border">
                        <thead className="bg-muted/50">
                            <tr>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">{t("tunnels.thName")}</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">{t("tunnels.thPortStatus")}</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">{t("tunnels.thKeyPreview")}</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">{t("tunnels.thSharing")}</th>
                                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">{t("tunnels.thActions")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {tunnels.map((tunnel) => {
                                const isActive = portsMap[String(tunnel.reverse_port)] === true;
                                const latencyMs = latencyMap[String(tunnel.reverse_port)] ?? null;
                                const sharedCount = tunnel.shared_with_count ?? 0;
                                return (
                                    <TunnelTableRow
                                        key={tunnel.id}
                                        tunnel={tunnel}
                                        isActive={isActive}
                                        latencyMs={latencyMs}
                                        sharedCount={sharedCount}
                                        getStatus={getStatus}
                                        onDetails={(tunnelId: number) => setDetailsModal({ isOpen: true, tunnelId })}
                                        onConfig={(tunnelId: number) => setConfigModal({ isOpen: true, tunnelId })}
                                        onScript={(tunnelId: number) => setScriptModal({ isOpen: true, tunnelId, sshPort: 22 })}
                                        onUsers={(tunnelId: number, readOnly: boolean) => setUsersModal({ isOpen: true, tunnelId, readOnly })}
                                        onShare={(tunnelId: number) => setShareModal({ isOpen: true, tunnelId })}
                                        onLeave={(tunnelId: number, name: string) => setLeaveConfirm({ isOpen: true, tunnelId, name })}
                                        onDelete={(tunnelId: number, name: string) => setDeleteConfirm({ isOpen: true, tunnelId, name })}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <TunnelModals
                modals={{
                    configModal, setConfigModal,
                    scriptModal, setScriptModal,
                    usersModal, setUsersModal,
                    detailsModal, setDetailsModal,
                    shareModal, setShareModal,
                    deleteConfirm, setDeleteConfirm,
                    leaveConfirm, setLeaveConfirm
                }}
                tunnels={tunnels}
                fetchData={fetchData}
                handleDelete={handleDelete}
                handleLeaveTunnel={handleLeaveTunnel}
            />
        </div>
    );
}
