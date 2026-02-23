/**
 * 終端機頁主內容區：行動版分頁、xterm 區、檔案管理、虛擬鍵盤、Service Keys 彈窗。
 * Terminal page main content: mobile tabs, xterm area, file manager, virtual keyboard, service keys modal.
 */
import React, { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { VirtualKeyboard } from "@/components/tunnels/VirtualKeyboard";
import { Copy } from "lucide-react";

export interface TerminalContentProps {
    activeTab: "terminal" | "files";
    setActiveTab: (tab: "terminal" | "files") => void;
    connected: boolean;
    connecting: boolean;
    showFileManager: boolean;
    setShowFileManager: (show: boolean) => void;
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
}

export function TerminalContent({
    activeTab,
    setActiveTab,
    connected,
    connecting,
    showFileManager,
    setShowFileManager,
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

    return (
        <>
            <div className="md:hidden flex p-1 bg-muted/50 rounded-lg mb-2 border border-border/40 w-full shrink-0 relative">
                <div
                    className="absolute inset-y-1 bg-background shadow rounded-md transition-all duration-300 ease-out"
                    style={{ width: "calc(50% - 4px)", left: activeTab === "terminal" ? "4px" : "calc(50%)" }}
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
            </div>

            <div className={`flex-1 min-h-0 w-full relative overflow-hidden flex flex-col md:flex-row gap-2 md:gap-4 transition-all duration-300 md:mb-0 ${keyboardExpanded && activeTab === "terminal" ? "mb-[320px]" : activeTab === "terminal" ? "mb-[70px]" : "mb-0"}`}>
                <div
                    className={`flex-[2] min-h-0 min-w-0 bg-black rounded-lg shadow-inner border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-transform duration-300 ease-in-out md:translate-x-0 ${activeTab === "terminal" ? "translate-x-0 z-10" : "-translate-x-full z-0"}`}
                >
                    <style
                        dangerouslySetInnerHTML={{
                            __html: `
.terminal-container .xterm-viewport::-webkit-scrollbar { width: 14px; background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.2); border: 4px solid #000; border-radius: 8px; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.4); }
.terminal-container .xterm-viewport::-webkit-scrollbar-corner { background: transparent; }
`,
                        }}
                    />
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
                </div>

                {showFileManager && username && accessToken && (
                    <div
                        className={`flex-1 min-h-0 min-w-0 md:max-w-md w-full bg-card rounded-lg border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-transform duration-300 ease-in-out md:translate-x-0 ${activeTab === "files" ? "translate-x-0 z-10" : "translate-x-full z-0"}`}
                    >
                        <FileManagerPanel key={username} serverId={serverId} username={username} accessToken={accessToken} initialPath={syncedPath} />
                    </div>
                )}
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
