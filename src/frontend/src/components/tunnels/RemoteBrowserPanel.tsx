import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { MonitorPlay, MonitorX, AlertCircle, Loader2 } from "lucide-react";

export interface RemoteBrowserPanelProps {
    serverId: string;
    username: string;
    accessToken: string | null;
    onActiveChange?: (isActive: boolean) => void;
}

export function RemoteBrowserPanel({
    serverId,
    username,
    accessToken,
    onActiveChange,
}: RemoteBrowserPanelProps) {
    const [isLoading, setIsLoading] = useState(false);
    const [vncUrl, setVncUrl] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const startSession = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            const response = await fetch(`${apiBase}/api/reverse/server/${serverId}/remote-browser/start`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                },
                body: JSON.stringify({ username })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || "Failed to start remote browser");
            }

            const data = await response.json();
            setSessionId(data.session_id);

            // In dev mode NextJS runs on 3000 but Traefik on 8787.
            // Absolute URL forces the iframe's WebSocket to hit Traefik directly.
            let vncAbsolute = data.vnc_url as string;
            if (apiBase && vncAbsolute.startsWith('/')) {
                vncAbsolute = `${apiBase}${vncAbsolute}`;
            }
            setVncUrl(vncAbsolute);
            onActiveChange?.(true);
        } catch (err: any) {
            setError(err.message || "An unknown error occurred");
        } finally {
            setIsLoading(false);
        }
    };

    const stopSession = async () => {
        if (!sessionId) return;
        setIsLoading(true);
        try {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            await fetch(`${apiBase}/api/reverse/server/remote-browser/${sessionId}/stop`, {
                method: "POST",
                headers: {
                    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                },
            });
        } catch (err) {
            console.error("Failed to stop session:", err);
        } finally {
            setSessionId(null);
            setVncUrl(null);
            setIsLoading(false);
            onActiveChange?.(false);
        }
    };

    // Track sessionId in a ref to avoid stale closures in cleanup
    const sessionIdRef = useRef(sessionId);
    useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

    // Cleanup session when window unloads or component unmounts (leaving Terminal)
    useEffect(() => {
        const stopBackendSession = () => {
            const currentSessionId = sessionIdRef.current;
            if (currentSessionId) {
                const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
                fetch(`${apiBase}/api/reverse/server/remote-browser/${currentSessionId}/stop`, {
                    method: "POST",
                    headers: {
                        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                    },
                    keepalive: true
                }).catch(() => { });
            }
        };

        window.addEventListener('beforeunload', stopBackendSession);
        return () => {
            window.removeEventListener('beforeunload', stopBackendSession);
            stopBackendSession();
        };
    }, [accessToken]); // Only depend on accessToken, sessionId is tracked via ref

    // Heartbeat ping so backend can GC disconnected sessions
    useEffect(() => {
        if (!sessionId) return;
        const interval = setInterval(() => {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            fetch(`${apiBase}/api/reverse/server/remote-browser/${sessionId}/ping`, {
                method: "POST",
                headers: {
                    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                },
            }).catch(() => { });
        }, 15000);
        return () => clearInterval(interval);
    }, [sessionId, accessToken]);

    return (
        <div className="flex flex-col h-full w-full bg-card overflow-hidden relative shadow-xl">
            {/* Header / Actions */}
            <div className="flex items-center gap-2 p-2 px-3 border-b border-border bg-muted/40">
                <MonitorPlay size={18} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm font-semibold tracking-tight text-foreground">Proxy Browser (noVNC)</span>

                {vncUrl ? (
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={stopSession}
                        disabled={isLoading}
                        className="h-8 gap-1"
                    >
                        {isLoading ? <Loader2 className="animate-spin" size={14} /> : <MonitorX size={14} />}
                        Stop Session
                    </Button>
                ) : (
                    <Button
                        variant="default"
                        size="sm"
                        onClick={startSession}
                        disabled={isLoading}
                        className="h-8 gap-1"
                    >
                        {isLoading ? <Loader2 className="animate-spin" size={14} /> : <MonitorPlay size={14} />}
                        Start Chrome
                    </Button>
                )}
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-3 m-3 bg-red-500/10 border border-red-500/20 text-red-500 text-sm rounded-md flex items-start gap-2">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {/* Info View when not started */}
            {!vncUrl && !isLoading && !error && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4 text-center">
                    <MonitorPlay size={48} className="mb-4 opacity-20" />
                    <h3 className="text-lg font-medium mb-2 text-foreground">Proxy Browser via SSH</h3>
                    <p className="text-sm max-w-sm mb-4">
                        Starts a dedicated Selenium Chrome container. The traffic will be tunneled heavily through the target server ({username}@reverse), completely masquerading external requests as the target machine.
                    </p>
                    <Button onClick={startSession}>Click to Initialize</Button>
                </div>
            )}

            {/* Loading View */}
            {isLoading && !vncUrl && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4 text-center">
                    <Loader2 size={48} className="mb-4 animate-spin text-primary" />
                    <p className="text-sm">Spinning up Selenium Session and binding SSH proxy...</p>
                </div>
            )}

            {/* Browser Iframe (noVNC) */}
            {vncUrl && (
                <div className="flex-1 min-h-0 bg-black relative">
                    <iframe
                        src={vncUrl}
                        className="w-full h-full border-0"
                        title="Proxy Browser noVNC"
                    />
                </div>
            )}
        </div>
    );
}
