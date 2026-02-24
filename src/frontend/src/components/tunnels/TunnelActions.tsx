import React from "react";
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
    Share2,
    FileText,
    Settings,
    Terminal,
    Users,
    MoreHorizontal,
    LogOut,
    Trash2
} from "lucide-react";
import { Tunnel } from "@/types/tunnel";

interface TunnelActionsProps {
    tunnel: Tunnel;
    onDetails: (tunnelId: number) => void;
    onConfig: (tunnelId: number) => void;
    onScript: (tunnelId: number) => void;
    onUsers: (tunnelId: number, readOnly: boolean) => void;
    onShare: (tunnelId: number) => void;
    onLeave: (tunnelId: number, name: string) => void;
    onDelete: (tunnelId: number, name: string) => void;
}

export function TunnelActions({
    tunnel,
    onDetails,
    onConfig,
    onScript,
    onUsers,
    onShare,
    onLeave,
    onDelete,
}: TunnelActionsProps) {
    return (
        <div className="flex items-center gap-0.5 shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onDetails(tunnel.id)} title="Details">
                <FileText size={15} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onConfig(tunnel.id)} title="Config">
                <Settings size={15} />
            </Button>
            {tunnel.is_owner && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onScript(tunnel.id)} title="Scripts">
                    <Terminal size={15} />
                </Button>
            )}

            {/* Non-owner: Actions logic */}
            {!tunnel.is_owner && (
                <>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onUsers(tunnel.id, !tunnel.can_edit)} title={tunnel.can_edit ? "Manage Target Server Users" : "View Target Server Users"}>
                        <Users size={15} />
                    </Button>

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
                            {tunnel.can_share && (
                                <>
                                    <DropdownMenuItem onClick={() => onShare(tunnel.id)}>
                                        <Share2 className="mr-2 h-4 w-4" /> Manage Sharing
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                </>
                            )}
                            <DropdownMenuItem
                                onClick={() => onLeave(tunnel.id, tunnel.host_friendly_name)}
                                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                            >
                                <LogOut className="mr-2 h-4 w-4" /> Leave Tunnel
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}

            {/* Owner: more actions dropdown */}
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
                            <DropdownMenuItem onClick={() => onUsers(tunnel.id, false)}>
                                <Users className="mr-2 h-4 w-4" /> Target Server Users
                            </DropdownMenuItem>
                        )}
                        {tunnel.can_share && (
                            <DropdownMenuItem onClick={() => onShare(tunnel.id)}>
                                <Share2 className="mr-2 h-4 w-4" /> Share Tunnel
                            </DropdownMenuItem>
                        )}
                        {tunnel.can_delete && (
                            <>
                                {(tunnel.can_edit || tunnel.can_share) && <DropdownMenuSeparator />}
                                <DropdownMenuItem
                                    onClick={() => onDelete(tunnel.id, tunnel.host_friendly_name)}
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
    );
}
