/**
 * 終端機頁面標題列：連線狀態、使用者切換、路徑、Service Keys 與檔案管理按鈕。
 * Terminal page header: connection status, username switcher, path, service keys and file manager.
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Terminal as TerminalIcon, X, Server, KeyRound, FolderOpen, FolderSync, ChevronDown, ChevronUp, User as UserIcon, MonitorPlay } from "lucide-react";
import { TerminalUsername } from "@/hooks/useTerminalPage";
import { useRouter } from "next/navigation";

interface TerminalHeaderProps {
    serverId: string;
    port: string | null;
    headerExpanded: boolean;
    setHeaderExpanded: (expanded: boolean) => void;
    connecting: boolean;
    connected: boolean;
    availableUsernames: TerminalUsername[];
    username: string | null;
    setUsername: (username: string) => void;
    syncedPath: string | null;
    showFileManager: boolean;
    setShowFileManager: (show: boolean) => void;
    showRemoteBrowser: boolean;
    setShowRemoteBrowser: (show: boolean) => void;
    isBrowserActive: boolean;
    activeTab: "terminal" | "files" | "remote";
    setActiveTab: (tab: "terminal" | "files" | "remote") => void;
    /** 由 hook 提供，載入並顯示 Service Keys。 Provided by hook to load and show service keys. */
    onLoadServiceKeys: () => void | Promise<void>;
}

