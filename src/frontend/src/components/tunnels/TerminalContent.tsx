/**
 * 終端機頁主內容區：主視圖 tab（Terminal / Browser）+ 可選 File Manager 側欄 + 虛擬鍵盤 + Service Keys 彈窗。
 * Terminal page main content: main view tabs (Terminal / Browser) + optional File Manager side panel + virtual keyboard + service keys modal.
 */
import React, { RefObject, useEffect, useCallback, useRef } from "react";
import { usePanelRef, type GroupImperativeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { VirtualKeyboard } from "@/components/tunnels/VirtualKeyboard";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { RemoteBrowserPanel } from "@/components/tunnels/RemoteBrowserPanel";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Copy, Terminal as TerminalIcon, MonitorPlay, FolderSync, RefreshCw } from "lucide-react";

export interface TerminalContentProps {
    mainView: "terminal" | "browser" | "files";
    setMainView: (view: "terminal" | "browser" | "files") => void;
    connected: boolean;
    connecting: boolean;
    showFiles: boolean;
    setShowFiles: (show: boolean) => void;
    isBrowserActive: boolean;
    setIsBrowserActive: (isActive: boolean) => void;
    keyboardExpanded: boolean;
    setKeyboardExpanded: (v: boolean) => void;
    terminalRef: RefObject<HTMLDivElement | null>;
    xtermRef: RefObject<unknown>;
    wsRef: RefObject<WebSocket | null>;
    serverId: string;
    username: string | null;
    accessToken: string | null;
    syncedPath: string | undefined;
    serviceKeyModalOpen: boolean;
    setServiceKeyModalOpen: (v: boolean) => void;
    loadingServiceKeys: boolean;
    serviceKeys: unknown[];
    onReconnect?: () => void;
}

