/**
 * RightTabLayout: Terminal left + tabbed side-panel right (Files / Remote tabs).
 * Only 2 resizable columns. The right panel uses internal tabs to switch content.
 */
"use client";
import React, { useEffect, useCallback, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { RemoteBrowserPanel } from "@/components/tunnels/RemoteBrowserPanel";
import { FolderSync, MonitorPlay } from "lucide-react";
import { LayoutProps } from "./types";

export function RightTabLayout({
    activeTab,
    setActiveTab,
    connected,
    connecting,
    showFileManager,
    setShowFileManager,
    showRemoteBrowser,
    setShowRemoteBrowser,
    setIsBrowserActive,
    terminalRef,
    serverId,
    username,
    accessToken,
    syncedPath,
}: LayoutProps) {
    const sidePanelRef = usePanelRef();
    const [sideTab, setSideTab] = useState<"files" | "remote">("files");

    // Determine if the side panel should be visible
    const showSidePanel = showFileManager || showRemoteBrowser;

    useEffect(() => {
        if (sidePanelRef.current) {
            if (showSidePanel) sidePanelRef.current.expand();
            else sidePanelRef.current.collapse();
        }
    }, [showSidePanel]);

    // Sync sideTab with which panel just got opened
    useEffect(() => {
        if (showFileManager && !showRemoteBrowser) setSideTab("files");
        else if (showRemoteBrowser && !showFileManager) setSideTab("remote");
    }, [showFileManager, showRemoteBrowser]);

    const handleSideResize = useCallback((panelSize: { asPercentage: number }) => {
        if (panelSize.asPercentage <= 3 && showSidePanel) {
            setShowFileManager(false);
            setShowRemoteBrowser(false);
            if (activeTab !== "terminal") setActiveTab("terminal");
        }
    }, [showSidePanel, setShowFileManager, setShowRemoteBrowser, activeTab, setActiveTab]);

    return (
        <ResizablePanelGroup className="flex-1 min-h-0 w-full relative overflow-hidden">
            {/* Terminal */}
            <ResizablePanel
                defaultSize={60}
                minSize={10}
                collapsible
                collapsedSize={0}
                className={`bg-black rounded-lg shadow-inner border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-all duration-300 ease-in-out md:translate-x-0 md:opacity-100 md:pointer-events-auto ${activeTab === "terminal" ? "translate-x-0 opacity-100 z-10" : "-translate-x-full opacity-0 pointer-events-none z-0"}`}
            >
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
                        <div className="absolute inset-0 bg-black/60 z-20 flex items-center justify-center rounded-lg">
                            <div className="text-center">
                                <div className="w-3 h-3 rounded-full bg-destructive mx-auto mb-2" />
                                <p className="text-sm text-muted-foreground">Disconnected</p>
                            </div>
                        </div>
                    )}
                </div>
            </ResizablePanel>

            {/* Side Panel with internal Tabs */}
            <ResizableHandle className="hidden md:flex mx-1 bg-transparent" withHandle />
            <ResizablePanel
                panelRef={sidePanelRef}
                defaultSize={0}
                minSize={15}
                collapsible
                collapsedSize={0}
                onResize={handleSideResize}
                className={`min-h-0 min-w-0 bg-card rounded-lg border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-all duration-300 ease-in-out md:translate-x-0 md:opacity-100 md:pointer-events-auto ${activeTab !== "terminal" ? "translate-x-0 opacity-100 z-20 pointer-events-auto" : "translate-x-full opacity-0 pointer-events-none z-0"}`}
            >
                {/* Tab Header */}
                <div className="flex border-b border-border bg-muted/30 shrink-0">
                    <button
                        type="button"
                        onClick={() => {
                            setSideTab("files");
                            setShowFileManager(true);
                            setActiveTab("files");
                        }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2 ${sideTab === "files" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        <FolderSync size={13} /> Files
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setSideTab("remote");
                            setShowRemoteBrowser(true);
                            setActiveTab("remote");
                        }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2 ${sideTab === "remote" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        <MonitorPlay size={13} /> Browser
                    </button>
                </div>

                {/* Tab Content */}
                <div className="flex-1 min-h-0 relative overflow-hidden">
                    <div className={`absolute inset-0 flex flex-col transition-opacity duration-200 ${sideTab === "files" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
                        {username && accessToken && (
                            <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                        )}
                    </div>
                    <div className={`absolute inset-0 flex flex-col transition-opacity duration-200 ${sideTab === "remote" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
                        {username && (
                            <RemoteBrowserPanel
                                serverId={serverId}
                                username={username}
                                accessToken={accessToken}
                                onActiveChange={setIsBrowserActive}
                                onClose={() => { setShowRemoteBrowser(false); setActiveTab("terminal"); }}
                            />
                        )}
                    </div>
                </div>
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
