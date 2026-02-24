/**
 * 終端機頁主內容區：行動版分頁、layout 模式切換、虛擬鍵盤、Service Keys 彈窗。
 * Terminal page main content: mobile tabs, layout mode dispatch, virtual keyboard, service keys modal.
 */
import React, { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { VirtualKeyboard } from "@/components/tunnels/VirtualKeyboard";
import { RightSplitLayout } from "@/components/tunnels/layouts/RightSplitLayout";
import { RightTabLayout } from "@/components/tunnels/layouts/RightTabLayout";
import { BottomTabLayout } from "@/components/tunnels/layouts/BottomTabLayout";
import { Copy } from "lucide-react";

export interface TerminalContentProps {
    activeTab: "terminal" | "files" | "remote";
    setActiveTab: (tab: "terminal" | "files" | "remote") => void;
    connected: boolean;
    connecting: boolean;
    showFileManager: boolean;
    setShowFileManager: (show: boolean) => void;
    showRemoteBrowser: boolean;
    setShowRemoteBrowser: (show: boolean) => void;
    setIsBrowserActive: (isActive: boolean) => void;
    keyboardExpanded: boolean;
    setKeyboardExpanded: (v: boolean) => void;
    layoutMode: "right_split" | "right_tab" | "bottom_tab";
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
}

export function TerminalContent({
    activeTab,
    setActiveTab,
    connected,
    connecting,
    showFileManager,
    setShowFileManager,
    showRemoteBrowser,
    setShowRemoteBrowser,
    setIsBrowserActive,
    keyboardExpanded,
    setKeyboardExpanded,
    layoutMode,
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
}: TerminalContentProps) {
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

    // Shared layout props for all layout components
    const layoutProps = {
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
    };

    return (
        <>
            {/* Mobile Tab Bar */}
            <div className="md:hidden flex p-1 bg-muted/50 rounded-lg mb-2 border border-border/40 w-full shrink-0 relative">
                <div
                    className="absolute inset-y-1 bg-background shadow rounded-md transition-all duration-300 ease-out"
                    style={{ width: "calc(33.33% - 4px)", left: activeTab === "terminal" ? "4px" : activeTab === "files" ? "calc(33.33%)" : "calc(66.66% - 4px)" }}
                />
                <button
                    type="button"
                    onClick={() => setActiveTab("terminal")}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${activeTab === "terminal" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    Terminal
                </button>
                <button
                    type="button"
                    onClick={() => {
                        if (!connected) return;
                        setShowFileManager(true);
                        setActiveTab("files");
                    }}
                    disabled={!connected}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${!connected ? "text-muted-foreground/40 cursor-not-allowed" : activeTab === "files" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    Files
                </button>
                <button
                    type="button"
                    onClick={() => {
                        if (!connected) return;
                        setShowRemoteBrowser(true);
                        setActiveTab("remote");
                    }}
                    disabled={!connected}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${!connected ? "text-muted-foreground/40 cursor-not-allowed" : activeTab === "remote" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                    Remote
                </button>
            </div>

            {/* Layout Mode Dispatch */}
            <div className={`flex-1 min-h-0 w-full relative overflow-hidden flex flex-col transition-all duration-300 md:mb-0 ${keyboardExpanded && activeTab === "terminal" ? "mb-[320px]" : activeTab === "terminal" ? "mb-[70px]" : "mb-0"}`}>
                {layoutMode === "right_split" && <RightSplitLayout {...layoutProps} />}
                {layoutMode === "right_tab" && <RightTabLayout {...layoutProps} />}
                {layoutMode === "bottom_tab" && <BottomTabLayout {...layoutProps} />}
            </div>

            <VirtualKeyboard
                isVisible={activeTab === "terminal"}
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
