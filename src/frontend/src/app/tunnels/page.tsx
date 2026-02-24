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

export default function TunnelsPage() {
    const {
        tunnels,
        portsMap,
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
                {isActive ? "Online" : "Offline"}
            </Badge>
        );
    };

    return (
        <div className="space-y-6 animate-fade-in-up">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground flex items-center gap-2 tracking-tight">
                        <Server className="text-primary animate-float" />
                        Tunnels
                        <TooltipProvider delayDuration={100}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button className="text-muted-foreground hover:text-primary transition-colors focus:outline-none" aria-label="About SSH Tunnels">
                                        <Info size={18} />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs text-sm" sideOffset={8}>
                                    <p>
                                        SSH reverse tunnels securely expose services on remote machines through this server. Use private keys to connect, manage tunnel public keys, and configure target server users below.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <WebSocketStatusBadge />
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Manage your reverse proxy tunnels and configurations.
                    </p>
                </div>
                <div className="flex gap-2 items-center">
                    <div className="hidden min-[1200px]:flex items-center">
                        <ViewToggle value={viewMode} onChange={setViewMode} storageKey="tunnels-view" />
                        <div className="h-5 w-px bg-border mx-2"></div>
                    </div>
                    <Button variant="outline" onClick={fetchData} disabled={loading} aria-label="Refresh tunnels">
                        <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                    <Button asChild>
                        <Link href="/tunnels/create">
                            <Plus size={16} className="mr-2" />
                            Create Tunnel
                        </Link>
                    </Button>
                </div>
            </div>



            {loading && tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                    Loading tunnels...
                </div>
            ) : tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-16 border-2 border-dashed border-border rounded-lg bg-card text-center">
                    <Server size={48} className="text-muted-foreground mb-4 opacity-50" />
                    <h3 className="text-xl font-semibold text-foreground tracking-tight">No tunnels found</h3>
                    <p className="mt-2 text-sm text-muted-foreground max-w-sm">Get started by creating a new reverse proxy tunnel to securely expose your local services.</p>
                    <div className="mt-6">
                        <Button asChild>
                            <Link href="/tunnels/create">
                                <Plus size={16} className="mr-2" />
                                New Tunnel
                            </Link>
                        </Button>
                    </div>
                </div>
            ) : viewMode === "card" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tunnels.map((tunnel) => {
                        const isActive = portsMap[String(tunnel.reverse_port)] === true;
                        const sharedCount = tunnel.shared_with_count ?? 0;
                        return (
                            <TunnelCard
                                key={tunnel.id}
                                tunnel={tunnel}
                                isActive={isActive}
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
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Name</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Port / Status</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Key Preview</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Sharing</th>
                                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {tunnels.map((tunnel) => {
                                const isActive = portsMap[String(tunnel.reverse_port)] === true;
                                const sharedCount = tunnel.shared_with_count ?? 0;
                                return (
                                    <TunnelTableRow
                                        key={tunnel.id}
                                        tunnel={tunnel}
                                        isActive={isActive}
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
