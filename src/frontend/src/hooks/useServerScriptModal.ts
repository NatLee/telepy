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
    const [loading, setLoading] = useState(false);
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

    // Fetch script content
    useEffect(() => {
        if (isOpen && tunnelId && defaultSshPort) {
            const fetchScript = async () => {
                setLoading(true);
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
                        setScriptContent(data.script ?? data.config ?? JSON.stringify(data, null, 2));
                    } else {
                        // Try to parse error for specific messages
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (e: any) {
                    showError(e.message || "Failed to load script");
                } finally {
                    setLoading(false);
                }
            };

            const timer = setTimeout(() => {
                fetchScript();
            }, 300); // debounce keyPath/port entry

            return () => clearTimeout(timer);
        }
    }, [isOpen, tunnelId, defaultSshPort, activeTab, keyPath, targetSshPort, selectedUsernameId, showError]);

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
        } else {
            // Reset username state on close
            setUsernames([]);
            setSelectedUsernameId(null);
            setUsernamesLoaded(false);
            setCurlCommand("");
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
                setCurlCommand(`curl -fsSL '${data.url}' | bash`);
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
            loading,
            usernames,
            selectedUsernameId, setSelectedUsernameId,
            curlCommand,
            generatingCurl,
            generateOneTimeUrl
        }
    };
}
