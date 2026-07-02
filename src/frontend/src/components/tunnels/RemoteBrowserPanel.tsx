import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
    MonitorPlay, MonitorX, AlertCircle, Loader2,
    ArrowLeft, ArrowRight, RotateCw, Plus, X,
} from "lucide-react";
import { readJson, responseError } from "@/lib/api";
import {
    RemoteBrowserClient, TabInfo, keyEventToCdp, cdpModifiers,
} from "@/lib/remoteBrowser";

export interface RemoteBrowserPanelProps {
    serverId: string;
    username: string;
    accessToken: string | null;
    onActiveChange?: (isActive: boolean) => void;
}

const CDP_BUTTON: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

export function RemoteBrowserPanel({
    serverId,
    username,
    accessToken,
    onActiveChange,
}: RemoteBrowserPanelProps) {
    const [isLoading, setIsLoading] = useState(false);
    const [active, setActive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tabs, setTabs] = useState<TabInfo[]>([]);
    const [addressBar, setAddressBar] = useState("");

    const clientRef = useRef<RemoteBrowserClient | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const renderSize = useRef({ w: 1280, h: 720 });
    const composingRef = useRef(false);

    // 畫幀:重用一個 Image,onload 後 drawImage 到 canvas(避免每幀 new Image)。
    const drawFrame = useCallback((dataUrl: string) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let img = imgRef.current;
        if (!img) { img = new Image(); imgRef.current = img; }
        img.onload = () => {
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(img!, 0, 0, canvas.width, canvas.height);
        };
        img.src = dataUrl;
    }, []);

    const startSession = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            const response = await fetch(
                `${apiBase}/api/reverse/server/${serverId}/remote-browser/start`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                    },
                    body: JSON.stringify({ username }),
                },
            );
            if (!response.ok) {
                const data = await readJson(response);
                throw new Error(responseError(response, data, "Failed to start remote browser"));
            }
            const data = await response.json();
            sessionIdRef.current = data.session_id;

            const client = new RemoteBrowserClient({
                wsPath: data.ws_path,
                getToken: () =>
                    typeof window !== "undefined" ? localStorage.getItem("accessToken") : null,
                onFrame: drawFrame,
                onTabs: (t) => {
                    setTabs(t);
                    const act = t.find((x) => x.active);
                    if (act) setAddressBar(act.url === "about:blank" ? "" : act.url);
                },
                onOpen: () => {
                    setActive(true);
                    onActiveChange?.(true);
                    // 連上後照容器實際大小同步一次尺寸
                    requestAnimationFrame(syncSize);
                },
                onClose: () => {
                    setActive(false);
                    onActiveChange?.(false);
                },
                onError: () => setError("Connection error"),
            });
            clientRef.current = client;
            client.connect();
        } catch (err: any) {
            setError(err.message || "An unknown error occurred");
        } finally {
            setIsLoading(false);
        }
    };

    const stopSession = useCallback(async () => {
        const sid = sessionIdRef.current;
        clientRef.current?.close();
        clientRef.current = null;
        setActive(false);
        setTabs([]);
        onActiveChange?.(false);
        if (sid) {
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            try {
                await fetch(`${apiBase}/api/reverse/server/remote-browser/${sid}/stop`, {
                    method: "POST",
                    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
                    keepalive: true,
                });
            } catch { /* best effort */ }
        }
        sessionIdRef.current = null;
    }, [accessToken, onActiveChange]);

    // canvas 邏輯尺寸 = 容器顯示尺寸;同步後端 deviceMetrics 與 screencast 尺寸。
    const syncSize = useCallback(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        const client = clientRef.current;
        if (!canvas || !wrap || !client) return;
        const w = Math.max(200, Math.round(wrap.clientWidth));
        const h = Math.max(200, Math.round(wrap.clientHeight));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        renderSize.current = { w, h };
        client.resize(w, h);
    }, []);

    useEffect(() => {
        if (!active) return;
        const wrap = wrapRef.current;
        if (!wrap) return;
        let t: any;
        const ro = new ResizeObserver(() => {
            clearTimeout(t);
            t = setTimeout(syncSize, 150);   // debounce:拖動視窗時不狂送 resize
        });
        ro.observe(wrap);
        return () => { ro.disconnect(); clearTimeout(t); };
    }, [active, syncSize]);

    // 卸載 / 關閉分頁時收掉 session
    useEffect(() => {
        const onUnload = () => {
            const sid = sessionIdRef.current;
            if (!sid) return;
            const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";
            fetch(`${apiBase}/api/reverse/server/remote-browser/${sid}/stop`, {
                method: "POST",
                headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
                keepalive: true,
            }).catch(() => { });
        };
        window.addEventListener("beforeunload", onUnload);
        return () => {
            window.removeEventListener("beforeunload", onUnload);
            clientRef.current?.close();
            onUnload();
        };
    }, [accessToken]);

    // --- 座標換算:canvas 顯示座標 → 後端頁面像素 ---
    const toPageCoords = (e: React.MouseEvent) => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const sx = renderSize.current.w / rect.width;
        const sy = renderSize.current.h / rect.height;
        return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    };
    const mouseCommon = (e: React.MouseEvent) => ({
        ...toPageCoords(e),
        modifiers: cdpModifiers(e),
    });

    const onMouseDown = (e: React.MouseEvent) => {
        focusKeyboard();
        const c = mouseCommon(e);
        clientRef.current?.sendMouse("mousePressed", c.x, c.y, {
            button: CDP_BUTTON[e.button] ?? "left",
            clickCount: e.detail || 1,
            modifiers: c.modifiers,
        });
    };
    const onMouseUp = (e: React.MouseEvent) => {
        const c = mouseCommon(e);
        clientRef.current?.sendMouse("mouseReleased", c.x, c.y, {
            button: CDP_BUTTON[e.button] ?? "left",
            clickCount: e.detail || 1,
            modifiers: c.modifiers,
        });
    };
    const onMouseMove = (e: React.MouseEvent) => {
        const c = mouseCommon(e);
        clientRef.current?.sendMouse("mouseMoved", c.x, c.y, { modifiers: c.modifiers });
    };
    const onWheel = (e: React.WheelEvent) => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const sx = renderSize.current.w / rect.width;
        const sy = renderSize.current.h / rect.height;
        clientRef.current?.sendMouse("mouseWheel",
            (e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy,
            { deltaX: -e.deltaX, deltaY: -e.deltaY });
    };

    // --- 鍵盤 + IME:透明 textarea 收所有鍵盤/組字/貼上事件 ---
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const focusKeyboard = () => taRef.current?.focus();

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (composingRef.current) return;        // 組字中交給 IME,compositionend 再送最終字串
        // 讓瀏覽器層級快捷鍵(重整/開發者工具)不被吃掉;其餘一律攔截送進遠端。
        e.preventDefault();
        clientRef.current?.sendKey("keyDown", keyEventToCdp(e as any), cdpModifiers(e));
    };
    const onKeyUp = (e: React.KeyboardEvent) => {
        if (composingRef.current) return;
        e.preventDefault();
        clientRef.current?.sendKey("keyUp", keyEventToCdp(e as any), cdpModifiers(e));
    };
    const onCompositionStart = () => { composingRef.current = true; };
    const onCompositionEnd = (e: React.CompositionEvent) => {
        composingRef.current = false;
        if (e.data) clientRef.current?.sendText(e.data);   // 送出最終組字結果(中文等)
        if (taRef.current) taRef.current.value = "";
    };
    const onPaste = (e: React.ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text");
        if (text) clientRef.current?.sendText(text);
    };

    const submitAddress = (e: React.FormEvent) => {
        e.preventDefault();
        if (addressBar.trim()) clientRef.current?.navigate(addressBar.trim());
        focusKeyboard();
    };

    return (
        <div className="flex flex-col h-full w-full bg-card overflow-hidden relative shadow-xl">
            {/* Header */}
            <div className="flex items-center gap-2 p-2 px-3 border-b border-border bg-muted/40">
                <MonitorPlay size={18} className="text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm font-semibold tracking-tight text-foreground">
                    Proxy Browser
                </span>
                {active ? (
                    <Button variant="destructive" size="sm" onClick={stopSession}
                        disabled={isLoading} className="h-8 gap-1">
                        <MonitorX size={14} /> Stop Session
                    </Button>
                ) : (
                    <Button variant="default" size="sm" onClick={startSession}
                        disabled={isLoading} className="h-8 gap-1">
                        {isLoading ? <Loader2 className="animate-spin" size={14} />
                            : <MonitorPlay size={14} />}
                        Start Browser
                    </Button>
                )}
            </div>

            {error && (
                <div className="p-3 m-3 bg-red-500/10 border border-red-500/20 text-red-500 text-sm rounded-md flex items-start gap-2">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {active && (
                <>
                    {/* Toolbar */}
                    <div className="flex items-center gap-1 p-1.5 px-2 border-b border-border bg-muted/20">
                        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground"
                            title="Back" onClick={() => clientRef.current?.back()}
                            onMouseDown={(e) => e.preventDefault()}>
                            <ArrowLeft size={16} />
                        </button>
                        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground"
                            title="Forward" onClick={() => clientRef.current?.forward()}
                            onMouseDown={(e) => e.preventDefault()}>
                            <ArrowRight size={16} />
                        </button>
                        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground"
                            title="Reload" onClick={() => clientRef.current?.reload()}
                            onMouseDown={(e) => e.preventDefault()}>
                            <RotateCw size={15} />
                        </button>
                        <form onSubmit={submitAddress} className="flex-1">
                            <input
                                value={addressBar}
                                onChange={(e) => setAddressBar(e.target.value)}
                                placeholder="Enter URL and press Enter"
                                className="w-full h-7 px-2 text-sm rounded bg-background border border-border focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                        </form>
                    </div>

                    {/* Tab bar */}
                    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/10 overflow-x-auto">
                        {tabs.map((t) => (
                            <div key={t.target_id}
                                onClick={() => clientRef.current?.switchTab(t.target_id)}
                                className={`group flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer max-w-[180px] ${
                                    t.active ? "bg-background border border-border"
                                        : "hover:bg-muted text-muted-foreground"}`}>
                                <span className="truncate">{t.title || t.url || "New Tab"}</span>
                                <X size={12} className="opacity-0 group-hover:opacity-100 shrink-0"
                                    onClick={(e) => { e.stopPropagation(); clientRef.current?.closeTab(t.target_id); }} />
                            </div>
                        ))}
                        <button className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0"
                            title="New tab" onClick={() => clientRef.current?.newTab()}>
                            <Plus size={14} />
                        </button>
                    </div>
                </>
            )}

            {/* Not started */}
            {!active && !isLoading && !error && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4 text-center">
                    <MonitorPlay size={48} className="mb-4 opacity-20" />
                    <h3 className="text-lg font-medium mb-2 text-foreground">Proxy Browser via SSH</h3>
                    <p className="text-sm max-w-sm mb-4">
                        Starts a headless Chromium session streamed over WebSocket. Traffic is
                        tunneled through the target server ({username}@reverse), masquerading
                        external requests as the target machine.
                    </p>
                    <Button onClick={startSession}>Click to Initialize</Button>
                </div>
            )}

            {isLoading && !active && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4 text-center">
                    <Loader2 size={48} className="mb-4 animate-spin text-primary" />
                    <p className="text-sm">Spinning up browser and binding SSH proxy...</p>
                </div>
            )}

            {/* Canvas viewport */}
            {active && (
                <div ref={wrapRef} className="flex-1 min-h-0 bg-black relative overflow-hidden">
                    <canvas
                        ref={canvasRef}
                        className="w-full h-full block"
                        onMouseDown={onMouseDown}
                        onMouseUp={onMouseUp}
                        onMouseMove={onMouseMove}
                        onWheel={onWheel}
                        onContextMenu={(e) => e.preventDefault()}
                    />
                    {/* 透明 textarea:承接鍵盤與 IME 組字;pointer-events-none 讓滑鼠落到 canvas */}
                    <textarea
                        ref={taRef}
                        className="absolute inset-0 opacity-0 resize-none pointer-events-none"
                        autoCapitalize="off" autoCorrect="off" spellCheck={false}
                        onKeyDown={onKeyDown}
                        onKeyUp={onKeyUp}
                        onCompositionStart={onCompositionStart}
                        onCompositionEnd={onCompositionEnd}
                        onPaste={onPaste}
                    />
                </div>
            )}
        </div>
    );
}
