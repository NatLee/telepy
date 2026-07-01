/**
 * 終端機頁邏輯：使用者列表、xterm 初始化、WebSocket PTY、Service Keys 載入。
 * Terminal page logic: usernames list, xterm init, WebSocket PTY, service keys loading.
 * - xterm 初始化：動態 import xterm + FitAddon，註冊 OSC 7 同步當前路徑。
 *   xterm init: dynamic import, register OSC 7 for path sync.
 * - WebSocket 與 PTY：連線建立後送 pty_resize；onmessage 寫入 term；onData 送 pty_input。
 *   WebSocket & PTY: send pty_resize on open; onmessage writes to term; onData sends pty_input.
 * - Service Keys：fetchServiceKeys 呼叫 /api/reverse/service/keys，供標題列與彈窗使用。
 *   Service keys: fetchServiceKeys calls /api/reverse/service/keys for header and modal.
 */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getWsOrigin } from "@/lib/websocket";
import { fetchWsTicket } from "@/lib/reconnectingSocket";
import { TerminalMainView } from "@/lib/tunnelUrls";
import type { KeyboardMode } from "@/hooks/useKeyboardController";

const KEYBOARD_MODE_KEY = "telepy.keyboardMode";

export interface TerminalUsername {
    id: number;
    username: string;
    created_by?: string;
    created_by_id?: number;
}

