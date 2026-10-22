/**
 * 隧道「更多」動作選單：卡片與表格共用同一份，依用途分組，每一項都有一行說明，看得出是在哪一端做什麼。
 * The tunnel "More" menu — one menu for both card and table, grouped by purpose, every item with a one-line hint
 * so it is obvious which side (your computer / the device) it acts on.
 */
import React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ArrowLeftRight,
    ChevronDown,
    FileCode2,
    Info,
    LogOut,
    Rocket,
    ScrollText,
    Share2,
    Trash2,
    Users,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";

interface TunnelActionsProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    className?: string;
}

function ActionItem({
    icon: Icon,
    label,
    hint,
    onSelect,
    destructive = false,
}: {
    icon: LucideIcon;
    label: string;
    hint?: string;
    onSelect: () => void;
    destructive?: boolean;
}) {
    return (
        <DropdownMenuItem
            onClick={onSelect}
            variant={destructive ? "destructive" : "default"}
            className="items-start gap-3 py-1.5 rounded-md"
        >
            <Icon className="mt-0.5" />
            <span className="flex flex-col min-w-0 gap-0.5">
                <span className="font-medium leading-tight">{label}</span>
                {hint && <span className="text-[11px] leading-snug text-muted-foreground whitespace-normal">{hint}</span>}
            </span>
        </DropdownMenuItem>
    );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
    return (
        <DropdownMenuLabel className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
            {children}
        </DropdownMenuLabel>
    );
}

export function TunnelActions({
    tunnel,
    className,
    onDetails,
    onConfig,
    onScript,
    onLogs,
    onCommands,
    onUsers,
    onShare,
    onLeave,
    onDelete,
}: TunnelActionsProps) {
    const { t } = useI18n();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className={cn("gap-1 data-[state=open]:bg-accent", className)}
                    aria-label={t("tunnelActions.aria")}
                >
                    {t("tunnelActions.more")}
                    <ChevronDown size={14} className="opacity-60" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={12} className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-1.5 rounded-xl">
                <GroupLabel>{t("tunnelActions.groupConnect")}</GroupLabel>
                <DropdownMenuGroup>
                    <ActionItem
                        icon={ArrowLeftRight}
                        label={t("tunnelActions.portForwarding")}
                        hint={t("tunnelActions.portForwardingHint")}
                        onSelect={() => onCommands(tunnel.id)}
                    />
                    <ActionItem
                        icon={FileCode2}
                        label={t("tunnelActions.sshConfig")}
                        hint={t("tunnelActions.sshConfigHint")}
                        onSelect={() => onConfig(tunnel.id)}
                    />
                </DropdownMenuGroup>

                {tunnel.is_owner && (
                    <>
                        <DropdownMenuSeparator />
                        <GroupLabel>{t("tunnelActions.groupDevice")}</GroupLabel>
                        <ActionItem
                            icon={Rocket}
                            label={t("tunnelActions.installScript")}
                            hint={t("tunnelActions.installScriptHint")}
                            onSelect={() => onScript(tunnel.id)}
                        />
                    </>
                )}

                <DropdownMenuSeparator />
                <GroupLabel>{t("tunnelActions.groupManage")}</GroupLabel>
                <DropdownMenuGroup>
                    <ActionItem
                        icon={Info}
                        label={t("tunnelActions.details")}
                        hint={t("tunnelActions.detailsHint")}
                        onSelect={() => onDetails(tunnel.id)}
                    />
                    <ActionItem
                        icon={Users}
                        label={tunnel.can_edit ? t("tunnelActions.targetServerUsers") : t("tunnelActions.viewTargetUsers")}
                        hint={t("tunnelActions.targetServerUsersHint")}
                        onSelect={() => onUsers(tunnel.id, !tunnel.can_edit)}
                    />
                    {tunnel.can_share && (
                        <ActionItem
                            icon={Share2}
                            label={tunnel.is_owner ? t("tunnelActions.shareTunnel") : t("tunnelActions.manageSharing")}
                            hint={t("tunnelActions.shareHint")}
                            onSelect={() => onShare(tunnel.id)}
                        />
                    )}
                    <ActionItem
                        icon={ScrollText}
                        label={t("tunnelActions.logs")}
                        hint={t("tunnelActions.logsHint")}
                        onSelect={() => onLogs(tunnel.id)}
                    />
                </DropdownMenuGroup>

                {(tunnel.can_delete || !tunnel.is_owner) && <DropdownMenuSeparator />}
                {!tunnel.is_owner && (
                    <ActionItem
                        icon={LogOut}
                        label={t("tunnelActions.leaveTunnel")}
                        hint={t("tunnelActions.leaveHint")}
                        onSelect={() => onLeave(tunnel.id, tunnel.host_friendly_name)}
                        destructive
                    />
                )}
                {tunnel.can_delete && (
                    <ActionItem
                        icon={Trash2}
                        label={t("tunnelActions.deleteTunnel")}
                        hint={t("tunnelActions.deleteHint")}
                        onSelect={() => onDelete(tunnel.id, tunnel.host_friendly_name)}
                        destructive
                    />
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
