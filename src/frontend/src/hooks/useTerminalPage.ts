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
    const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
    const [noUsers, setNoUsers] = useState(false);
    const [showFiles, setShowFiles] = useState(false);
    const [isBrowserActive, setIsBrowserActive] = useState(false);
    const [keyboardExpanded, setKeyboardExpanded] = useState(true);
    const [headerExpanded, setHeaderExpanded] = useState(false);
    const [mainView, setMainView] = useState<"terminal" | "browser" | "files">("terminal");
    const [syncedPath, setSyncedPath] = useState<string | undefined>();

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
    }, [serverId, accessToken, username]);

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

        setTimeout(manageNativeKeyboard, 100);

        const handleFocus = () => {
            if (window.innerWidth < 768 && keyboardExpanded && terminalRef.current) {
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
    }, [keyboardExpanded, connected]);

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
        refs: { terminalRef, xtermRef, fitAddonRef, wsRef },
        state: {
            connected, setConnected,
            connecting, setConnecting,
            permissionDenied, setPermissionDenied,
            noUsers, setNoUsers,
            showFiles, setShowFiles,
            isBrowserActive, setIsBrowserActive,
            keyboardExpanded, setKeyboardExpanded,
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
            fetchServiceKeys
        }
    };
}
