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
    Clapperboard,
    FileCode2,
    FolderInput,
    Info,
    KeyRound,
    LockKeyholeOpen,
    LogOut,
    Rocket,
    ScreenShare,
    ScrollText,
    Share2,
    ShieldCheck,
    Trash2,
    Users,
    Waypoints,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { useFeatures } from "@/hooks/useFeatures";

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
                {hint && <span className="text-[0.75rem] leading-snug text-muted-foreground whitespace-normal">{hint}</span>}
            </span>
        </DropdownMenuItem>
    );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
    return (
        <DropdownMenuLabel className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">
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
    onKeys,
    onNetwork,
    onDesktop,
    onUsers,
    onShare,
    onLeave,
    onDelete,
    onRequestAccess,
    onRecordings,
    onCommandRules,
    onToolbox,
    onMoveToGroup,
}: TunnelActionsProps) {
    const { t } = useI18n();
    // 管理員替這個人關掉的功能不放進選單（API 也會拒絕）。/ Features turned off for this person stay out of the menu.
    const { has } = useFeatures();

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
                    {onToolbox && has("toolbox") && has("terminal") && (
                        <ActionItem
                            icon={Wrench}
                            label={t("toolbox.menu")}
                            hint={t("toolbox.menuHint")}
                            onSelect={() => onToolbox(tunnel.id)}
                        />
                    )}
                    <ActionItem
                        icon={FileCode2}
                        label={t("tunnelActions.sshConfig")}
                        hint={t("tunnelActions.sshConfigHint")}
                        onSelect={() => onConfig(tunnel.id)}
                    />
                    <ActionItem
                        icon={KeyRound}
                        label={t("tunnelActions.deviceKeys")}
                        hint={t("tunnelActions.deviceKeysHint")}
                        onSelect={() => onKeys(tunnel.id)}
                    />
                    {has("network") && (
                        <ActionItem
                            icon={Waypoints}
                            label={t("tunnelActions.network")}
                            hint={t("tunnelActions.networkHint")}
                            onSelect={() => onNetwork(tunnel.id)}
                        />
                    )}
                    {has("remote_desktop") && (
                        <ActionItem
                            icon={ScreenShare}
                            label={t("tunnelActions.desktop")}
                            hint={t("tunnelActions.desktopHint")}
                            onSelect={() => onDesktop(tunnel.id)}
                        />
                    )}
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
                    {/* 我自己的分組（不影響別人）。/ My own grouping (affects nobody else). */}
                    {onMoveToGroup && (
                        <ActionItem
                            icon={FolderInput}
                            label={t("tunnelActions.moveToGroup")}
                            hint={t("tunnelActions.moveToGroupHint")}
                            onSelect={() => onMoveToGroup(tunnel.id)}
                        />
                    )}
                    {/* 只有擁有者 / ADMIN 能管理目標 OS 帳號（與分享同一級）；其他人只看得到自己被允許的 */}
                    <ActionItem
                        icon={Users}
                        label={tunnel.can_share ? t("tunnelActions.targetServerUsers") : t("tunnelActions.viewTargetUsers")}
                        hint={t("tunnelActions.targetServerUsersHint")}
                        onSelect={() => onUsers(tunnel.id, !tunnel.can_share)}
                    />
                    {/* 被分享的人（ADMIN 以下）：申請帳號 / 更高權限一段時間。/ Sharees below ADMIN: ask for more for a while. */}
                    {!tunnel.is_owner && !tunnel.can_share && onRequestAccess && (
                        <ActionItem
                            icon={LockKeyholeOpen}
                            label={t("share.request.menu")}
                            hint={t("share.request.menuHint")}
                            onSelect={() => onRequestAccess(tunnel.id)}
                        />
                    )}
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
                    {tunnel.record_sessions && has("recordings.manage") && (
                        <ActionItem
                            icon={Clapperboard}
                            label={t("recordings.menu")}
                            hint={t("recordings.menuHint")}
                            onSelect={() => onRecordings?.(tunnel.id)}
                        />
                    )}
                    {onCommandRules && has("command_rules.manage") && (
                        <ActionItem
                            icon={ShieldCheck}
                            label={t("commands.menu")}
                            hint={t("commands.menuHint")}
                            onSelect={() => onCommandRules(tunnel.id)}
                        />
                    )}
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
