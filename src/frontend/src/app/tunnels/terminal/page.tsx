"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { Terminal as TerminalIcon, X, Server, FolderSync, KeyRound, Copy, FolderOpen, ChevronDown, ChevronUp } from "lucide-react";
import { getWsOrigin } from "@/lib/websocket";
import { Button } from "@/components/ui/button";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { VirtualKeyboard } from "@/components/tunnels/VirtualKeyboard";
import { Modal } from "@/components/ui/Modal";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import "xterm/css/xterm.css";

export default function TerminalPage() {
    const searchParams = useSearchParams();
    const serverId = searchParams.get("serverId");
    const port = searchParams.get("port");
    const router = useRouter();
    const { accessToken } = useAuth();
    const { showError } = useToast();

    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<any>(null);
    const fitAddonRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(true);
    const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
    const [showFileManager, setShowFileManager] = useState(false);
    const [keyboardExpanded, setKeyboardExpanded] = useState(true);
    const [headerExpanded, setHeaderExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<"terminal" | "files">("terminal");
    const [syncedPath, setSyncedPath] = useState<string | undefined>();

    // Check Service Key state
    const [serviceKeyModalOpen, setServiceKeyModalOpen] = useState(false);
    const [serviceKeys, setServiceKeys] = useState<any[]>([]);
    const [loadingServiceKeys, setLoadingServiceKeys] = useState(false);

    // Fetch the username for this server (needed for SSH connection)
    const [username, setUsername] = useState<string | null>(null);

    useEffect(() => {
        if (!serverId || !accessToken) return;

        // Fetch available usernames for this server and pick the first one
        apiFetch(`/api/reverse/server/${serverId}/usernames`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const list = Array.isArray(data) ? data : (data?.results ?? []);
                if (list.length > 0) {
                    setUsername(list[0].username ?? list[0]);
                } else {
                    // Fallback: try using serverId as username
                    setUsername("root");
                }
            })
            .catch(() => setUsername("root"));
    }, [serverId, accessToken]);

    useEffect(() => {
        // Wait until we have everything we need
        if (!serverId || !accessToken || username === null) return;

        let cleanupFn: (() => void) | undefined;

        const initTerminal = async () => {
            const { Terminal } = await import("xterm");
            const { FitAddon } = await import("xterm-addon-fit");

            if (!terminalRef.current) return;

            const term = new Terminal({
                cursorBlink: true,
                theme: {
                    background: "#000000",
                    foreground: "#f0f0f0",
                    cursor: "#f0f0f0",
                    selectionBackground: "#3a3d41",
                    black: "#000000",
                    red: "#f44747",
                    green: "#608b4e",
                    yellow: "#d7ba7d",
                    blue: "#569cd6",
                    magenta: "#c586c0",
                    cyan: "#4dc9b0",
                    white: "#d4d4d4",
                    brightBlack: "#808080",
                    brightRed: "#f48771",
                    brightGreen: "#89d185",
                    brightYellow: "#d7ba7d",
                    brightBlue: "#9cdcfe",
                    brightMagenta: "#c586c0",
                    brightCyan: "#4ec9b0",
                    brightWhite: "#ffffff",
                },
                fontFamily: "'Fira Code', 'Courier New', monospace",
                fontSize: 14,
                lineHeight: 1.2,
            });

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(terminalRef.current);
            fitAddon.fit();

            // Enforce scroll to bottom on initial load for mobile
            setTimeout(() => {
                try {
                    term.scrollToBottom();
                } catch { }
            }, 300);

            // Handle OSC 7 (Directory sync)
            term.parser.registerOscHandler(7, (data) => {
                try {
                    const url = new URL(data);
                    if (url.protocol === 'file:') {
                        const newPath = decodeURIComponent(url.pathname);
                        setSyncedPath(newPath);
                        return true;
                    }
                } catch (e) {
                    // Ignore parse errors silently
                }
                return false;
            });

            xtermRef.current = term;
            fitAddonRef.current = fitAddon;

            const sendResize = (ws: WebSocket) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                fitAddon.fit();
                try {
                    term.scrollToBottom();
                } catch { }
                ws.send(JSON.stringify({
                    action: "pty_resize",
                    payload: {
                        size: {
                            rows: term.rows,
                            cols: term.cols,
                            height: term.rows * 20, // approximate pixel height
                            width: term.cols * 9,   // approximate pixel width
                        },
                    },
                }));
            };

            // Build WebSocket URL and subprotocols
            // Backend TerminalConsumer expects: token.<b64>, server.<id>, username.<name>, auth.<ticket>
            const base = getWsOrigin();
            const wsUrl = `${base}/ws/terminal/`;

            const encodedToken = btoa(accessToken);
            const jsSha256 = (await import("js-sha256")).sha256;
            const ticket = `auth.${jsSha256(`terminal_${serverId}.${Date.now()}`)}`;

            const protocols = [
                `token.${encodedToken}`,
                `server.${serverId}`,
                `username.${username}`,
                ticket,
            ];

            const ws = new WebSocket(wsUrl, protocols);
            wsRef.current = ws;

            const handleWindowResize = () => sendResize(ws);
            window.addEventListener("resize", handleWindowResize);

            let resizeObserver: ResizeObserver | null = null;
            if (terminalRef.current?.parentElement) {
                let resizeTimeout: ReturnType<typeof setTimeout>;
                resizeObserver = new ResizeObserver(() => {
                    try {
                        fitAddon.fit();
                        term.scrollToBottom();
                    } catch { }

                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            sendResize(ws);
                        }
                    }, 100);
                });
                resizeObserver.observe(terminalRef.current.parentElement);
            }

            ws.onopen = () => {
                setConnected(true);
                setConnecting(false);
                sendResize(ws);
            };

            ws.onmessage = (event) => {
                term.write(event.data);
            };

            ws.onerror = () => {
                setConnecting(false);
            };

            ws.onclose = (event) => {
                setConnected(false);
                setConnecting(false);
                const code = event.code;
                if (code === 4004) {
                    setPermissionDenied("You do not have permission to access this tunnel.");
                    term.write("\r\n\x1b[31m[Permission Denied] You do not have access to this tunnel.\x1b[0m\r\n");
                } else if (code === 4003) {
                    setPermissionDenied("The specified username is not authorized for this tunnel.");
                    term.write("\r\n\x1b[31m[Invalid Username] The username is not authorized for this tunnel.\x1b[0m\r\n");
                } else if (code === 4001) {
                    setPermissionDenied("Authentication failed. Please log in again.");
                    term.write("\r\n\x1b[31m[Auth Failed] Your session has expired. Please log in again.\x1b[0m\r\n");
                } else if (code === 4002) {
                    setPermissionDenied("Tunnel not found or server ID is invalid.");
                    term.write("\r\n\x1b[31m[Not Found] This tunnel does not exist.\x1b[0m\r\n");
                } else {
                    term.write("\r\n\x1b[31m[Disconnected from server]\x1b[0m\r\n");
                }
            };

            term.onData((data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    // Backend expects: { action: "pty_input", payload: { input: "..." } }
                    ws.send(JSON.stringify({ action: "pty_input", payload: { input: data } }));
                }
            });

            cleanupFn = () => {
                if (resizeObserver) resizeObserver.disconnect();
                window.removeEventListener("resize", handleWindowResize);
                ws.close();
                term.dispose();
            };
        };

        initTerminal();

        return () => {
            cleanupFn?.();
        };
    }, [serverId, accessToken, username, showError]);

    useEffect(() => {
        if (fitAddonRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            // Delay to allow flex layout transition to finish
            const timer = setTimeout(() => {
                try {
                    fitAddonRef.current.fit();
                    wsRef.current?.send(JSON.stringify({
                        action: "pty_resize",
                        payload: {
                            size: {
                                rows: xtermRef.current.rows,
                                cols: xtermRef.current.cols,
                                height: xtermRef.current.rows * 20,
                                width: xtermRef.current.cols * 9,
                            },
                        },
                    }));
                } catch (err) {
                    console.error("Resize error", err);
                }
            }, 200);
            return () => clearTimeout(timer);
        }
    }, [showFileManager]);

    // Manage Native Mobile Keyboard visibility based on Virtual Keyboard toggle
    useEffect(() => {
        const manageNativeKeyboard = () => {
            if (window.innerWidth < 768 && terminalRef.current) {
                const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
                if (textarea) {
                    if (keyboardExpanded) {
                        textarea.setAttribute('readonly', 'true');
                        textarea.blur();
                    } else {
                        textarea.removeAttribute('readonly');
                    }
                }
            }
        };

        // Needs a slight delay to ensure xterm DOM is fully mounted initial load
        setTimeout(manageNativeKeyboard, 100);

        // Also add focus listener for when the textarea gets focus
        const handleFocus = () => {
            if (window.innerWidth < 768 && keyboardExpanded && terminalRef.current) { // Renamed from showVirtualKeyboard
                const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
                if (textarea) {
                    textarea.blur();
                }
            }
        };

        const attachListener = () => {
            if (terminalRef.current) {
                const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
                if (textarea) {
                    textarea.removeEventListener('focus', handleFocus);
                    textarea.addEventListener('focus', handleFocus);
                }
            }
        };
        setTimeout(attachListener, 100);

        return () => {
            if (terminalRef.current) {
                const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
                if (textarea) {
                    textarea.removeEventListener('focus', handleFocus);
                }
            }
        };
        // Re-run this effect when keyboardExpanded or connected changes
    }, [keyboardExpanded, connected]);

    // Handle scrolling when keyboard expands
    useEffect(() => {
        if (keyboardExpanded && xtermRef.current) {
            // Scroll to bottom when keyboard opens to ensure prompt is visible
            setTimeout(() => {
                try {
                    xtermRef.current.scrollToBottom();
                } catch { }
            }, 150); // wait for flex transition
        }
    }, [keyboardExpanded]);

    if (!serverId || !accessToken) {
        return (
            <div className="flex items-center justify-center h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] p-4 bg-background w-full">
                <Card className="max-w-md w-full border-border/50 shadow-sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-foreground">
                            <TerminalIcon className="text-muted-foreground" size={20} />
                            No Connection Selected
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <p className="text-sm text-muted-foreground">
                            Please select a server from the tunnels list to open the terminal.
                        </p>
                        <Button onClick={() => router.push("/tunnels")} className="w-full">
                            Return to Tunnels List
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }
    if (permissionDenied) {
        return (
            <div className="flex items-center justify-center h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] p-4 bg-background w-full">
                <Card className="max-w-md w-full border-destructive/30 shadow-sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-destructive">
                            <X size={20} />
                            Access Denied
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <p className="text-sm text-muted-foreground">
                            {permissionDenied}
                        </p>
                        <Button onClick={() => router.push("/tunnels")} className="w-full">
                            Return to Tunnels List
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] w-full overflow-hidden bg-background relative">
            <div className="flex flex-col flex-1 min-h-0 p-1 sm:p-2 md:p-4">
                {/* Header: Use shadcn Card */}
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
                                    onClick={async () => {
                                        setServiceKeyModalOpen(true);
                                        setLoadingServiceKeys(true);
                                        try {
                                            const res = await apiFetch("/api/reverse/service/keys");
                                            if (res.ok) {
                                                const data = await res.json();
                                                setServiceKeys(Array.isArray(data) ? data : []);
                                            } else {
                                                setServiceKeys([]);
                                            }
                                        } catch {
                                            setServiceKeys([]);
                                        } finally {
                                            setLoadingServiceKeys(false);
                                        }
                                    }}
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
                                            <code className="bg-background px-1.5 py-0.5 rounded border border-border/50">{username}</code>
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
                                        onClick={async () => {
                                            setServiceKeyModalOpen(true);
                                            setLoadingServiceKeys(true);
                                            try {
                                                const res = await apiFetch("/api/reverse/service/keys");
                                                if (res.ok) {
                                                    const data = await res.json();
                                                    setServiceKeys(Array.isArray(data) ? data : []);
                                                } else {
                                                    setServiceKeys([]);
                                                }
                                            } catch {
                                                setServiceKeys([]);
                                            } finally {
                                                setLoadingServiceKeys(false);
                                            }
                                        }}
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

                {/* Mobile Tabs */}
                <div className="md:hidden flex p-1 bg-muted/50 rounded-lg mb-2 border border-border/40 w-full shrink-0 relative">
                    {/* Sliding Indicator */}
                    <div
                        className="absolute inset-y-1 bg-background shadow rounded-md transition-all duration-300 ease-out"
                        style={{
                            width: 'calc(50% - 4px)',
                            left: activeTab === 'terminal' ? '4px' : 'calc(50%)'
                        }}
                    />
                    <button
                        onClick={() => setActiveTab("terminal")}
                        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${activeTab === 'terminal' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                        Terminal
                    </button>
                    <button
                        onClick={() => {
                            if (!connected) return;
                            setShowFileManager(true);
                            setActiveTab("files");
                        }}
                        disabled={!connected}
                        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors relative z-10 ${!connected ? 'text-muted-foreground/40 cursor-not-allowed' : activeTab === 'files' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                        Files
                    </button>
                </div>

                {/* Main Content Area */}
                <div className={`flex-1 min-h-0 w-full relative overflow-hidden flex flex-col md:flex-row gap-2 md:gap-4 transition-all duration-300 md:mb-0 ${keyboardExpanded && activeTab === 'terminal' ? 'mb-[340px]' : (activeTab === 'terminal' ? 'mb-[70px]' : 'mb-0')}`}>

                    {/* Terminal View */}
                    <div
                        className={`flex-[2] min-h-0 min-w-0 bg-black rounded-lg shadow-inner border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-transform duration-300 ease-in-out md:translate-x-0 ${activeTab === 'terminal' ? 'translate-x-0 z-10' : '-translate-x-full z-0'}`}
                    >
                        {/* Native xterm scrollbar styling */}
                        <style dangerouslySetInnerHTML={{
                            __html: `
                        .terminal-container .xterm-viewport::-webkit-scrollbar {
                            width: 14px;
                            background: transparent;
                        }
                        .terminal-container .xterm-viewport::-webkit-scrollbar-track {
                            background: transparent;
                        }
                        .terminal-container .xterm-viewport::-webkit-scrollbar-thumb {
                            background-color: rgba(255, 255, 255, 0.2);
                            border: 4px solid #000;
                            border-radius: 8px;
                        }
                        .terminal-container .xterm-viewport::-webkit-scrollbar-thumb:hover {
                            background-color: rgba(255, 255, 255, 0.4);
                        }
                        .terminal-container .xterm-viewport::-webkit-scrollbar-corner {
                            background: transparent;
                        }
                    `}} />
                        <div className="flex-1 relative min-h-0 bg-black terminal-container">
                            <div ref={terminalRef} className="absolute inset-x-0 inset-y-1 sm:inset-y-0 pl-1" />
                            {/* Disconnect overlay */}
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

                    {/* File Manager View */}
                    {showFileManager && username && accessToken && (
                        <div
                            className={`flex-1 min-h-0 min-w-0 md:max-w-md w-full bg-card rounded-lg border border-border flex flex-col md:relative absolute inset-0 md:inset-auto md:w-auto h-full transition-transform duration-300 ease-in-out md:translate-x-0 ${activeTab === 'files' ? 'translate-x-0 z-10' : 'translate-x-full z-0'}`}
                        >
                            <FileManagerPanel serverId={serverId!} username={username} accessToken={accessToken} initialPath={syncedPath} />
                        </div>
                    )}
                </div>
            </div>

            {/* Full Virtual Mobile Keyboard - Absolute to Screen Bottom */}
            <VirtualKeyboard
                isVisible={activeTab === 'terminal'}
                isExpanded={keyboardExpanded}
                onToggle={() => setKeyboardExpanded(!keyboardExpanded)}
                onInput={(input) => {
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ action: "pty_input", payload: { input } }));
                    }
                }}
            />

            {/* Service Key Modal */}
            <Modal isOpen={serviceKeyModalOpen} onClose={() => setServiceKeyModalOpen(false)} title="Service Keys" size="lg">
                {loadingServiceKeys ? (
                    <div className="flex justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                ) : serviceKeys.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No service keys found.</p>
                ) : (
                    <div className="space-y-4 max-h-96 overflow-y-auto">
                        {serviceKeys.map((sk, idx) => (
                            <div key={idx} className="bg-muted/50 rounded-lg p-4 border border-border min-w-0 overflow-hidden">
                                <div className="flex items-center justify-between mb-2 gap-2">
                                    <h4 className="text-sm font-semibold text-foreground">{sk.host_friendly_name || sk.name || `Service Key ${idx + 1}`}</h4>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => navigator.clipboard.writeText(sk.key || sk.public_key || '')}
                                        className="h-7 px-2 text-xs"
                                    >
                                        <Copy size={12} className="mr-1" /> Copy
                                    </Button>
                                </div>
                                <div className="bg-background rounded p-2 border border-border/50 max-h-32 overflow-y-auto">
                                    <code className="text-[10px] leading-tight text-muted-foreground break-all whitespace-pre-wrap font-mono block max-w-full">
                                        {sk.key || sk.public_key || '—'}
                                    </code>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Modal>
        </div>
    );
}
