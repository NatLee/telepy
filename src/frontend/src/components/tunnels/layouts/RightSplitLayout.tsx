/**
 * RightSplitLayout: Terminal + Files + Remote as 3-column resizable panels.
 * This is the "power user" layout that allows all panels side-by-side with drag handles.
 */
"use client";
import React, { useEffect, useCallback } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { RemoteBrowserPanel } from "@/components/tunnels/RemoteBrowserPanel";
import { LayoutProps } from "./types";

export function RightSplitLayout({
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
    const filesPanelRef = usePanelRef();
    const browserPanelRef = usePanelRef();

    useEffect(() => {
        if (filesPanelRef.current) {
            if (showFileManager) filesPanelRef.current.expand();
            else filesPanelRef.current.collapse();
        }
    }, [showFileManager]);

    useEffect(() => {
        if (browserPanelRef.current) {
            if (showRemoteBrowser) browserPanelRef.current.expand();
            else browserPanelRef.current.collapse();
        }
    }, [showRemoteBrowser]);

    const handleFilesResize = useCallback((panelSize: { asPercentage: number }) => {
        if (panelSize.asPercentage <= 3 && showFileManager) setShowFileManager(false);
        else if (panelSize.asPercentage > 3 && !showFileManager) setShowFileManager(true);
    }, [showFileManager, setShowFileManager]);

    const handleBrowserResize = useCallback((panelSize: { asPercentage: number }) => {
        if (panelSize.asPercentage <= 3 && showRemoteBrowser) {
            setShowRemoteBrowser(false);
            if (activeTab === "remote") setActiveTab("terminal");
        } else if (panelSize.asPercentage > 3 && !showRemoteBrowser) {
            setShowRemoteBrowser(true);
        }
    }, [showRemoteBrowser, setShowRemoteBrowser, activeTab, setActiveTab]);

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

            {/* Files */}
            <ResizableHandle className="hidden md:flex mx-1 bg-transparent" withHandle />
            <ResizablePanel
                panelRef={filesPanelRef}
                defaultSize={0}
                minSize={10}
                collapsible
                collapsedSize={0}
                onResize={handleFilesResize}
                className={`min-h-0 min-w-0 bg-card rounded-lg border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-transform duration-300 ease-in-out md:translate-x-0 md:opacity-100 md:pointer-events-auto ${activeTab === "files" ? "translate-x-0 opacity-100 z-20 pointer-events-auto" : "translate-x-full opacity-0 pointer-events-none z-0"}`}
            >
                {username && accessToken && (
                    <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                )}
            </ResizablePanel>

            {/* Remote Browser */}
            <ResizableHandle className="hidden md:flex mx-1 bg-transparent" withHandle />
            <ResizablePanel
                panelRef={browserPanelRef}
                defaultSize={0}
                minSize={15}
                collapsible
                collapsedSize={0}
                onResize={handleBrowserResize}
                className={`min-h-0 min-w-0 bg-card rounded-lg border border-border flex flex-col absolute inset-0 md:inset-auto h-full transition-all duration-300 ease-in-out z-20 md:relative md:translate-x-0 md:opacity-100 md:pointer-events-auto ${activeTab === "remote" ? "translate-x-0 opacity-100 pointer-events-auto z-30" : "translate-x-full opacity-0 pointer-events-none z-0"}`}
            >
                {username && (
                    <RemoteBrowserPanel
                        serverId={serverId}
                        username={username}
                        accessToken={accessToken}
                        onActiveChange={setIsBrowserActive}
                        onClose={() => { setShowRemoteBrowser(false); setActiveTab("terminal"); }}
                    />
                )}
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
