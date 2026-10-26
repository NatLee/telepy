/**
 * 檔案管理面板的連線與列表：WebSocket 只負責列目錄與 shell 偵測；檔案操作與上傳下載走 REST（見 useFileOps）。
 * File manager connection + listing: the WebSocket lists folders and detects the shell; operations, uploads and
 * downloads go through REST (see useFileOps).
 * - 連線生命週期（認證、退避重連、心跳）由共用的 ReconnectingSocket 處理；關閉碼變成 `link`（離線 / 要 step-up…），
 *   info 視覺說明用它標出卡在哪一段。
 *   The shared ReconnectingSocket handles the lifecycle; close codes become `link` (offline / step-up …) for the diagram.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { ReconnectingSocket } from "@/lib/reconnectingSocket";
import { FileItem } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { linkFromClose, parentPath, type FileLink } from "@/lib/fileManager";

/**
 * 每個（隧道, 帳號）上次看的目錄：面板收起來就卸載、斷線，再打開回到同一個目錄。
 * Last directory per (tunnel, account): closing the panel unmounts it, reopening returns there.
 */
const lastPaths = new Map<string, string>();

export function useFileManager(serverId: string, username: string, accessToken: string, initialPath?: string) {
    const { t } = useI18n();
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(true);
    const [link, setLink] = useState<FileLink>("connecting");
    const [currentPath, setCurrentPath] = useState("~/");
    /** 上一次列成功的目錄（輸入框可以被改，操作用這個）。/ The last listed folder (the input may be edited). */
    const [listedPath, setListedPath] = useState("~/");
    const [items, setItems] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [shellType, setShellType] = useState<"unix" | "powershell">("unix");
    const [error, setError] = useState<string | null>(null);

    const socketRef = useRef<ReconnectingSocket | null>(null);

    // 語言切換不該讓 WebSocket 重連;t 走 ref,只在訊息真的送達時才取用最新翻譯。
    // A language switch shouldn't reconnect the WebSocket; read t via a ref at message time instead.
    const tRef = useRef(t);
    useEffect(() => { tRef.current = t; }, [t]);

    const loadDirectory = useCallback((path: string) => {
        const s = socketRef.current;
        if (!s || !s.isOpen) return;
        setLoading(true);
        s.send(JSON.stringify({ action: "list_files", payload: { path: path || currentPath } }));
    }, [currentPath]);

    const loadDirectoryRef = useRef(loadDirectory);
    useEffect(() => { loadDirectoryRef.current = loadDirectory; }, [loadDirectory]);

    // WebSocket 連線：交由共用 ReconnectingSocket（第一則訊息帶 token 認證 + 退避重連 + 心跳）。
    useEffect(() => {
        if (!serverId || !username || !accessToken) return;
        setConnecting(true);
        setLink("connecting");
        const pathKey = `${serverId}\u0000${username}`;

        const socket = new ReconnectingSocket({
            path: "/ws/filemanager/",
            authFields: () => ({ server_id: serverId, username }),
            heartbeat: true,
            onStatus: (c) => {
                setConnected(c);
                setConnecting(false);
                if (c) setError(null);
            },
            onPhase: (p) => {
                setLink((prev) => {
                    if (p.state === "open") return "open";
                    if (p.state === "connecting") return prev === "offline" || prev === "stepup" ? prev : "connecting";
                    // 離線 / 要 step-up 的時候，重試或停止都維持那個說明。/ Keep offline / step-up while retrying or stopped.
                    if (prev === "offline" || prev === "stepup") return prev;
                    return p.state === "retrying" ? "retrying" : "stopped";
                });
            },
            // 一次不正常的斷線（1006）不蓋掉「裝置離線 / 要 step-up」的說明。/ A stray 1006 keeps the offline / step-up story.
            onClose: (code) => setLink((prev) => {
                const next = linkFromClose(code);
                return next === "retrying" && (prev === "offline" || prev === "stepup") ? prev : next;
            }),
            onOpen: (s) => {
                s.send(JSON.stringify({ action: "shell_detect" }));
            },
            onMessage: (data) => {
                try {
                    const parsed = JSON.parse(data);
                    const action = parsed.action;
                    const d = parsed.data || {};

                    if (action === "shell_detect" && d.status === "success") {
                        setLink("open");
                        setShellType(d.shell);
                        const startPath = lastPaths.get(pathKey) ?? (d.shell === "powershell" ? "C:\\" : "~/");
                        setCurrentPath(startPath);
                        loadDirectoryRef.current(startPath);
                    } else if (action === "list_files") {
                        if (d.status === "success") {
                            setItems(d.files || []);
                            setCurrentPath(d.path);
                            setListedPath(d.path);
                            if (typeof d.path === "string") lastPaths.set(pathKey, d.path);
                            setError(null);
                        } else {
                            setError(d.error || tRef.current("files.listFailed"));
                        }
                        setLoading(false);
                    } else if (action === "error") {
                        setError(d.message || tRef.current("files.genericError"));
                        setLoading(false);
                    }
                } catch (e) {
                    console.error("Error parsing WS message", e);
                }
            },
        });
        socketRef.current = socket;
        socket.start();

        return () => {
            socket.close();
            socketRef.current = null;
        };
    }, [serverId, username, accessToken]);

    useEffect(() => {
        if (connected && initialPath && initialPath !== currentPath) {
            setCurrentPath(initialPath);
            loadDirectory(initialPath);
        }
        // 只在終端機那邊同步了新路徑時跳過去。/ Only follow a newly synced path from the terminal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialPath, connected]);

    const handlePathSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        loadDirectory(currentPath);
    };

    const navigateTo = (folderName: string) => {
        const sep = shellType === "powershell" && !listedPath.includes("/") ? "\\" : "/";
        const next = listedPath.endsWith(sep) ? listedPath + folderName : listedPath + sep + folderName;
        loadDirectory(next);
    };

    const goUp = () => {
        const up = parentPath(listedPath);
        if (up) loadDirectory(up);
    };

    const goHome = () => {
        loadDirectory(shellType === "powershell" ? "C:\\" : "~/");
    };

    const refresh = useCallback(() => loadDirectory(listedPath), [loadDirectory, listedPath]);

    return {
        state: {
            connected,
            connecting,
            link,
            currentPath, setCurrentPath,
            listedPath,
            items,
            loading,
            shellType,
            error,
            setError,
        },
        actions: {
            loadDirectory,
            refresh,
            handlePathSubmit,
            navigateTo,
            goUp,
            goHome,
        },
        reconnect: () => {
            setError(null);
            setConnecting(true);
            setLink("connecting");
            socketRef.current?.reconnect();
        }
    };
}