export function TerminalContent({
    mainView,
    setMainView,
    connected,
    connecting,
    showFiles,
    setShowFiles,
    isBrowserActive,
    setIsBrowserActive,
    keyboardExpanded,
    setKeyboardExpanded,
    terminalRef,
    xtermRef,
    wsRef,
    serverId,
    username,
    accessToken,
    syncedPath,
    serviceKeyModalOpen,
    setServiceKeyModalOpen,
    loadingServiceKeys,
    serviceKeys,
    onReconnect,
}: TerminalContentProps) {
    const groupRef = useRef<GroupImperativeHandle>(null);
    const filesPanelRef = usePanelRef();

    // Open/close Files panel via group-level setLayout for authoritative control
    useEffect(() => {
        if (groupRef.current) {
            if (showFiles) groupRef.current.setLayout({ main: 70, files: 30 });
            else groupRef.current.setLayout({ main: 100, files: 0 });
        }
    }, [showFiles]);

    // Sync showFiles when user finishes dragging (fires only after pointer release)
    const handleLayoutChanged = useCallback(() => {
        if (!filesPanelRef.current) return;
        const collapsed = filesPanelRef.current.isCollapsed();
        if (collapsed && showFiles) setShowFiles(false);
        else if (!collapsed && !showFiles) setShowFiles(true);
    }, [showFiles, setShowFiles]);

    const sendInput = (input: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ action: "pty_input", payload: { input } }));
        }
        if (input === "\r" || input === "\n") {
            setTimeout(() => {
                try {
                    (xtermRef.current as { scrollToBottom?: () => void })?.scrollToBottom?.();
                } catch { /* noop */ }
            }, 80);
        }
    };

    return (
        <>
            {/* Mobile Tab Bar — 3 tabs: Terminal / Files / Browser */}
            <div className="md:hidden flex p-1 bg-muted/50 rounded-lg mb-2 border border-border/40 w-full shrink-0 relative">
                <div
                    className="absolute inset-y-1 bg-background shadow rounded-md transition-all duration-300 ease-out"
                    style={{
                        width: "calc(33.33% - 4px)",
                        left: mainView === "terminal" ? "4px" : mainView === "files" ? "calc(33.33%)" : "calc(66.66% - 4px)"
                    }}
                />
                <button
                    type="button"
                    onClick={() => setMainView("terminal")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${mainView === "terminal" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    <TerminalIcon size={13} /> Terminal
                </button>
                <button
                    type="button"
                    onClick={() => setMainView("files")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${mainView === "files" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    <FolderSync size={13} /> Files
                </button>
                <button
                    type="button"
                    onClick={() => setMainView("browser")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${mainView === "browser" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    <MonitorPlay size={13} /> Browser
                    {isBrowserActive && mainView !== "browser" && (
                        <span className="flex h-2 w-2 ml-0.5">
                            <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-success opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                        </span>
                    )}
                </button>
            </div>

            {/* Main Layout: Main View + Optional Files Side Panel */}
            <div className={`flex-1 min-h-0 w-full relative overflow-hidden flex flex-col transition-all duration-300 md:mb-0 ${keyboardExpanded && mainView === "terminal" ? "mb-[320px]" : mainView === "terminal" ? "mb-[70px]" : "mb-0"}`}>
                <ResizablePanelGroup className="flex-1 min-h-0 w-full relative overflow-hidden" groupRef={groupRef} onLayoutChanged={handleLayoutChanged}>
                    {/* ═══ Main View Panel ═══ */}
                    <ResizablePanel
                        id="main"
                        defaultSize={100}
                        minSize={30}
                        className="min-h-0 flex flex-col relative"
                    >
                        {/* Terminal — always mounted */}
                        <div className={`absolute inset-0 flex flex-col bg-black rounded-lg shadow-inner border border-border transition-opacity duration-200 ${mainView === "terminal" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
                            <style dangerouslySetInnerHTML={{
                                __html: `
.terminal-container .xterm-viewport::-webkit-scrollbar { width: 14px; background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.2); border: 4px solid #000; border-radius: 8px; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.4); }
.terminal-container .xterm-viewport::-webkit-scrollbar-corner { background: transparent; }
` }} />
                            <div className="flex-1 relative min-h-0 bg-black terminal-container">
                                <div ref={terminalRef} className="absolute inset-x-0 inset-y-1 sm:inset-y-0 pl-1" />
                                {!connected && !connecting && (
                                    <div className="absolute inset-0 bg-black/70 z-20 flex items-center justify-center rounded-lg">
                                        <div className="text-center space-y-3">
                                            <div className="w-3 h-3 rounded-full bg-destructive mx-auto" />
                                            <p className="text-sm text-muted-foreground">Disconnected</p>
                                            {onReconnect && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={onReconnect}
                                                    className="gap-1.5 text-xs"
                                                >
                                                    <RefreshCw size={13} /> Reconnect
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Browser — always mounted, hidden when not active */}
                        <div className={`absolute inset-0 flex flex-col bg-card rounded-lg border border-border transition-opacity duration-200 ${mainView === "browser" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
                            {username && (
                                <RemoteBrowserPanel
                                    serverId={serverId}
                                    username={username}
                                    accessToken={accessToken}
                                    onActiveChange={setIsBrowserActive}
                                />
                            )}
                        </div>
                    </ResizablePanel>

                    {/* ═══ Files Side Panel (collapsible, desktop only) ═══ */}
                    <ResizableHandle className="hidden md:flex mx-1 bg-transparent" withHandle />
                    <ResizablePanel
                        id="files"
                        panelRef={filesPanelRef}
                        defaultSize={0}
                        minSize={20}
                        collapsible
                        collapsedSize={0}
                        className="hidden md:flex min-h-0 min-w-0 bg-card rounded-lg border border-border flex-col"
                    >
                        {username && accessToken && (
                            <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                        )}
                    </ResizablePanel>
                </ResizablePanelGroup>

                {/* Mobile-only full-screen Files view */}
                <div className={`md:hidden absolute inset-0 bg-card rounded-lg border border-border flex flex-col transition-opacity duration-200 ${mainView === "files" ? "opacity-100 z-30 pointer-events-auto" : "opacity-0 pointer-events-none z-0"}`}>
                    {username && accessToken && (
                        <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                    )}
                </div>
            </div>

            <VirtualKeyboard
                isVisible={mainView === "terminal"}
                isExpanded={keyboardExpanded}
                onToggle={() => setKeyboardExpanded(!keyboardExpanded)}
                onInput={sendInput}
            />

            <Modal isOpen={serviceKeyModalOpen} onClose={() => setServiceKeyModalOpen(false)} title="Service Keys" size="lg">
                {loadingServiceKeys ? (
                    <div className="flex justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                    </div>
                ) : (serviceKeys as { key?: string; public_key?: string; host_friendly_name?: string; name?: string }[]).length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No service keys found.</p>
                ) : (
                    <div className="space-y-4 max-h-96 overflow-y-auto">
                        {(serviceKeys as { key?: string; public_key?: string; host_friendly_name?: string; name?: string }[]).map((sk, idx) => (
                            <div key={idx} className="bg-muted/50 rounded-lg p-4 border border-border min-w-0 overflow-hidden">
                                <div className="flex items-center justify-between mb-2 gap-2">
                                    <h4 className="text-sm font-semibold text-foreground">{sk.host_friendly_name || sk.name || `Service Key ${idx + 1}`}</h4>
                                    <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(sk.key || sk.public_key || "")} className="h-7 px-2 text-xs">
                                        <Copy size={12} className="mr-1" /> Copy
                                    </Button>
                                </div>
                                <div className="bg-background rounded p-2 border border-border/50 max-h-32 overflow-y-auto">
                                    <code className="text-[10px] leading-tight text-muted-foreground break-all whitespace-pre-wrap font-mono block max-w-full">{sk.key || sk.public_key || "—"}</code>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Modal>
        </>
    );
}
