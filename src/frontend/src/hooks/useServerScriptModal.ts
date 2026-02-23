import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export function useServerScriptModal(tunnelId: number | null, defaultSshPort: number | null, isOpen: boolean) {
    const [activeTab, setActiveTab] = useState("ssh");
    const [scriptContent, setScriptContent] = useState<string>("");
    const [keyPath, setKeyPath] = useState<string>("");
    const [targetSshPort, setTargetSshPort] = useState<string>("22");
    const [loading, setLoading] = useState(false);
    const { showError } = useToast();

    useEffect(() => {
        if (isOpen && tunnelId && defaultSshPort) {
            const fetchScript = async () => {
                setLoading(true);
                try {
                    const port = targetSshPort || "22";
                    let url = `/tunnels/server/script/${activeTab}/${tunnelId}/${port}`;
                    if (keyPath) {
                        url += `?key_path=${encodeURIComponent(keyPath)}`;
                    }
                    const res = await apiFetch(url);
                    if (res.ok) {
                        const data = await res.json();
                        setScriptContent(data.script ?? data.config ?? JSON.stringify(data, null, 2));
                    } else {
                        showError("Failed to load script");
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
    }, [isOpen, tunnelId, defaultSshPort, activeTab, keyPath, targetSshPort, showError]);

    // Reset tab when opening
    useEffect(() => {
        if (isOpen) {
            setActiveTab("ssh");
            setKeyPath("");
            setTargetSshPort(defaultSshPort?.toString() || "22");
        }
    }, [isOpen, defaultSshPort]);

    return {
        state: {
            activeTab, setActiveTab,
            scriptContent,
            keyPath, setKeyPath,
            targetSshPort, setTargetSshPort,
            loading
        }
    };
}
