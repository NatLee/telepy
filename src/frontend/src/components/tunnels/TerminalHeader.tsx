/**
 * 終端機頁面標題列：連線狀態、使用者切換、路徑、Terminal/Browser tabs、Files toggle、外觀、Service Keys。
 * Terminal page header: connection status, username switcher, path, Terminal/Browser tabs, Files toggle, appearance, service keys.
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Terminal as TerminalIcon, X, Server, KeyRound, FolderOpen, FolderSync, ChevronDown, ChevronUp, User as UserIcon, MonitorPlay, Network, Palette, Info, Route, Wrench } from "lucide-react";
import Link from "next/link";
import { TerminalLanHost, TerminalUsername } from "@/hooks/useTerminalPage";
import { TerminalMainView } from "@/lib/tunnelUrls";
import { TerminalLatencyBadge } from "@/components/tunnels/TerminalLatencyBadge";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

interface TerminalHeaderProps {
    serverId: string;
    port: string | null;
    headerExpanded: boolean;
    setHeaderExpanded: (expanded: boolean) => void;
    connecting: boolean;
    connected: boolean;
    youToServerMs: number | null;
    serverToDeviceMs: number | null;
    availableUsernames: TerminalUsername[];
    username: string | null;
    setUsername: (username: string) => void;
    syncedPath: string | null;
    mainView: TerminalMainView;
    setMainView: (view: TerminalMainView) => void;
    showFiles: boolean;
    setShowFiles: (show: boolean) => void;
    isBrowserActive: boolean;
    onLoadServiceKeys: () => void | Promise<void>;
    /** 打開終端機外觀對話框;appearanceCustomized = 這台裝置有自己的外觀。/ Opens the appearance dialog; customized = this device has its own look. */
    onOpenAppearance: () => void;
    appearanceCustomized: boolean;
    /** 殼開在裝置區網裡的機器上（帳號選單是裝置那一跳）。/ Shell on a LAN host; the user picker is the device hop. */
    lan?: { host: TerminalLanHost | null; login: string | null } | null;
    /** 裝置名稱（載入前是 null）。/ The device's name (null until loaded). */
    tunnelName?: string | null;
    /** 打開「怎麼運作」的即時路徑圖。/ Opens the live path diagram. */
    onOpenInfo: () => void;
    /** 回到選擇器換一台裝置 / 主機。/ Back to the picker to choose another device or host. */
    switchHref: string;
    /** 側欄目前的分頁（檔案 / 工具箱）。/ The side panel's current tab. */
    sideTab?: "files" | "toolbox";
    onSideTab?: (tab: "files" | "toolbox") => void;
    /** 打開 / 收起工具箱（桌機側欄、手機底部面板）。/ Toggle the toolbox (desktop side panel, phone sheet). */
    onToolbox?: () => void;
    toolboxOpen?: boolean;
}

/** 區網主機徽章。/ LAN host badge. */
function LanBadge({ lan }: { lan: { host: TerminalLanHost | null; login: string | null } }) {
    const { t } = useI18n();
    const name = lan.host ? (lan.host.label || lan.host.address) : t("terminal.lanHostFallback");
    const where = lan.host ? `${lan.host.address}:${lan.host.ssh_port}` : "";
    return (
        <Badge variant="outline" className="gap-1 px-2 py-0.5 font-mono text-xs max-w-[220px]" title={t("terminal.lanTargetTitle", { host: where || name })}>
            <Network size={11} className="shrink-0" />
            <span className="truncate">{lan.login ? `${lan.login}@${name}` : name}</span>
        </Badge>
    );
}

