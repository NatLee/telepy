import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

interface TunnelUsername {
    id: number;
    username: string;
    created_by?: string;
    created_by_id?: number;
}

export function useServerScriptModal(tunnelId: number | null, defaultSshPort: number | null, isOpen: boolean) {
    const [activeTab, setActiveTab] = useState("ssh");
    const [scriptContent, setScriptContent] = useState<string>("");
    const [keyPath, setKeyPath] = useState<string>("");
    const [targetSshPort, setTargetSshPort] = useState<string>("22");
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [isFetchingScript, setIsFetchingScript] = useState(false);
    const [scriptsByTab, setScriptsByTab] = useState<Record<string, string>>({});
    const { showError } = useToast();

    // Username state for autossh-service tab
    const [usernames, setUsernames] = useState<TunnelUsername[]>([]);
    const [selectedUsernameId, setSelectedUsernameId] = useState<number | null>(null);
    const [usernamesLoaded, setUsernamesLoaded] = useState(false);

    // One-time curl URL state
    const [curlCommand, setCurlCommand] = useState<string>("");
    const [generatingCurl, setGeneratingCurl] = useState(false);

    // Fetch usernames from config API when modal opens
    useEffect(() => {
        if (isOpen && tunnelId && !usernamesLoaded) {
            const fetchUsernames = async () => {
                try {
                    const res = await apiFetch(`/tunnels/server/config/${tunnelId}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.usernames && Array.isArray(data.usernames)) {
                            setUsernames(data.usernames);
                            if (data.usernames.length > 0 && selectedUsernameId === null) {
                                setSelectedUsernameId(data.usernames[0].id);
                            }
                        }
                    }
                } catch {
                    // Silently fail — usernames dropdown just won't show
                }
                setUsernamesLoaded(true);
            };
            fetchUsernames();
        }
    }, [isOpen, tunnelId, usernamesLoaded, selectedUsernameId]);

    // Helper to compute cache key
    const getCacheKey = useCallback(() => {
        const port = targetSshPort || "22";
        const parts = [activeTab, port, keyPath];
        if (activeTab === "autossh-service" && selectedUsernameId !== null) {
            parts.push(String(selectedUsernameId));
        }
        return parts.join("|");
    }, [activeTab, targetSshPort, keyPath, selectedUsernameId]);

    // Effect 1: Immediate UI response via cache
    useEffect(() => {
        if (!isOpen || !tunnelId) return;
        const cacheKey = getCacheKey();
        if (scriptsByTab[cacheKey]) {
            setScriptContent(scriptsByTab[cacheKey]);
        }
    }, [isOpen, tunnelId, getCacheKey, scriptsByTab]);

    // Effect 2: Debounced API call if cache miss
    useEffect(() => {
        if (isOpen && tunnelId && defaultSshPort) {
            const cacheKey = getCacheKey();

            // If we already have it in cache, just mark initial load as done
            if (scriptsByTab[cacheKey]) {
                setIsInitialLoading(false);
                return;
            }

            const fetchScript = async () => {
                if (Object.keys(scriptsByTab).length === 0) {
                    setIsInitialLoading(true);
                }
                setIsFetchingScript(true);
                try {
                    const port = targetSshPort || "22";
                    const params = new URLSearchParams();
                    if (keyPath) {
                        params.set("key_path", keyPath);
                    }
                    if (activeTab === "autossh-service" && selectedUsernameId !== null) {
                        params.set("username_id", String(selectedUsernameId));
                    }
                    const qs = params.toString();
                    const url = `/tunnels/server/script/${activeTab}/${tunnelId}/${port}${qs ? `?${qs}` : ""}`;
                    const res = await apiFetch(url);
                    if (res.ok) {
                        const data = await res.json();
                        const content = data.script ?? data.config ?? JSON.stringify(data, null, 2);
                        setScriptContent(content);
                        setScriptsByTab(prev => ({ ...prev, [cacheKey]: content }));
                    } else {
                        try {
                            const errData = await res.json();
                            if (errData.error === "No username found for this server") {
                                showError("No username available for this tunnel. Please create a Target Server Username first.");
                            } else {
                                showError(errData.error || "Failed to load script");
                            }
                        } catch {
                            showError("Failed to load script");
                        }
                        setScriptContent("");
                    }
                } catch (e: any) {
                    showError(e.message || "Failed to load script");
                } finally {
                    setIsInitialLoading(false);
                    setIsFetchingScript(false);
                }
            };

            const timer = setTimeout(() => {
                fetchScript();
            }, 300);

            return () => clearTimeout(timer);
        }
    }, [isOpen, tunnelId, defaultSshPort, getCacheKey, scriptsByTab, targetSshPort, activeTab, keyPath, selectedUsernameId, showError]);

    // Clear curl command when relevant params change
    useEffect(() => {
        setCurlCommand("");
    }, [activeTab, keyPath, targetSshPort, selectedUsernameId]);

    // Reset tab when opening
    useEffect(() => {
        if (isOpen) {
            setActiveTab("ssh");
            setKeyPath("");
            setTargetSshPort(defaultSshPort?.toString() || "22");
            setIsInitialLoading(true);
        } else {
            // Reset state on close
            setUsernames([]);
            setSelectedUsernameId(null);
            setUsernamesLoaded(false);
            setCurlCommand("");
            setScriptsByTab({});
            setScriptContent("");
        }
    }, [isOpen, defaultSshPort]);

    // Generate one-time curl URL
    const generateOneTimeUrl = useCallback(async () => {
        if (!tunnelId) return;
        setGeneratingCurl(true);
        try {
            const body: Record<string, unknown> = {
                server_id: tunnelId,
                ssh_port: parseInt(targetSshPort || "22", 10),
                script_type: activeTab,
            };
            if (keyPath) body.key_path = keyPath;
            if (activeTab === "autossh-service" && selectedUsernameId !== null) {
                body.username_id = selectedUsernameId;
            }
            const res = await apiFetch("/tunnels/server/script/one-time/token", {
                method: "POST",
                body: JSON.stringify(body),
            });
            if (res.ok) {
                const data = await res.json();

                let cmd = "";
                if (activeTab === "ssh" || activeTab === "autossh" || activeTab === "docker-run") {
                    cmd = `curl -fsSL '${data.url}' | bash`;
                } else if (activeTab === "docker-compose") {
                    cmd = `curl -fsSL '${data.url}' -o telepy-docker-compose.yml && docker compose up -d`;
                } else if (activeTab === "autossh-service") {
                    cmd = `curl -fsSL '${data.url}' | bash`;
                } else if (activeTab === "powershell") {
                    cmd = `powershell -Command "Invoke-WebRequest -UseBasicParsing '${data.url}' -OutFile 'telepy-tunnel.ps1'; .\\telepy-tunnel.ps1"`;
                } else {
                    cmd = `curl -fsSL '${data.url}' | bash`;
                }

                setCurlCommand(cmd);
            } else {
                const errData = await res.json().catch(() => null);
                showError(errData?.error || "Failed to generate one-time URL");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to generate one-time URL");
        } finally {
            setGeneratingCurl(false);
        }
    }, [tunnelId, targetSshPort, activeTab, keyPath, selectedUsernameId, showError]);

    return {
        state: {
            activeTab, setActiveTab,
            scriptContent,
            keyPath, setKeyPath,
            targetSshPort, setTargetSshPort,
            isInitialLoading,
            isFetchingScript,
            usernames,
            selectedUsernameId, setSelectedUsernameId,
            curlCommand,
            generatingCurl,
            generateOneTimeUrl
        }
    };
}