export function TerminalHeader({
    serverId,
    port,
    headerExpanded,
    setHeaderExpanded,
    connecting,
    connected,
    availableUsernames,
    username,
    setUsername,
    syncedPath,
    showFileManager,
    setShowFileManager,
    showRemoteBrowser,
    setShowRemoteBrowser,
    isBrowserActive,
    activeTab,
    setActiveTab,
    onLoadServiceKeys
}: TerminalHeaderProps) {
    const router = useRouter();

    return (
        <Card className="shrink-0 mb-2 md:mb-4 rounded-lg overflow-hidden border-border/50">
            <div className={`transition-all ${headerExpanded ? 'p-3 md:p-4' : 'p-2 md:p-4'}`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center justify-between gap-3 w-full md:w-auto">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-primary/10 rounded-md">
                                <TerminalIcon className="text-primary" size={18} />
                            </div>
                            <h1 className="text-sm md:text-base font-bold text-foreground flex items-center">
                                Terminal <Badge variant="secondary" className="ml-2 font-mono text-[10px] md:text-xs">{(serverId || "").slice(0, 8)}</Badge>
                            </h1>
                            <div className="md:hidden flex items-center gap-1 ml-1">
                                <div className={`w-2 h-2 rounded-full ${connecting ? 'bg-warning animate-pulse' : connected ? 'bg-success shadow-[0_0_4px_rgba(var(--color-success),0.6)]' : 'bg-destructive'}`}></div>
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="md:hidden h-8 w-8 p-0"
                            onClick={() => setHeaderExpanded(!headerExpanded)}
                        >
                            {headerExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </Button>
                    </div>

                    {/* Desktop Actions */}
                    <div className="hidden md:flex items-center justify-end gap-3 flex-wrap">
                        <Badge variant="outline" className="gap-1.5 px-2 py-0.5 pointer-events-none">
                            <div className={`w-2 h-2 rounded-full ${connecting ? 'bg-warning animate-pulse' : connected ? 'bg-success shadow-[0_0_4px_rgba(var(--color-success),0.6)]' : 'bg-destructive'}`}></div>
                            {connecting ? 'Connecting...' : connected ? 'Connected' : 'Disconnected'}
                        </Badge>

                        {/* Username Switcher */}
                        {availableUsernames.length > 1 && (
                            <div className="flex items-center gap-1.5">
                                <UserIcon size={12} className="text-muted-foreground" />
                                <select
                                    value={username || ''}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="h-7 text-xs bg-muted/50 border border-border rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                                >
                                    {availableUsernames.map((u: TerminalUsername) => (
                                        <option key={u.id} value={u.username}>
                                            {u.username} {u.created_by ? `(By: ${u.created_by} #${u.created_by_id})` : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {availableUsernames.length === 1 && username && (
                            <Badge variant="secondary" className="gap-1 px-2 py-0.5 font-mono text-xs">
                                <UserIcon size={11} /> {username}
                            </Badge>
                        )}

                        {syncedPath && (
                            <button
                                onClick={() => navigator.clipboard.writeText(syncedPath)}
                                title={`Current path: ${syncedPath} (click to copy)`}
                                className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 border border-border rounded px-2 py-1 max-w-[200px] cursor-pointer hover:bg-muted transition-colors"
                            >
                                <FolderOpen size={12} className="shrink-0" />
                                <span className="truncate font-mono">{syncedPath}</span>
                            </button>
                        )}

                        <div className="h-6 w-px bg-border mx-1"></div>

                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onLoadServiceKeys()}
                            className="h-8 text-xs gap-1.5"
                        >
                            <KeyRound size={14} /> Service Keys
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowFileManager(!showFileManager)}
                            disabled={!connected}
                            className={`h-8 text-xs gap-1.5 ${showFileManager ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                        >
                            <FolderSync size={14} /> {showFileManager ? "Hide Files" : "Files"}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                const nextState = !showRemoteBrowser;
                                setShowRemoteBrowser(nextState);
                                if (nextState) {
                                    setActiveTab("remote");
                                } else {
                                    setActiveTab("terminal");
                                }
                            }}
                            disabled={!connected}
                            className={`h-8 text-xs gap-1.5 relative ${showRemoteBrowser || activeTab === "remote" ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                        >
                            <MonitorPlay size={14} /> {showRemoteBrowser ? "Hide Browser" : "Proxy Browser"}
                            {isBrowserActive && !showRemoteBrowser && (
                                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success shadow-[0_0_4px_rgba(var(--color-success),0.6)]"></span>
                                </span>
                            )}
                            {isBrowserActive && showRemoteBrowser && (
                                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success shadow-[0_0_4px_rgba(var(--color-success),0.6)]"></span>
                                </span>
                            )}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => router.push("/tunnels")}
                            className="h-8 text-xs gap-1.5"
                        >
                            <X size={14} /> Close
                        </Button>
                    </div>
                </div>

                {/* Mobile Expanded Content */}
                <div className={`md:hidden grid transition-all duration-300 ease-in-out border-t ${headerExpanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-border' : 'grid-rows-[0fr] opacity-0 mt-0 pt-0 border-transparent pointer-events-none'}`}>
                    <div className="overflow-hidden flex flex-col gap-3">
                        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5 bg-muted/50 p-1.5 rounded border border-border/50">
                                <Server size={12} className="shrink-0" />
                                <span className="truncate">Port: {port || 'N/A'}</span>
                            </div>
                            <div className="flex items-center gap-1.5 bg-muted/50 p-1.5 rounded border border-border/50">
                                <div className={`w-2 h-2 shrink-0 rounded-full ${connecting ? 'bg-warning animate-pulse' : connected ? 'bg-success shadow-[0_0_4px_rgba(var(--color-success),0.6)]' : 'bg-destructive'}`}></div>
                                <span className="truncate">{connecting ? 'Connecting...' : connected ? 'Connected' : 'Disconnected'}</span>
                            </div>
                            {username && (
                                <div className="col-span-2 flex justify-between items-center bg-muted/50 p-1.5 rounded border border-border/50">
                                    <span>User</span>
                                    {availableUsernames.length > 1 ? (
                                        <select
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            className="bg-background px-1.5 py-0.5 rounded border border-border/50 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                                        >
                                            {availableUsernames.map((u: TerminalUsername) => (
                                                <option key={u.id} value={u.username}>
                                                    {u.username} {u.created_by ? `(By: ${u.created_by} #${u.created_by_id})` : ''}
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

                        <div className="grid grid-cols-2 gap-2 mt-1">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => onLoadServiceKeys()}
                                className="h-10 text-xs gap-1.5"
                            >
                                <KeyRound size={14} /> Keys
                            </Button>

                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => router.push("/tunnels")}
                                className="h-10 text-xs gap-1.5"
                            >
                                <X size={14} /> Close
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
}
