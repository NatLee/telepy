/**
 * 通道的「更多」選單 = 快速入口：常用功能一鍵直達（埠轉發、SSH 設定、工具箱、裝置金鑰、區網主機、分享），再來是通道頁面的
 * 幾個分頁（總覽、連線方式、存取、紀錄、設定），最後是離開 / 刪除。每項一行，說明放在滑鼠停留的提示裡——以前每項兩行、
 * 十七項，比筆電螢幕還高。完整的資訊與設定在通道頁面（`/tunnels/<id>`）。
 * The tunnel "More" menu is a quick-access menu: the frequent features one click away, then the tunnel page's main tabs,
 * then leave / delete. One line per item with the hint as a tooltip — it used to be seventeen two-line items, taller
 * than a laptop screen. Everything else lives on the tunnel's page (`/tunnels/<id>`).
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
    FolderInput,
    KeyRound,
    LayoutDashboard,
    LockKeyholeOpen,
    LogOut,
    MoreHorizontal,
    Route,
    ScrollText,
    Settings,
    Share2,
    Trash2,
    Users,
    Waypoints,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tunnel, TunnelActionHandlers, TunnelDetailsTab } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { useFeatures } from "@/hooks/useFeatures";

interface TunnelActionsProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    className?: string;
    /** `button` = 「更多 ▾」（卡片）；`icon` = 只有「…」（表格列，省寬度）。/ "More ▾" on cards; a bare "…" on table rows. */
    variant?: "button" | "icon";
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
    /** 滑鼠停留的提示。/ The hover hint. */
    hint?: string;
    onSelect: () => void;
    destructive?: boolean;
}) {
    return (
        <DropdownMenuItem onClick={onSelect} variant={destructive ? "destructive" : "default"} className="gap-3 rounded-md py-1.5" title={hint}>
            <Icon />
            <span className="min-w-0 truncate">{label}</span>
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

/** 選單裡通道頁面的那一排。/ The tunnel page row in the menu. */
const PAGE_TILES: { tab: TunnelDetailsTab; icon: LucideIcon }[] = [
    { tab: "overview", icon: LayoutDashboard },
    { tab: "connection", icon: Route },
    { tab: "access", icon: Users },
    { tab: "history", icon: ScrollText },
    { tab: "settings", icon: Settings },
];

export function TunnelActions({
    tunnel,
    className,
    onDetails,
    onConfig,
    onCommands,
    onKeys,
    onNetwork,
    onShare,
    onLeave,
    onDelete,
    onRequestAccess,
    onToolbox,
    onMoveToGroup,
    variant = "button",
}: TunnelActionsProps) {
    const { t } = useI18n();
    // 管理員替這個人關掉的功能不放進選單（API 也會拒絕）。/ Features turned off for this person stay out of the menu.
    const { has } = useFeatures();
    const page = (tab: TunnelDetailsTab) => () => onDetails(tunnel.id, tab);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {variant === "icon" ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className={cn("text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground", className)}
                        aria-label={t("tunnelActions.aria")}
                        title={t("tunnelActions.more")}
                    >
                        <MoreHorizontal />
                    </Button>
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        className={cn("gap-1 data-[state=open]:bg-accent", className)}
                        aria-label={t("tunnelActions.aria")}
                    >
                        {t("tunnelActions.more")}
                        <ChevronDown size={14} className="opacity-60" />
                    </Button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={12} className="w-[18rem] max-w-[calc(100vw-1.5rem)] rounded-xl p-1.5">
                {/* 快速前往：一鍵到功能。/ Quick access: straight into a feature. */}
                <GroupLabel>{t("tunnelActions.groupQuick")}</GroupLabel>
                <DropdownMenuGroup>
                    <ActionItem icon={ArrowLeftRight} label={t("tunnelActions.portForwarding")} hint={t("tunnelActions.portForwardingHint")} onSelect={() => onCommands(tunnel.id)} />
                    <ActionItem icon={FileCode2} label={t("tunnelActions.sshConfig")} hint={t("tunnelActions.sshConfigHint")} onSelect={() => onConfig(tunnel.id)} />
                    {onToolbox && has("toolbox") && has("terminal") && <ActionItem icon={Wrench} label={t("toolbox.menu")} hint={t("toolbox.menuHint")} onSelect={() => onToolbox(tunnel.id)} />}
                    <ActionItem icon={KeyRound} label={t("tunnelActions.deviceKeys")} hint={t("tunnelActions.deviceKeysHint")} onSelect={() => onKeys(tunnel.id)} />
                    {has("network") && <ActionItem icon={Waypoints} label={t("tunnelActions.network")} hint={t("tunnelActions.networkHint")} onSelect={() => onNetwork(tunnel.id)} />}
                    {tunnel.can_share && <ActionItem icon={Share2} label={tunnel.is_owner ? t("tunnelActions.shareTunnel") : t("tunnelActions.manageSharing")} hint={t("tunnelActions.shareHint")} onSelect={() => onShare(tunnel.id)} />}
                    {!tunnel.is_owner && !tunnel.can_share && onRequestAccess && <ActionItem icon={LockKeyholeOpen} label={t("share.request.menu")} hint={t("share.request.menuHint")} onSelect={() => onRequestAccess(tunnel.id)} />}
                </DropdownMenuGroup>

                {/* 通道頁面：一排小方塊，直接到那一頁（五行縮成一行，選單才放得進筆電螢幕）。
                    The tunnel page: one row of small tiles straight to a tab (five lines in one, so the menu fits a laptop screen). */}
                <DropdownMenuSeparator />
                <GroupLabel>{t("tunnelActions.groupPage")}</GroupLabel>
                <DropdownMenuGroup className="grid grid-cols-5 gap-0.5 pb-0.5">
                    {PAGE_TILES.map(({ tab, icon: Icon }) => (
                        <DropdownMenuItem
                            key={tab}
                            onClick={page(tab)}
                            title={`${t(`tunnelPage.tab.${tab}` as TranslationKey)} · ${t(`tunnelPage.tabHint.${tab}` as TranslationKey)}`}
                            aria-label={t(`tunnelPage.tab.${tab}` as TranslationKey)}
                            className="min-w-0 flex-col items-center gap-1 rounded-md px-0.5 py-2 text-center text-[0.7rem] leading-tight"
                        >
                            <Icon />
                            <span className="w-full truncate">{t(`tunnelPage.short.${tab}` as TranslationKey)}</span>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuGroup>

                {/* 我自己的整理（不影響別人）；這條的通知在通道頁面的「設定」。/ My own organising; this tunnel's notifications are in the page's Settings. */}
                {onMoveToGroup && (
                    <>
                        <DropdownMenuSeparator />
                        <ActionItem icon={FolderInput} label={t("tunnelActions.moveToGroup")} hint={t("tunnelActions.moveToGroupHint")} onSelect={() => onMoveToGroup(tunnel.id)} />
                    </>
                )}

                {(tunnel.can_delete || !tunnel.is_owner) && <DropdownMenuSeparator />}
                {!tunnel.is_owner && (
                    <ActionItem icon={LogOut} label={t("tunnelActions.leaveTunnel")} hint={t("tunnelActions.leaveHint")} onSelect={() => onLeave(tunnel.id, tunnel.host_friendly_name)} destructive />
                )}
                {tunnel.can_delete && (
                    <ActionItem icon={Trash2} label={t("tunnelActions.deleteTunnel")} hint={t("tunnelActions.deleteHint")} onSelect={() => onDelete(tunnel.id, tunnel.host_friendly_name)} destructive />
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
