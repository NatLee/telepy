/**
 * 建立通道精靈邏輯：五步驟狀態、API 順序與 WebSocket 連線狀態。
 * Create tunnel wizard logic: five-step state, API order and WebSocket connection status.
 * - 步驟依賴：Step1 送出取得 tunnelId/port → Step2 拉取 keys → Step3 管理 users → Step4 腳本與 WS 狀態 → Step5 拉取 config。
 *   Step order: Step1 submit yields tunnelId/port; Step2 fetch keys; Step3 users; Step4 scripts + WS status; Step5 fetch config.
 */
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { isValidSSHKey, getHostFriendlyNameFromKey } from "@/lib/utils";
import { useTunnelConnectionWebSocket } from "@/lib/websocket";
import { formatApiError } from "@/lib/formatApiError";

export function useCreateTunnelWizard() {
    const { showSuccess, showError } = useToast();
    const [currentStep, setCurrentStep] = useState(1);
    const [isProcessing, setIsProcessing] = useState(false);

    // Step 1 State
    const [sshKey, setSshKey] = useState("");
    const [hostName, setHostName] = useState("");
    const [endpointSshPort, setEndpointSshPort] = useState(22);

    // Tunnel Data State
    const [tunnelId, setTunnelId] = useState<number | null>(null);
    const [sshPort, setSshPort] = useState<number | null>(null);
    const [createdHostName, setCreatedHostName] = useState("");

    // Step 2 State
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [userKeys, setUserKeys] = useState<any[]>([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [serviceKeys, setServiceKeys] = useState<any[]>([]);

    // Step 3 State
    const [users, setUsers] = useState<{ id: number; username: string }[]>([]);
    const [newUsername, setNewUsername] = useState("");

    // Step 4 State
    const [sshScriptContent, setSshScriptContent] = useState("");
    const [autosshScriptContent, setAutosshScriptContent] = useState("");
    const { status } = useTunnelConnectionWebSocket(tunnelId ? String(tunnelId) : null);

    // Step 2 Key Modal State
    const [keyModalOpen, setKeyModalOpen] = useState(false);
    const [keyModalContent, setKeyModalContent] = useState("");
    const [keyModalTitle, setKeyModalTitle] = useState("");

    // Step 5 Config State
    const [configContent, setConfigContent] = useState("");
    const [configLoading, setConfigLoading] = useState(false);

    // --- Common Handlers ---
    // Step1BasicConfig passes (v: string); direct onChange passes React.ChangeEvent. Accept both.
    const handleKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement> | string) => {
        const key = typeof e === "string" ? e : (e.target?.value ?? "");
        setSshKey(key);
        if (!hostName && isValidSSHKey(key)) {
            setHostName(getHostFriendlyNameFromKey(key, ""));
        }
    };

    // --- Step 2 Fetch ---
    const fetchServerKeys = async () => {
        try {
            const [uRes, sRes] = await Promise.all([
                apiFetch("/api/reverse/user/keys"),
                apiFetch("/api/reverse/service/keys"),
            ]);
            if (uRes.ok) setUserKeys(await uRes.json());
            if (sRes.ok) setServiceKeys(await sRes.json());
        } catch (e) {
            console.error(e);
        }
    };

    // --- Step 1 Submit ---
    const handleStep1Submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isValidSSHKey(sshKey)) {
            showError("Invalid SSH Public Key format.");
            return;
        }

        setIsProcessing(true);
        try {
            const tokenRes = await apiFetch("/api/reverse/issue/token");
            if (!tokenRes.ok) throw new Error("Failed to get issue token");
            const tokenData = await tokenRes.json();
            const token = tokenData.token;

            const payload = {
                key: sshKey,
                host_friendly_name: hostName || "Unnamed Host",
                ssh_port: endpointSshPort,
            };

            const createRes = await apiFetch(`/api/reverse/create/key/${token}`, {
                method: "POST",
                body: JSON.stringify(payload),
            });

            const createData = await createRes.json();
            if (createRes.ok) {
                showSuccess("Tunnel key created successfully.");
                setTunnelId(createData.id);
                setSshPort(createData.reverse_port);
                setCreatedHostName(payload.host_friendly_name);

                fetchServerKeys();
                setCurrentStep(2);
            } else {
                showError(formatApiError(createData, "Failed to create tunnel."));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to create tunnel.");
        } finally {
            setIsProcessing(false);
        }
    };

    // --- Step 3 Handlers ---
    const fetchUsers = async () => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/usernames`);
            if (res.ok) {
                const data = await res.json();
                const list = data?.usernames ?? (Array.isArray(data) ? data : (data.results ?? []));
                setUsers(list);
            }
        } catch (e) { console.error(e); }
    };

    const handleAddUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newUsername.trim() || !tunnelId) return;
        setIsProcessing(true);
        try {
            const res = await apiFetch(`/api/reverse/server/usernames`, {
                method: "POST",
                body: JSON.stringify({ reverse_server: tunnelId, username: newUsername.trim() }),
            });
            if (res.ok) {
                showSuccess(`User '${newUsername}' added.`);
                setNewUsername("");
                fetchUsers();
            } else {
                const data = await res.json();
                showError(formatApiError(data, "Failed to add user"));
            }
        } finally { setIsProcessing(false); }
    };

    const handleDeleteUser = async (user: { id: number; username: string }) => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/usernames/${user.id}`, {
                method: "DELETE",
            });
            if (res.ok) fetchUsers();
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        if (currentStep === 3) fetchUsers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentStep, tunnelId]);

    // --- Step 4 Script Fetch ---
    useEffect(() => {
        if (currentStep === 4 && tunnelId && endpointSshPort) {
            const fetchScripts = async () => {
                try {
                    const [sshRes, autosshRes] = await Promise.all([
                        apiFetch(`/tunnels/server/script/ssh/${tunnelId}/${endpointSshPort}`),
                        apiFetch(`/tunnels/server/script/autossh/${tunnelId}/${endpointSshPort}`),
                    ]);
                    if (sshRes.ok) {
                        const data = await sshRes.json();
                        setSshScriptContent(data.script ?? data.config ?? "");
                    }
                    if (autosshRes.ok) {
                        const data = await autosshRes.json();
                        setAutosshScriptContent(data.script ?? data.config ?? "");
                    }
                } catch (e) { console.error(e); }
            };
            fetchScripts();
        }
    }, [currentStep, tunnelId, endpointSshPort]);

    // --- Step 5 Config Fetch ---
    useEffect(() => {
        if (currentStep === 5 && tunnelId) {
            const fetchConfig = async () => {
                setConfigLoading(true);
                try {
                    const res = await apiFetch(`/tunnels/server/config/${tunnelId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setConfigContent(data.config || "No configuration available");
                    } else {
                        setConfigContent("Error loading configuration");
                    }
                } catch {
                    setConfigContent("Error loading configuration");
                } finally {
                    setConfigLoading(false);
                }
            };
            fetchConfig();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentStep, tunnelId]);

    return {
        state: {
            currentStep, setCurrentStep,
            isProcessing, setIsProcessing,
            sshKey, setSshKey,
            hostName, setHostName,
            endpointSshPort, setEndpointSshPort,
            tunnelId, setTunnelId,
            sshPort, setSshPort,
            createdHostName, setCreatedHostName,
            userKeys, setUserKeys,
            serviceKeys, setServiceKeys,
            users, setUsers,
            newUsername, setNewUsername,
            sshScriptContent, setSshScriptContent,
            autosshScriptContent, setAutosshScriptContent,
            status,
            keyModalOpen, setKeyModalOpen,
            keyModalContent, setKeyModalContent,
            keyModalTitle, setKeyModalTitle,
            configContent, setConfigContent,
            configLoading, setConfigLoading
        },
        actions: {
            handleKeyChange,
            handleStep1Submit,
            handleAddUser,
            handleDeleteUser,
        }
    };
}
