/**
 * 檔案管理面板邏輯：WebSocket 僅負責列表與 shell 偵測；上傳／下載皆走 REST。
 * File manager panel logic: WebSocket for listing and shell only; upload/download via REST.
 * - WebSocket：連線後 shell_detect、list_files；伺服器回傳目錄內容與路徑。
 *   WebSocket: shell_detect, list_files after connect; server returns directory and path.
 * - 上傳／下載：直接呼叫 REST API（POST /api/sftp/upload、GET /api/sftp/download）。
 *   Upload/Download: direct REST (POST upload, GET download).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { getWsOrigin } from "@/lib/websocket";
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
    const [reconnectTrigger, setReconnectTrigger] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadDirectory = useCallback((path: string, wsInstance: WebSocket | null = wsRef.current) => {
        if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;
        setLoading(true);
        wsInstance.send(JSON.stringify({ action: "list_files", payload: { path: path || currentPath } }));
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
                const data = await res.json();
                showError(data.error || "Upload failed");
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

    useEffect(() => {
        let cleanupFn: (() => void) | undefined;

        const initWs = async () => {
            const base = getWsOrigin();
            const wsUrl = `${base}/ws/filemanager/`;

            const encodedToken = btoa(accessToken);
            // Replace with standard crypto subtly for sha256 or ignore if we want to keep js-sha256 dependency
            const jsSha256 = (await import("js-sha256")).sha256;
            const ticket = `auth.${jsSha256(`filemanager_${serverId}.${Date.now()}`)}`;

            const protocols = [
                `token.${encodedToken}`,
                `server.${serverId}`,
                `username.${username}`,
                ticket,
            ];

            const ws = new WebSocket(wsUrl, protocols);
            wsRef.current = ws;

            ws.onopen = () => {
                setConnected(true);
                setConnecting(false);
                setError(null);
                ws.send(JSON.stringify({ action: "shell_detect" }));
            };

            ws.onmessage = async (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    const action = parsed.action;
                    const data = parsed.data || {};

                    if (action === "shell_detect" && data.status === "success") {
                        setShellType(data.shell);
                        const defaultPath = data.shell === "powershell" ? "C:\\" : "~/";
                        setCurrentPath(defaultPath);
                        loadDirectoryRef.current(defaultPath, ws);
                    } else if (action === "list_files") {
                        if (data.status === "success") {
                            setItems(data.files || []);
                            setCurrentPath(data.path);
                            setError(null);
                        } else {
                            setError(data.error || "Failed to list directory");
                        }
                        setLoading(false);
                    } else if (action === "error") {
                        setError(data.message || "An error occurred");
                        setLoading(false);
                        setUploading(false);
                    }
                } catch (e) {
                    console.error("Error parsing WS message", e);
                }
            };

            ws.onerror = () => {
                setError("FileManager connection failed");
                setConnecting(false);
                setLoading(false);
            };

            ws.onclose = () => {
                setConnected(false);
                setConnecting(false);
            };

            cleanupFn = () => {
                ws.close();
            };
        };

        if (serverId && username && accessToken) {
            initWs();
        }

        return () => {
            cleanupFn?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverId, username, accessToken, reconnectTrigger]);

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
            wsRef,
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
            setReconnectTrigger(t => t + 1);
        }
    };
}
