/**
 * BottomTabLayout: Terminal on top, tabbed panel (Files / Remote) on the bottom.
 * Uses vertical ResizablePanelGroup for top/bottom split.
 */
"use client";
import React, { useEffect, useCallback, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { RemoteBrowserPanel } from "@/components/tunnels/RemoteBrowserPanel";
import { FolderSync, MonitorPlay } from "lucide-react";
import { LayoutProps } from "./types";

export function BottomTabLayout({
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
    const bottomPanelRef = usePanelRef();
    const [bottomTab, setBottomTab] = useState<"files" | "remote">("files");

    const showBottomPanel = showFileManager || showRemoteBrowser;

    useEffect(() => {
        if (bottomPanelRef.current) {
            if (showBottomPanel) bottomPanelRef.current.expand();
            else bottomPanelRef.current.collapse();
        }
    }, [showBottomPanel]);

    useEffect(() => {
        if (showFileManager && !showRemoteBrowser) setBottomTab("files");
        else if (showRemoteBrowser && !showFileManager) setBottomTab("remote");
    }, [showFileManager, showRemoteBrowser]);

    const handleBottomResize = useCallback((panelSize: { asPercentage: number }) => {
        if (panelSize.asPercentage <= 3 && showBottomPanel) {
            setShowFileManager(false);
            setShowRemoteBrowser(false);
            if (activeTab !== "terminal") setActiveTab("terminal");
        }
    }, [showBottomPanel, setShowFileManager, setShowRemoteBrowser, activeTab, setActiveTab]);

    return (
        <ResizablePanelGroup orientation="vertical" className="flex-1 min-h-0 w-full relative overflow-hidden">
            {/* Terminal (top) */}
            <ResizablePanel
                defaultSize={60}
                minSize={15}
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

            {/* Bottom Panel with internal Tabs */}
            <ResizableHandle className="hidden md:flex my-1 bg-transparent" withHandle />
            <ResizablePanel
                panelRef={bottomPanelRef}
                defaultSize={0}
                minSize={15}
                collapsible
                collapsedSize={0}
                onResize={handleBottomResize}
                className={`min-h-0 min-w-0 bg-card rounded-lg border border-border flex flex-col md:relative absolute inset-0 md:inset-auto h-full transition-all duration-300 ease-in-out md:translate-x-0 md:opacity-100 md:pointer-events-auto ${activeTab !== "terminal" ? "translate-x-0 opacity-100 z-20 pointer-events-auto" : "translate-x-full opacity-0 pointer-events-none z-0"}`}
            >
                {/* Tab Header */}
                <div className="flex border-b border-border bg-muted/30 shrink-0">
                    <button
                        type="button"
                        onClick={() => {
                            setBottomTab("files");
                            setShowFileManager(true);
                            setActiveTab("files");
                        }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2 ${bottomTab === "files" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        <FolderSync size={13} /> Files
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setBottomTab("remote");
                            setShowRemoteBrowser(true);
                            setActiveTab("remote");
                        }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2 ${bottomTab === "remote" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        <MonitorPlay size={13} /> Browser
                    </button>
                </div>

                {/* Tab Content */}
                <div className="flex-1 min-h-0 relative overflow-hidden">
                    <div className={`absolute inset-0 flex flex-col transition-opacity duration-200 ${bottomTab === "files" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
                        {username && accessToken && (
                            <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                        )}
                    </div>
                    <div className={`absolute inset-0 flex flex-col transition-opacity duration-200 ${bottomTab === "remote" ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"}`}>
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