export function useTerminalPage(serverId: string | null, accessToken: string | null) {
    const terminalRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xtermRef = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fitAddonRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(true);
    // 「你↔伺服器」的 WebSocket RTT（毫秒）：由終端機 socket 自帶的 ping/pong 量測（見下）。
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
    const [noUsers, setNoUsers] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [keyboardExpanded, setKeyboardExpanded] = useState(true);
    const [keyboardMode, setKeyboardModeState] = useState<KeyboardMode>("accessory");
    const [headerExpanded, setHeaderExpanded] = useState(false);

    // 讀取上次選擇的鍵盤模式（SSR 安全：在 effect 內存取 localStorage）。
    useEffect(() => {
        try {
            const saved = localStorage.getItem(KEYBOARD_MODE_KEY);
            if (saved === "accessory" || saved === "full" || saved === "hidden") {
                setKeyboardModeState(saved);
            }
        } catch { /* localStorage 不可用時忽略 */ }
    }, []);

    const setKeyboardMode = (m: KeyboardMode) => {
        setKeyboardModeState(m);
        try { localStorage.setItem(KEYBOARD_MODE_KEY, m); } catch { /* 忽略 */ }
    };
    const [mainView, setMainView] = useState<TerminalMainView>("terminal");
    const [syncedPath, setSyncedPath] = useState<string | undefined>();
    const [reconnectTrigger, setReconnectTrigger] = useState(0);

    const [serviceKeyModalOpen, setServiceKeyModalOpen] = useState(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [serviceKeys, setServiceKeys] = useState<any[]>([]);
    const [loadingServiceKeys, setLoadingServiceKeys] = useState(false);

    const [username, setUsername] = useState<string | null>(null);
    const [availableUsernames, setAvailableUsernames] = useState<TerminalUsername[]>([]);

    useEffect(() => {
        if (!serverId || !accessToken) return;

        apiFetch(`/api/reverse/server/${serverId}/usernames`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const list = data?.usernames ?? (Array.isArray(data) ? data : []);
                const defaultId = data?.default_username_id;
                setAvailableUsernames(list);
                if (list.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const defaultItem = defaultId ? list.find((u: any) => u.id === defaultId) : null;
                    setUsername(defaultItem ? defaultItem.username : (list[0].username ?? list[0]));
                    setNoUsers(false);
                } else {
                    setNoUsers(true);
                    setConnecting(false);
                }
            })
            .catch(() => {
                setNoUsers(true);
                setConnecting(false);
            });
    }, [serverId, accessToken]);

    // xterm 初始化與 WebSocket PTY 連線；依 serverId / accessToken / username 觸發。
    // xterm init and WebSocket PTY connection; triggered by serverId, accessToken, username.
    useEffect(() => {
        if (!serverId || !accessToken || username === null) return;

        let cleanupFn: (() => void) | undefined;

        const initTerminal = async () => {
            // 連線關鍵路徑的兩個優化（原本是序列：import → 等所有字體 → 抓 ticket → 才連線）：
            // 1) 立刻開抓一次性 ticket，讓它的 HTTP round-trip 與 xterm 動態載入、字體載入「並行」。
            // 2) 只等終端要用的「等寬字體」，而非 document.fonts.ready —— 後者會連大型 CJK 字體
            //    一起等，慢網路/首次載入時可能拖慢連線好幾秒；等寬字沒載到也用 1.5s 逾時保底。
            // Two fixes on the connect critical path (was serial: import → wait ALL fonts → fetch
            // ticket → connect): (1) start the ticket fetch now so its round-trip overlaps the xterm
            // import + font load; (2) wait only for the terminal's monospace font instead of
            // document.fonts.ready (which also blocks on the large CJK font), with a 1.5s timeout guard.
            const ticketPromise = fetchWsTicket();

            // CSS 變數同步可得，不必等 fonts.ready。/ The CSS var is available synchronously.
            const computedMono = getComputedStyle(document.body)
                .getPropertyValue('--font-0xproto').trim();
            const termFontFamily = computedMono
                ? `${computedMono}, 'Courier New', monospace`
                : "'Menlo', 'Consolas', 'Courier New', monospace";

            const monoFontReady = (async () => {
                if (!computedMono) return;
                try {
                    // Promise.race：字體載入 vs 1.5s 逾時。document.fonts.load 遇到無法解析的字體字串
                    // 會「同步」丟 SyntaxError，故整段以 try 包住，任何失敗都直接繼續初始化。
                    await Promise.race([
                        document.fonts.load(`14px ${computedMono}`),
                        new Promise((resolve) => setTimeout(resolve, 1500)),
                    ]);
                } catch { /* 字體字串無法解析或載入失敗 → 照常初始化 */ }
            })();

            const [{ Terminal }, { FitAddon }] = await Promise.all([
                import("xterm"),
                import("xterm-addon-fit"),
                monoFontReady,
            ]);

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
                fontFamily: termFontFamily,
                fontSize: 14,
                lineHeight: 1.2,
            });

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(terminalRef.current);
            fitAddon.fit();

            setTimeout(() => {
                try {
                    term.scrollToBottom();
                } catch { } // empty catch
            }, 300);

            term.parser.registerOscHandler(7, (data) => {
                try {
                    const url = new URL(data);
                    if (url.protocol === 'file:') {
                        const newPath = decodeURIComponent(url.pathname);
                        setSyncedPath(newPath);
                        return true;
                    }
                } catch { } // empty catch
                return false;
            });

            xtermRef.current = term;
            fitAddonRef.current = fitAddon;

            const sendResize = (ws: WebSocket) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                fitAddon.fit();
                try {
                    term.scrollToBottom();
                } catch { } // empty catch
                ws.send(JSON.stringify({
                    action: "pty_resize",
                    payload: {
                        size: {
                            rows: term.rows,
                            cols: term.cols,
                            height: term.rows * 20,
                            width: term.cols * 9,
                        },
                    },
                }));
            };

            const base = getWsOrigin();
            const wsUrl = `${base}/ws/terminal/`;

            // 一次性 ticket：已於函式開頭並行開抓，這裡多半即刻取得（JWT 只走 Authorization header）。
            // The one-time ticket was started at the top of this function in parallel, so it's usually ready.
            let ticket: string;
            try {
                ticket = await ticketPromise;
            } catch (e) {
                console.error("Terminal ws-ticket error", e);
                setConnecting(false);
                return;
            }

            const protocols = [
                `ticket.${ticket}`,
                `server.${serverId}`,
                `username.${username}`,
            ];

            const ws = new WebSocket(wsUrl, protocols);
            // 後端對 ping 的 pong 以「二進位」frame 回傳，好和 PTY 文字輸出區分（見 TerminalConsumer）；
            // 設為 arraybuffer 讓控制訊息以 ArrayBuffer 進來，一般 PTY 輸出仍是字串、照常寫入 xterm。
            ws.binaryType = "arraybuffer";
            wsRef.current = ws;

            // 應用層心跳：量測「你↔伺服器」RTT。onopen 立即送一次、之後每 5s 一次；記錄送出時間，
            // 收到 pong（二進位）時算差值。cleanup / onclose 會清掉 interval，避免重連時洩漏。
            let pingSentAt = 0;
            let pingInterval: ReturnType<typeof setInterval> | null = null;
            const sendPing = () => {
                if (ws.readyState !== WebSocket.OPEN) return;
                pingSentAt = Date.now();
                ws.send(JSON.stringify({ action: "ping" }));
            };
            const stopPing = () => {
                if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
            };

            const handleWindowResize = () => sendResize(ws);
            window.addEventListener("resize", handleWindowResize);

            let resizeObserver: ResizeObserver | null = null;
            if (terminalRef.current?.parentElement) {
                let resizeTimeout: ReturnType<typeof setTimeout>;
                resizeObserver = new ResizeObserver(() => {
                    try {
                        fitAddon.fit();
                        term.scrollToBottom();
                    } catch { } // empty catch

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
                sendPing();
                stopPing();
                pingInterval = setInterval(sendPing, 5000);
            };

            ws.onmessage = (event) => {
                // 二進位 frame = 後端對 ping 的 pong 控制訊息，用來量測 RTT，「不可」寫進 xterm 畫面。
                // 一般 PTY 輸出一律是字串（TerminalConsumer.forward_output 只送 text_data）。
                if (typeof event.data !== "string") {
                    setLatencyMs(Math.max(0, Date.now() - pingSentAt));
                    return;
                }
                term.write(event.data);
            };

            ws.onerror = () => {
                setConnecting(false);
            };

            ws.onclose = (event) => {
                setConnected(false);
                setConnecting(false);
                setLatencyMs(null);
                stopPing();
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
                } else if (code === 4006) {
                    setNoUsers(true);
                    term.write("\r\n\x1b[31m[No Users] No target server users configured for this tunnel.\x1b[0m\r\n");
                } else {
                    term.write("\r\n\x1b[31m[Disconnected from server]\x1b[0m\r\n");
                }
            };

            term.onData((data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: "pty_input", payload: { input: data } }));
                }
            });

            cleanupFn = () => {
                stopPing();
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
    }, [serverId, accessToken, username, reconnectTrigger]);

    useEffect(() => {
        if (fitAddonRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
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
    }, [showFiles, mainView]);

    // 僅在「完整虛擬鍵盤」模式抑制原生鍵盤；accessory / hidden 模式保留原生鍵盤以便打字（含中文）。
    useEffect(() => {
        const suppressNative = keyboardMode === "full";
        const manageNativeKeyboard = () => {
            if (window.innerWidth < 768 && terminalRef.current) {
                const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
                if (textarea) {
                    if (suppressNative) {
                        textarea.setAttribute('readonly', 'true');
                        textarea.blur();
                    } else {
                        textarea.removeAttribute('readonly');
                    }
                }
            }
        };

        setTimeout(manageNativeKeyboard, 100);

        const handleFocus = () => {
            if (window.innerWidth < 768 && suppressNative && terminalRef.current) {
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
    }, [keyboardMode, connected]);

    useEffect(() => {
        if (keyboardExpanded && xtermRef.current) {
            setTimeout(() => {
                try {
                    xtermRef.current.scrollToBottom();
                } catch { } // empty catch
            }, 150);
        }
    }, [keyboardExpanded]);

    // Service Keys：開啟彈窗並呼叫 API，結果供 Terminal 頁與 Modal 顯示。
    // Service keys: open modal and call API; result used by terminal page and modal.
    const fetchServiceKeys = async () => {
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
    };

    return {
        refs: { terminalRef, xtermRef, wsRef },
        state: {
            connected, setConnected,
            connecting, setConnecting,
            latencyMs,
            permissionDenied, setPermissionDenied,
            noUsers, setNoUsers,
            showFiles, setShowFiles,
            isBrowserActive, setIsBrowserActive,
            keyboardExpanded, setKeyboardExpanded,
            keyboardMode, setKeyboardMode,
            headerExpanded, setHeaderExpanded,
            mainView, setMainView,
            syncedPath, setSyncedPath,
            serviceKeyModalOpen, setServiceKeyModalOpen,
            serviceKeys, setServiceKeys,
            loadingServiceKeys, setLoadingServiceKeys,
            username, setUsername,
            availableUsernames, setAvailableUsernames
        },
        actions: {
            fetchServiceKeys,
            reconnect: () => setReconnectTrigger(t => t + 1),
        }
    };
}
