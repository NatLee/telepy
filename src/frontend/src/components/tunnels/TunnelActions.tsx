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
import { useI18n } from "@/lib/i18n";

interface TunnelActionsProps {
    tunnel: Tunnel;
    variant?: "table" | "card";
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
    variant = "table",
    onDetails,
    onConfig,
    onScript,
    onUsers,
    onShare,
    onLeave,
    onDelete,
}: TunnelActionsProps) {
    const { t } = useI18n();
    // ─── Card mode: single "More" dropdown with all actions ───
    if (variant === "card") {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label={t("tunnelActions.aria")}>
                        <MoreHorizontal size={16} />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onDetails(tunnel.id)}>
                        <FileText className="mr-2 h-4 w-4" /> {t("common.details")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onConfig(tunnel.id)}>
                        <Settings className="mr-2 h-4 w-4" /> {t("tunnelActions.config")}
                    </DropdownMenuItem>
                    {tunnel.is_owner && (
                        <DropdownMenuItem onClick={() => onScript(tunnel.id)}>
                            <Terminal className="mr-2 h-4 w-4" /> {t("tunnelActions.scripts")}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onUsers(tunnel.id, !tunnel.can_edit)}>
                        <Users className="mr-2 h-4 w-4" /> {tunnel.can_edit ? t("tunnelActions.targetServerUsers") : t("tunnelActions.viewUsers")}
                    </DropdownMenuItem>
                    {tunnel.can_share && (
                        <DropdownMenuItem onClick={() => onShare(tunnel.id)}>
                            <Share2 className="mr-2 h-4 w-4" /> {tunnel.is_owner ? t("tunnelActions.shareTunnel") : t("tunnelActions.manageSharing")}
                        </DropdownMenuItem>
                    )}
                    {(tunnel.can_delete || !tunnel.is_owner) && <DropdownMenuSeparator />}
                    {!tunnel.is_owner && (
                        <DropdownMenuItem
                            onClick={() => onLeave(tunnel.id, tunnel.host_friendly_name)}
                            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                        >
                            <LogOut className="mr-2 h-4 w-4" /> {t("tunnelActions.leaveTunnel")}
                        </DropdownMenuItem>
                    )}
                    {tunnel.can_delete && (
                        <DropdownMenuItem
                            onClick={() => onDelete(tunnel.id, tunnel.host_friendly_name)}
                            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                        >
                            <Trash2 className="mr-2 h-4 w-4" /> {t("common.delete")}
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    // ─── Table mode (default): inline icon buttons + overflow dropdown ───
    return (
        <div className="flex items-center gap-0.5 shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onDetails(tunnel.id)} title={t("common.details")} aria-label={t("common.details")}>
                <FileText size={15} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onConfig(tunnel.id)} title={t("tunnelActions.config")} aria-label={t("tunnelActions.config")}>
                <Settings size={15} />
            </Button>
            {tunnel.is_owner && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onScript(tunnel.id)} title={t("tunnelActions.scripts")} aria-label={t("tunnelActions.scripts")}>
                    <Terminal size={15} />
                </Button>
            )}

            {!tunnel.is_owner && (
                <>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10" onClick={() => onUsers(tunnel.id, !tunnel.can_edit)} title={tunnel.can_edit ? t("tunnelActions.manageTargetUsers") : t("tunnelActions.viewTargetUsers")} aria-label={tunnel.can_edit ? t("tunnelActions.manageTargetUsers") : t("tunnelActions.viewTargetUsers")}>
                        <Users size={15} />
                    </Button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                                <span className="sr-only">{t("tunnelActions.openMenu")}</span>
                                <MoreHorizontal size={15} />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>{t("tunnelActions.moreActions")}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {tunnel.can_share && (
                                <>
                                    <DropdownMenuItem onClick={() => onShare(tunnel.id)}>
                                        <Share2 className="mr-2 h-4 w-4" /> {t("tunnelActions.manageSharing")}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                </>
                            )}
                            <DropdownMenuItem
                                onClick={() => onLeave(tunnel.id, tunnel.host_friendly_name)}
                                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                            >
                                <LogOut className="mr-2 h-4 w-4" /> {t("tunnelActions.leaveTunnel")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}

            {tunnel.is_owner && (tunnel.can_edit || tunnel.can_share || tunnel.can_delete) && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                            <span className="sr-only">{t("tunnelActions.openMenu")}</span>
                            <MoreHorizontal size={15} />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>{t("tunnelActions.moreActions")}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {tunnel.can_edit && (
                            <DropdownMenuItem onClick={() => onUsers(tunnel.id, false)}>
                                <Users className="mr-2 h-4 w-4" /> {t("tunnelActions.targetServerUsers")}
                            </DropdownMenuItem>
                        )}
                        {tunnel.can_share && (
                            <DropdownMenuItem onClick={() => onShare(tunnel.id)}>
                                <Share2 className="mr-2 h-4 w-4" /> {t("tunnelActions.shareTunnel")}
                            </DropdownMenuItem>
                        )}
                        {tunnel.can_delete && (
                            <>
                                {(tunnel.can_edit || tunnel.can_share) && <DropdownMenuSeparator />}
                                <DropdownMenuItem
                                    onClick={() => onDelete(tunnel.id, tunnel.host_friendly_name)}
                                    className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                                >
                                    <Trash2 className="mr-2 h-4 w-4" /> {t("common.delete")}
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