export function TerminalHeader({
    serverId,
    port,
    headerExpanded,
    setHeaderExpanded,
    connecting,
    connected,
    youToServerMs,
    serverToDeviceMs,
    availableUsernames,
    username,
    setUsername,
    syncedPath,
    mainView,
    setMainView,
    showFiles,
    setShowFiles,
    isBrowserActive,
    onLoadServiceKeys,
    onOpenAppearance,
    appearanceCustomized,
    lan = null,
    tunnelName = null,
    onOpenInfo,
    switchHref,
    sideTab = "files",
    onSideTab,
    onToolbox,
    toolboxOpen = false,
}: TerminalHeaderProps) {
    const router = useRouter();
    const { t } = useI18n();
    const filesOn = showFiles && sideTab === "files";
    const toggleFiles = () => {
        if (filesOn) setShowFiles(false);
        else {
            onSideTab?.("files");
            setShowFiles(true);
        }
    };

    return (
        <Card className="shrink-0 mb-2 md:mb-4 rounded-lg overflow-hidden border-border/50">
            <div className={`transition-all ${headerExpanded ? 'p-3 md:p-4' : 'p-2 md:p-4'}`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center justify-between gap-3 w-full md:w-auto">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-primary/10 rounded-md">
                                <TerminalIcon className="text-primary" size={18} />
                            </div>
                            <h1 className="flex min-w-0 items-center text-sm text-foreground md:text-base">
                                <span className="shrink-0">{t("common.terminal")}</span>
                                <Badge variant="secondary" className="ml-2 max-w-[10rem] truncate font-mono text-[0.6875rem] md:max-w-[16rem] md:text-xs" title={tunnelName ?? undefined}>{tunnelName ?? (serverId || "").slice(0, 8)}</Badge>
                            </h1>

                            {/* Mobile: 精簡雙段延遲（總和 + 訊號格，明細走 tooltip），收合時也一直可見 */}
                            <div className="md:hidden">
                                <TerminalLatencyBadge
                                    youToServerMs={youToServerMs}
                                    serverToDeviceMs={serverToDeviceMs}
                                    connected={connected}
                                    connecting={connecting}
                                    compact
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-1 md:hidden">
                        {onToolbox && (
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onToolbox} title={t("toolbox.show")} aria-label={t("toolbox.show")}>
                                <Wrench size={16} />
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="sm"
                            className="md:hidden h-8 w-8 p-0"
                            onClick={() => setHeaderExpanded(!headerExpanded)}
                        >
                            {headerExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </Button>
                        </div>
                    </div>

                    {/* Desktop Actions */}
                    <div className="hidden md:flex items-center justify-end gap-3 flex-wrap">

                        {/* 雙段延遲：你→伺服器 / 伺服器→裝置 */}
                        <TerminalLatencyBadge
                            youToServerMs={youToServerMs}
                            serverToDeviceMs={serverToDeviceMs}
                            connected={connected}
                            connecting={connecting}
                        />

                        {lan && <LanBadge lan={lan} />}

                        {/* Username Switcher */}
                        {availableUsernames.length > 1 && (
                            <div className="flex items-center gap-1.5" title={lan ? t("terminal.lanDeviceUserTitle") : undefined}>
                                <UserIcon size={12} className="text-muted-foreground" />
                                <select
                                    value={username || ''}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="h-7 text-xs bg-muted/50 border border-border rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                                >
                                    {availableUsernames.map((u: TerminalUsername) => (
                                        <option key={u.id} value={u.username}>
                                            {u.username} {u.created_by ? t("common.byUserHashTag", { user: u.created_by, id: u.created_by_id ?? "" }) : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {availableUsernames.length === 1 && username && (
                            <Badge variant="secondary" className="gap-1 px-2 py-0.5 font-mono text-xs" title={lan ? t("terminal.lanDeviceUserTitle") : undefined}>
                                <UserIcon size={11} /> {username}
                            </Badge>
                        )}

                        {syncedPath && (
                            <button
                                onClick={() => navigator.clipboard.writeText(syncedPath)}
                                title={t("terminal.pathTitle", { path: syncedPath })}
                                className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 border border-border rounded px-2 py-1 max-w-[200px] cursor-pointer hover:bg-muted transition-colors"
                            >
                                <FolderOpen size={12} className="shrink-0" />
                                <span className="truncate font-mono">{syncedPath}</span>
                            </button>
                        )}

                        <div className="h-6 w-px bg-border mx-1"></div>

                        {/* ═══ Terminal / Browser Tabs ═══ */}
                        <div className="flex items-center bg-muted/50 border border-border rounded-lg p-0.5 gap-0.5">
                            <button
                                type="button"
                                onClick={() => setMainView("terminal")}
                                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all ${mainView === "terminal" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                                title={connecting ? t("common.connecting") : connected ? t("common.connected") : t("common.disconnected")}
                            >
                                <TerminalIcon size={13} /> {t("common.terminal")}
                                <span className="flex h-2 w-2 ml-0.5">
                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${connecting ? 'bg-warning animate-pulse' : connected ? 'bg-success' : 'bg-destructive'}`}></span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setMainView("browser")}
                                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all relative ${mainView === "browser" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                                title={isBrowserActive ? t("terminal.sessionActive") : t("terminal.noSession")}
                            >
                                <MonitorPlay size={13} /> {t("common.browser")}
                                {isBrowserActive && mainView !== "browser" && (
                                    <span className="flex h-2 w-2 ml-0.5">
                                        <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-success opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                                    </span>
                                )}
                                {isBrowserActive && mainView === "browser" && (
                                    <span className="flex h-2 w-2 ml-0.5">
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                                    </span>
                                )}
                                {!isBrowserActive && (
                                    <span className="flex h-2 w-2 ml-0.5">
                                        <span className="relative inline-flex rounded-full h-2 w-2 border-2 border-muted-foreground/50"></span>
                                    </span>
                                )}
                            </button>
                        </div>

                        <Button
                            variant="outline"
                            size="sm"
                            onClick={toggleFiles}
                            title={filesOn ? t("terminal.hideFiles") : t("terminal.showFiles")}
                            className={`h-8 w-8 p-0 ${filesOn ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                        >
                            <FolderSync size={14} />
                        </Button>
                        {onToolbox && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onToolbox}
                                title={toolboxOpen ? t("toolbox.hide") : t("toolbox.show")}
                                aria-label={toolboxOpen ? t("toolbox.hide") : t("toolbox.show")}
                                aria-pressed={toolboxOpen}
                                className={`h-8 w-8 p-0 ${toolboxOpen ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                            >
                                <Wrench size={14} />
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onOpenInfo}
                            title={t("terminal.howItWorks")}
                            aria-label={t("terminal.howItWorks")}
                            className="h-8 w-8 p-0"
                        >
                            <Info size={14} />
                        </Button>
                        <Button variant="outline" size="sm" asChild className="h-8 text-xs gap-1.5" title={t("terminal.switchTargetHint")}>
                            <Link href={switchHref} prefetch={false}>
                                <Route size={14} /> {t("terminal.switchTarget")}
                            </Link>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onOpenAppearance}
                            title={appearanceCustomized ? t("terminal.appearanceCustomized") : t("terminal.appearance")}
                            aria-label={appearanceCustomized ? t("terminal.appearanceCustomized") : t("terminal.appearance")}
                            className="relative h-8 w-8 p-0"
                        >
                            <Palette size={14} />
                            {appearanceCustomized && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-card" aria-hidden />}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onLoadServiceKeys()}
                            className="h-8 text-xs gap-1.5"
                        >
                            <KeyRound size={14} /> {t("terminal.serviceKeys")}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => router.push("/tunnels")}
                            className="h-8 text-xs gap-1.5"
                        >
                            <X size={14} /> {t("common.close")}
                        </Button>
                    </div>
                </div>

                {/* Mobile Expanded Content */}
                <div className={`md:hidden grid transition-all duration-300 ease-in-out border-t ${headerExpanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-border' : 'grid-rows-[0fr] opacity-0 mt-0 pt-0 border-transparent pointer-events-none'}`}>
                    <div className="overflow-hidden flex flex-col gap-3">
                        <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5 bg-muted/50 p-1.5 rounded border border-border/50">
                                <Server size={12} className="shrink-0" />
                                <span className="truncate">{t("terminal.portLabel")} {port || t("common.notAvailable")}</span>
                            </div>
                            {lan && (
                                <div className="flex items-center justify-between gap-1.5 bg-muted/50 p-1.5 rounded border border-border/50">
                                    <span>{t("terminal.lanHostLabel")}</span>
                                    <LanBadge lan={lan} />
                                </div>
                            )}
                            {(connected || connecting) && (
                                <div className="flex items-center justify-between gap-1.5 bg-muted/50 p-1.5 rounded border border-border/50">
                                    <span>{t("terminal.latency")}</span>
                                    <TerminalLatencyBadge
                                        youToServerMs={youToServerMs}
                                        serverToDeviceMs={serverToDeviceMs}
                                        connected={connected}
                                        connecting={connecting}
                                    />
                                </div>
                            )}
                            {username && (
                                <div className="flex justify-between items-center bg-muted/50 p-1.5 rounded border border-border/50">
                                    <span>{t("common.user")}</span>
                                    {availableUsernames.length > 1 ? (
                                        <select
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            className="bg-background px-1.5 py-0.5 rounded border border-border/50 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                                        >
                                            {availableUsernames.map((u: TerminalUsername) => (
                                                <option key={u.id} value={u.username}>
                                                    {u.username} {u.created_by ? t("common.byUserHashTag", { user: u.created_by, id: u.created_by_id ?? "" }) : ''}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <code className="bg-background px-1.5 py-0.5 rounded border border-border/50">{username}</code>
                                    )}
                                </div>
                            )}
                        </div>

                        {syncedPath && (
                            <button
                                onClick={() => navigator.clipboard.writeText(syncedPath)}
                                className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 border border-border rounded px-2 py-1.5 w-full cursor-pointer hover:bg-muted transition-colors text-left"
                            >
                                <FolderOpen size={12} className="shrink-0" />
                                <span className="truncate font-mono">{syncedPath}</span>
                            </button>
                        )}

                        <div className="grid grid-cols-3 gap-2 mt-1">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onOpenAppearance}
                                title={appearanceCustomized ? t("terminal.appearanceCustomized") : t("terminal.appearance")}
                                className="relative h-10 text-xs gap-1.5"
                            >
                                <Palette size={14} /> {t("terminal.appearance")}
                                {appearanceCustomized && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" aria-hidden />}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => onLoadServiceKeys()}
                                className="h-10 text-xs gap-1.5"
                            >
                                <KeyRound size={14} /> {t("terminal.keysShort")}
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => router.push("/tunnels")}
                                className="h-10 text-xs gap-1.5"
                            >
                                <X size={14} /> {t("common.close")}
                            </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" size="sm" onClick={onOpenInfo} className="h-10 text-xs gap-1.5">
                                <Info size={14} /> {t("terminal.howItWorks")}
                            </Button>
                            <Button variant="outline" size="sm" asChild className="h-10 text-xs gap-1.5">
                                <Link href={switchHref} prefetch={false}>
                                    <Route size={14} /> {t("terminal.switchTarget")}
                                </Link>
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
}
