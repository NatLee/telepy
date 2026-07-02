/**
 * 檔案管理面板邏輯：WebSocket 僅負責列表與 shell 偵測；上傳／下載皆走 REST。
 * File manager panel logic: WebSocket for listing and shell only; upload/download via REST.
 * - 連線生命週期（ticket 認證、退避重連、心跳）由共用的 ReconnectingSocket 處理。
 *   Connection lifecycle (ticket auth, backoff reconnect, heartbeat) handled by the shared ReconnectingSocket.
 * - WebSocket：連線後 shell_detect、list_files；伺服器回傳目錄內容與路徑。
 * - 上傳／下載：直接呼叫 REST API（POST /api/sftp/upload、GET /api/sftp/download）。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { ReconnectingSocket } from "@/lib/reconnectingSocket";
import { FileItem } from "@/types/tunnel";

export function useFileManager(serverId: string, username: string, accessToken: string, initialPath?: string) {
    const { showError, showSuccess } = useToast();
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(true);
    const [currentPath, setCurrentPath] = useState("~/");
    const [items, setItems] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [shellType, setShellType] = useState<"unix" | "powershell">("unix");
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const socketRef = useRef<ReconnectingSocket | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadDirectory = useCallback((path: string) => {
        const s = socketRef.current;
        if (!s || !s.isOpen) return;
        setLoading(true);
        s.send(JSON.stringify({ action: "list_files", payload: { path: path || currentPath } }));
    }, [currentPath]);

    const loadDirectoryRef = useRef(loadDirectory);
    useEffect(() => { loadDirectoryRef.current = loadDirectory; }, [loadDirectory]);

    const performActualUpload = useCallback(async (uploadUrl: string, file: File) => {
        try {
            const formData = new FormData();
            formData.append("file", file);

            const res = await apiFetch(uploadUrl, {
                method: "POST",
                body: formData,
            });

            if (res.ok) {
                showSuccess("File uploaded successfully");
                loadDirectory(currentPath);
            } else {
                const data = await readJson(res);
                showError(responseError(res, data, "Upload failed"));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            showError("Upload request failed: " + err.message);
        } finally {
            setUploading(false);
        }
    }, [currentPath, loadDirectory, showError, showSuccess]);

    const downloadUrl = useCallback(async (url: string, path?: string) => {
        try {
            const res = await apiFetch(url);
            if (!res.ok) {
                let message = "Download request failed";
                try {
                    const data = await res.json();
                    if (data?.error && typeof data.error === "string") message = data.error;
                } catch {
                    // ignore non-JSON body
                }
                throw new Error(message);
            }

            let filename = path && typeof path === 'string' ? path.split(/[/\\]/).pop() || "download" : "download";
            const disposition = res.headers.get('Content-Disposition');
            if (disposition && disposition.includes('filename=')) {
                // eslint-disable-next-line no-useless-escape
                const match = disposition.match(/filename="?([^"]+)"?/);
                if (match && match[1]) {
                    filename = match[1];
                }
            }

            const blob = await res.blob();
            const windowUrl = window.URL;
            const blobUrl = windowUrl.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            windowUrl.revokeObjectURL(blobUrl);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            showError("Failed to download file: " + err.message);
        }
    }, [showError]);

    // WebSocket 連線：交由共用 ReconnectingSocket（第一則訊息帶 token 認證 + 退避重連 + 心跳）。
    useEffect(() => {
        if (!serverId || !username || !accessToken) return;
        setConnecting(true);

        const socket = new ReconnectingSocket({
            path: "/ws/filemanager/",
            authFields: () => ({ server_id: serverId, username }),
            heartbeat: true,
            onStatus: (c) => {
                setConnected(c);
                setConnecting(false);
                if (c) setError(null);
            },
            onOpen: (s) => {
                s.send(JSON.stringify({ action: "shell_detect" }));
            },
            onMessage: (data) => {
                try {
                    const parsed = JSON.parse(data);
                    const action = parsed.action;
                    const d = parsed.data || {};

                    if (action === "shell_detect" && d.status === "success") {
                        setShellType(d.shell);
                        const defaultPath = d.shell === "powershell" ? "C:\\" : "~/";
                        setCurrentPath(defaultPath);
                        loadDirectoryRef.current(defaultPath);
                    } else if (action === "list_files") {
                        if (d.status === "success") {
                            setItems(d.files || []);
                            setCurrentPath(d.path);
                            setError(null);
                        } else {
                            setError(d.error || "Failed to list directory");
                        }
                        setLoading(false);
                    } else if (action === "error") {
                        setError(d.message || "An error occurred");
                        setLoading(false);
                        setUploading(false);
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
    }, [initialPath, connected, currentPath, loadDirectory]);

    const handlePathSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        loadDirectory(currentPath);
    };

    const navigateTo = (folderName: string) => {
        let newPath = currentPath;
        if (shellType === "powershell") {
            newPath = currentPath.endsWith("\\") ? currentPath + folderName : currentPath + "\\" + folderName;
        } else {
            newPath = currentPath.endsWith("/") ? currentPath + folderName : currentPath + "/" + folderName;
        }
        loadDirectory(newPath);
    };

    const goUp = () => {
        let newPath = currentPath;
        if (shellType === "powershell") {
            const parts = newPath.split("\\").filter(Boolean);
            if (parts.length > 1) {
                parts.pop();
                newPath = parts.join("\\") + "\\";
            } else {
                newPath = parts[0] + "\\";
            }
        } else {
            if (newPath === "/" || newPath === "~" || newPath === "~/") return;
            const stripped = newPath.endsWith("/") ? newPath.slice(0, -1) : newPath;
            const lastSlashIndex = stripped.lastIndexOf("/");
            if (lastSlashIndex > 0) {
                newPath = stripped.slice(0, lastSlashIndex);
                if (newPath === "~") newPath = "~/";
            } else if (lastSlashIndex === 0) {
                newPath = "/";
            }
        }
        loadDirectory(newPath);
    };

    const goHome = () => {
        const homePath = shellType === "powershell" ? "C:\\" : "~/";
        loadDirectory(homePath);
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        const uploadUrl = `/api/sftp/upload/${serverId}/${encodeURIComponent(username)}?destination_path=${encodeURIComponent(currentPath)}`;
        performActualUpload(uploadUrl, file);

        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }, [serverId, username, currentPath, performActualUpload]);

    const handleDownload = useCallback((item: FileItem) => {
        showSuccess("Downloading...");
        const separator = shellType === "powershell" ? "\\" : "/";
        const path = currentPath.endsWith(separator) ? currentPath + item.name : currentPath + separator + item.name;
        const url = `/api/sftp/download/${serverId}/${encodeURIComponent(username)}?path=${encodeURIComponent(path)}`;
        downloadUrl(url, path);
    }, [serverId, username, currentPath, shellType, downloadUrl, showSuccess]);

    return {
        refs: {
            fileInputRef
        },
        state: {
            connected,
            connecting,
            currentPath, setCurrentPath,
            items,
            loading,
            shellType,
            uploading,
            error
        },
        actions: {
            loadDirectory,
            handlePathSubmit,
            navigateTo,
            goUp,
            goHome,
            handleUploadClick,
            handleFileChange,
            handleDownload
        },
        reconnect: () => {
            setError(null);
            setConnecting(true);
            socketRef.current?.reconnect();
        }
    };
}
