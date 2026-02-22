"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ConfigModal } from "@/components/tunnels/ConfigModal";
import { ServerScriptModal } from "@/components/tunnels/ServerScriptModal";
import { ManageUsersModal } from "@/components/tunnels/ManageUsersModal";
import { TunnelDetailsModal } from "@/components/tunnels/TunnelDetailsModal";
import { ShareModal } from "@/components/tunnels/ShareModal";
import { useNotificationWebSocket } from "@/lib/websocket";
import {
    Plus,
    TerminalSquare,
    Settings,
    Terminal,
    Users,
    Share2,
    FileText,
    Trash2,
    Server,
    Activity,
    MoreHorizontal,
    Info,
    RefreshCw,
    LogOut
} from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";

export default function TunnelsPage() {
    const [tunnels, setTunnels] = useState<any[]>([]);
    // Backend returns Dict[int, bool]: { "1024": true, "8080": false }
    const [portsMap, setPortsMap] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);

    // Modals state
    const [configModal, setConfigModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [scriptModal, setScriptModal] = useState<{ isOpen: boolean, tunnelId: number | null, sshPort: number | null }>({ isOpen: false, tunnelId: null, sshPort: null });
    const [usersModal, setUsersModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [detailsModal, setDetailsModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [shareModal, setShareModal] = useState<{ isOpen: boolean, tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });
    const [leaveConfirm, setLeaveConfirm] = useState<{ isOpen: boolean, tunnelId: number | null, name: string }>({ isOpen: false, tunnelId: null, name: "" });

    const { showSuccess, showError } = useToast();
    const { user } = useAuth();

    // Actually, we can just use the hook here and it will connect. 
    // If AppLayout also connected, there might be two connections.
    const { lastMessage } = useNotificationWebSocket();

    const fetchData = async () => {
        try {
            setLoading(true);
            const [keysRes, portsRes] = await Promise.all([
                apiFetch("/api/reverse/server/keys"),
                apiFetch("/api/reverse/server/status/ports")
            ]);

            if (keysRes.ok && portsRes.ok) {
                const keys = await keysRes.json();
                const ports = await portsRes.json();

                // Ensure keys is an array
                setTunnels(Array.isArray(keys) ? keys : []);
                // ports is a dict like { "1024": true, "8080": false }
                setPortsMap(typeof ports === 'object' && ports !== null ? ports : {});
            } else {
                showError("Failed to fetch tunnel data");
            }
        } catch (e: any) {
            showError(e.message || "Failed to fetch tunnel data");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update ports map from websocket notification.
    // Backend wraps messages as: { message: { action: "...", ... } }
    useEffect(() => {
        if (!lastMessage?.message) return;
        const { action, data, port, status } = lastMessage.message;

        if (action === "UPDATE-TUNNEL-STATUS-DATA" && Array.isArray(data)) {
            // Backend sends list of currently ACTIVE ports for this user
            const map: Record<string, boolean> = {};
            for (const p of data) {
                map[String(p)] = true;
            }
            setPortsMap(map);
        } else if (action === "UPDATE-TUNNEL-STATUS" && port !== undefined) {
            // Individual port status change
            setPortsMap(prev => ({ ...prev, [String(port)]: status === "connected" }));
        }
    }, [lastMessage]);

    // Handle share/unshare/permission WS notifications by refreshing tunnel list
    useEffect(() => {
        if (!lastMessage?.message) return;
        const { action } = lastMessage.message;
        if (action === "TUNNEL-SHARED" || action === "TUNNEL-UNSHARED" || action === "TUNNEL-PERMISSION-UPDATED") {
            fetchData();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastMessage]);

    const handleDelete = async () => {
        if (!deleteConfirm.tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${deleteConfirm.tunnelId}`, {
                method: "DELETE"
            });
            if (res.ok) {
                showSuccess(`Tunnel '${deleteConfirm.name}' deleted`);
                fetchData();
            } else {
                showError("Failed to delete tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to delete tunnel");
        }
    };

    const handleLeaveTunnel = async (tunnelId: number, tunnelName: string) => {
        if (!user?.id) { showError("Failed to get current user"); return; }
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${user.id}`, { method: "DELETE" });
            if (res.ok) {
                showSuccess(`You left tunnel '${tunnelName}'`);
                fetchData();
            } else {
                showError("Failed to leave tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to leave tunnel");
        }
    };

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
                <div className="flex gap-2">
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
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tunnels.map((tunnel) => {
                        const hasMoreActions = tunnel.can_edit || tunnel.can_share || tunnel.can_delete || !tunnel.is_owner;
                        return (
                            <Card key={tunnel.id} className="flex flex-col h-full hover:shadow-md transition-shadow">
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
                                <CardFooter className="p-3 border-t border-border flex justify-between items-center gap-1.5 bg-muted/10 rounded-b-xl">
                                    <Button asChild variant="default" size="sm" className="flex-1 h-8 text-xs shrink-0 min-w-0">
                                        <Link href={`/tunnels/terminal?serverId=${tunnel.id}&port=${tunnel.reverse_port}`} className="truncate">
                                            <TerminalSquare size={14} className="mr-1.5 shrink-0" /> <span className="truncate">Terminal</span>
                                        </Link>
                                    </Button>

                                    <div className="flex items-center gap-0.5 shrink-0">
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => setDetailsModal({ isOpen: true, tunnelId: tunnel.id })} title="Details">
                                            <FileText size={15} />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => setConfigModal({ isOpen: true, tunnelId: tunnel.id })} title="Config">
                                            <Settings size={15} />
                                        </Button>
                                        {tunnel.is_owner && (
                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => setScriptModal({ isOpen: true, tunnelId: tunnel.id, sshPort: tunnel.reverse_port })} title="Scripts">
                                                <Terminal size={15} />
                                            </Button>
                                        )}

                                        {/* Non-owner: direct Leave button instead of dropdown */}
                                        {!tunnel.is_owner && (
                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10 transition-colors" onClick={() => setLeaveConfirm({ isOpen: true, tunnelId: tunnel.id, name: tunnel.host_friendly_name })} title="Leave Tunnel">
                                                <LogOut size={15} />
                                            </Button>
                                        )}

                                        {/* Owner: more actions dropdown (only if have any actions) */}
                                        {tunnel.is_owner && (tunnel.can_edit || tunnel.can_share || tunnel.can_delete) && (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                                                        <span className="sr-only">Open menu</span>
                                                        <MoreHorizontal size={15} />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48">
                                                    <DropdownMenuLabel>More Actions</DropdownMenuLabel>
                                                    <DropdownMenuSeparator />
                                                    {tunnel.can_edit && (
                                                        <DropdownMenuItem onClick={() => setUsersModal({ isOpen: true, tunnelId: tunnel.id })}>
                                                            <Users className="mr-2 h-4 w-4" /> Target Server Users
                                                        </DropdownMenuItem>
                                                    )}
                                                    {tunnel.can_share && (
                                                        <DropdownMenuItem onClick={() => setShareModal({ isOpen: true, tunnelId: tunnel.id })}>
                                                            <Share2 className="mr-2 h-4 w-4" /> Share Tunnel
                                                        </DropdownMenuItem>
                                                    )}
                                                    {tunnel.can_delete && (
                                                        <>
                                                            {(tunnel.can_edit || tunnel.can_share) && <DropdownMenuSeparator />}
                                                            <DropdownMenuItem
                                                                onClick={() => setDeleteConfirm({ isOpen: true, tunnelId: tunnel.id, name: tunnel.host_friendly_name })}
                                                                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                                                            >
                                                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                                                            </DropdownMenuItem>
                                                        </>
                                                    )}
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    </div>
                                </CardFooter>
                            </Card>
                        );
                    })}
                </div>
            )}

            <ConfigModal
                isOpen={configModal.isOpen}
                onClose={() => setConfigModal({ isOpen: false, tunnelId: null })}
                tunnelId={configModal.tunnelId}
            />
            <ServerScriptModal
                isOpen={scriptModal.isOpen}
                onClose={() => setScriptModal({ isOpen: false, tunnelId: null, sshPort: null })}
                tunnelId={scriptModal.tunnelId}
                sshPort={scriptModal.sshPort}
            />
            <ManageUsersModal
                isOpen={usersModal.isOpen}
                onClose={() => setUsersModal({ isOpen: false, tunnelId: null })}
                tunnelId={usersModal.tunnelId}
            />
            <TunnelDetailsModal
                isOpen={detailsModal.isOpen}
                onClose={() => setDetailsModal({ isOpen: false, tunnelId: null })}
                tunnelId={detailsModal.tunnelId}
                onUpdate={fetchData}
            />
            <ShareModal
                isOpen={shareModal.isOpen}
                onClose={() => setShareModal({ isOpen: false, tunnelId: null })}
                tunnelId={shareModal.tunnelId}
            />

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, tunnelId: null, name: "" })}
                onConfirm={handleDelete}
                title="Delete Tunnel"
                message={
                    <span>
                        Are you sure you want to delete tunnel <strong className="font-semibold">{deleteConfirm.name}</strong>? This action cannot be undone.
                    </span>
                }
                confirmText="Delete"
                isDestructive={true}
            />
            <ConfirmDialog
                isOpen={leaveConfirm.isOpen}
                onClose={() => setLeaveConfirm({ isOpen: false, tunnelId: null, name: "" })}
                onConfirm={() => {
                    if (leaveConfirm.tunnelId && leaveConfirm.name) {
                        handleLeaveTunnel(leaveConfirm.tunnelId, leaveConfirm.name);
                    }
                    setLeaveConfirm({ isOpen: false, tunnelId: null, name: "" });
                }}
                title="Leave Tunnel"
                message={
                    <span>
                        Are you sure you want to leave tunnel <strong className="font-semibold">{leaveConfirm.name}</strong>? You will lose access to this tunnel until the owner shares it with you again.
                    </span>
                }
                confirmText="Leave"
                isDestructive={true}
            />
        </div>
    );
}
