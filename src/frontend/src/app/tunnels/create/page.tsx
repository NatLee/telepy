"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { isValidSSHKey, getHostFriendlyNameFromKey } from "@/lib/utils";
import { useTunnelConnectionWebSocket } from "@/lib/websocket";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ConnectionStatusLight } from "@/components/ui/ConnectionStatusLight";
import { formatApiError } from "@/lib/formatApiError";
import { Info, Eye } from "lucide-react";
import { Check, ChevronRight, Copy, Terminal, Key, Users, Activity, CheckCircle2, AlertTriangle } from "lucide-react";
import Link from "next/link";

const STEPS = [
    { id: 1, title: "Basic Config", icon: <Terminal size={18} /> },
    { id: 2, title: "Server Keys", icon: <Key size={18} /> },
    { id: 3, title: "Server Users", icon: <Users size={18} /> },
    { id: 4, title: "Test Connection", icon: <Activity size={18} /> },
    { id: 5, title: "Completion", icon: <CheckCircle2 size={18} /> },
];

export default function CreateTunnelWizard() {
    const router = useRouter();
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
    const [userKeys, setUserKeys] = useState<any[]>([]);
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
    const handleKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const key = e.target.value;
        setSshKey(key);
        if (!hostName && isValidSSHKey(key)) {
            setHostName(getHostFriendlyNameFromKey(key, ""));
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
            // 1. Get Token
            const tokenRes = await apiFetch("/api/reverse/issue/token");
            if (!tokenRes.ok) throw new Error("Failed to get issue token");
            const tokenData = await tokenRes.json();
            const token = tokenData.token;

            // 2. Create Key
            const payload: any = {
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

                // Fetch keys for Step 2
                fetchServerKeys();
                setCurrentStep(2);
            } else {
                showError(formatApiError(createData, "Failed to create tunnel."));
            }
        } catch (e: any) {
            showError(e.message || "Failed to create tunnel.");
        } finally {
            setIsProcessing(false);
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

    // --- Step 3 Handlers ---
    const fetchUsers = async () => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/usernames`);
            if (res.ok) {
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data.results ?? []);
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
                // Backend model field is 'reverse_server' (FK), not 'server_id'
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

    // Load users when entering step 3
    useEffect(() => {
        if (currentStep === 3) fetchUsers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentStep, tunnelId]);

    // --- Step 4 Script Fetch ---
    useEffect(() => {
        if (currentStep === 4 && tunnelId && sshPort) {
            const fetchScripts = async () => {
                try {
                    const [sshRes, autosshRes] = await Promise.all([
                        apiFetch(`/tunnels/server/script/ssh/${tunnelId}/${sshPort}`),
                        apiFetch(`/tunnels/server/script/autossh/${tunnelId}/${sshPort}`),
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
    }, [currentStep, tunnelId, sshPort]);

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

    return (
        <div className="max-w-4xl mx-auto pb-12 animate-fade-in-up">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-gray-900">Create New Tunnel</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Follow the steps to configure and deploy a new reverse SSH tunnel.
                </p>
            </div>

            {/* Progress Indicator */}
            <div className="mb-8 overflow-hidden rounded-lg bg-white shadow ring-1 ring-gray-900/5">
                <div className="flex bg-gray-50 border-b border-gray-200 divide-x divide-gray-200">
                    {STEPS.map((step, idx) => {
                        const isActive = step.id === currentStep;
                        const isCompleted = step.id < currentStep;
                        return (
                            <div
                                key={step.id}
                                className={`flex-1 relative py-4 px-2 text-center text-sm font-medium ${isActive ? "bg-white text-green-600 after:absolute after:bottom-0 after:left-0 after:w-full after:h-[2px] after:bg-green-600 after:origin-left after:animate-progress-fill" : isCompleted ? "text-gray-900" : "text-gray-400"
                                    }`}
                            >
                                <div className="flex flex-col items-center justify-center gap-2">
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-full ${isActive ? 'bg-green-100 ring-4 ring-green-100/50 animate-pulse-glow' : isCompleted ? 'bg-green-500 text-white' : 'bg-gray-100'}`}>
                                        {isCompleted ? <Check size={16} /> : <span className={isActive ? 'animate-pulse-step block flex items-center justify-center' : ''}>{step.icon}</span>}
                                    </div>
                                    <span className="hidden sm:block">{step.title}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* --- STEP 1: Basic Info --- */}
                {currentStep === 1 && (
                    <form className="p-6 sm:p-8" onSubmit={handleStep1Submit}>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-blue-800">
                            <Info size={16} className="mt-0.5 shrink-0" />
                            <span>Paste the <strong>public key</strong> from the machine you want to connect. A one-time token is issued automatically. The SSH port defaults to <code className="bg-blue-100 px-1 rounded">22</code>.</span>
                        </div>
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-semibold text-gray-800 mb-1">
                                    SSH Public Key <span className="text-red-500">*</span>
                                </label>
                                <textarea
                                    required
                                    rows={4}
                                    value={sshKey}
                                    onChange={handleKeyChange}
                                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm font-mono bg-slate-50"
                                    placeholder="ssh-rsa AAAAB3NzaC1yc... user@machine"
                                />
                                <p className="mt-1 text-xs text-gray-500">Used by the server to authenticate via reverse tunneling.</p>
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-gray-800 mb-1">
                                    Host Friendly Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    required
                                    value={hostName}
                                    onChange={(e) => setHostName(e.target.value)}
                                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                                    placeholder="e.g. My Ubuntu Server"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-gray-800 mb-1">
                                    SSH Port
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={endpointSshPort}
                                    onChange={(e) => setEndpointSshPort(Number(e.target.value))}
                                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                                    placeholder="22"
                                />
                                <p className="mt-1 text-xs text-gray-500">Enter your server&apos;s SSH port. Default is 22.</p>
                            </div>
                        </div>

                        <div className="mt-8 flex justify-end">
                            <button
                                type="submit"
                                disabled={isProcessing}
                                className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-70"
                            >
                                {isProcessing ? "Processing..." : "Next Step"}
                                {!isProcessing && <ChevronRight size={16} className="ml-2 -mr-1" />}
                            </button>
                        </div>
                    </form>
                )}

                {/* --- STEP 2: Server Keys --- */}
                {currentStep === 2 && (
                    <div className="p-6 sm:p-8">
                        <h3 className="text-lg font-medium text-gray-900 mb-4">Add the following keys to your remote server&apos;s authorized_keys</h3>
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-amber-800">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                            <span>Copy each key below and append it to <code className="bg-amber-100 px-1 rounded">~/.ssh/authorized_keys</code> on your target server. <strong>Service keys</strong> enable the web terminal; <strong>User keys</strong> are for your personal SSH access.</span>
                        </div>
                        <p className="text-sm text-gray-500 mb-6">These keys allow the Telepy system and web terminal to connect to your endpoint.</p>

                        <div className="space-y-6 relative">
                            <div>
                                <h4 className="text-sm font-bold text-gray-700 mb-2">Service Keys</h4>
                                {serviceKeys.length > 0 ? (
                                    <ul className="space-y-2">
                                        {serviceKeys.map((sk, i) => (
                                            <li key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                                                <span className="text-sm font-medium text-gray-700">{sk.service || sk.host_friendly_name || `Service Key ${i + 1}`}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setKeyModalTitle(sk.service || `Service Key ${i + 1}`);
                                                        setKeyModalContent(sk.key || sk.public_key || "");
                                                        setKeyModalOpen(true);
                                                    }}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                                                >
                                                    <Eye size={14} /> View Key
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                ) : <p className="text-sm text-gray-500">No service keys found.</p>}
                            </div>

                            <div>
                                <h4 className="text-sm font-bold text-gray-700 mb-2">User Keys</h4>
                                {userKeys.length > 0 ? (
                                    <ul className="space-y-2">
                                        {userKeys.map((uk, i) => (
                                            <li key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                                                <span className="text-sm font-medium text-gray-700">{uk.host_friendly_name || `User Key ${i + 1}`}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setKeyModalTitle(uk.host_friendly_name || `User Key ${i + 1}`);
                                                        setKeyModalContent(uk.key || uk.public_key || "");
                                                        setKeyModalOpen(true);
                                                    }}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                                                >
                                                    <Eye size={14} /> View Key
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                ) : <p className="text-sm text-gray-500">No user keys found.</p>}
                            </div>
                        </div>

                        <div className="mt-8 flex justify-between">
                            <button
                                type="button"
                                onClick={() => setCurrentStep(1)}
                                className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none"
                            >
                                Back
                            </button>
                            <button
                                type="button"
                                onClick={() => setCurrentStep(3)}
                                className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none"
                            >
                                Next Step
                                <ChevronRight size={16} className="ml-2 -mr-1" />
                            </button>
                        </div>
                    </div>
                )}

                {/* --- STEP 3: Manage Users --- */}
                {currentStep === 3 && (
                    <div className="p-6 sm:p-8">
                        <h3 className="text-lg font-medium text-gray-900 mb-4">Target Server Users</h3>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-blue-800">
                            <Info size={16} className="mt-0.5 shrink-0" />
                            <span>Add at least one OS user that <strong>actually exists</strong> on your target server (e.g. <code className="bg-blue-100 px-1 rounded">root</code>, <code className="bg-blue-100 px-1 rounded">ubuntu</code>). Connections will only be allowed for listed usernames.</span>
                        </div>
                        <p className="text-sm text-gray-500 mb-6">
                            Specify which OS usernames (e.g., root, ubuntu, your_name) on your server are allowed to be used for connections via this tunnel.
                        </p>

                        <form onSubmit={handleAddUser} className="flex gap-2 mb-6">
                            <input
                                type="text"
                                value={newUsername}
                                onChange={(e) => setNewUsername(e.target.value)}
                                placeholder="e.g. root"
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                            />
                            <button
                                type="submit"
                                disabled={!newUsername.trim() || isProcessing}
                                className="inline-flex items-center px-6 py-2 border border-transparent shadow-sm text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
                            >
                                Add User
                            </button>
                        </form>

                        <div className="bg-white border rounded-lg overflow-hidden mb-8">
                            {users.length === 0 ? (
                                <div className="p-8 text-center text-gray-500">No users added yet. Adds users to enable connections.</div>
                            ) : (
                                <ul className="divide-y divide-gray-200">
                                    {users.map((u) => (
                                        <li key={u.id} className="px-6 py-4 flex items-center justify-between">
                                            <span className="font-medium text-gray-900">{u.username}</span>
                                            <button onClick={() => handleDeleteUser(u)} className="text-red-500 hover:text-red-700 text-sm font-medium">Remove</button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="flex justify-between">
                            <button onClick={() => setCurrentStep(2)} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">Back</button>
                            <button onClick={() => setCurrentStep(4)} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">Next Step <ChevronRight size={16} className="ml-2 -mr-1" /></button>
                        </div>
                    </div>
                )}

                {/* --- STEP 4: Test Connection --- */}
                {currentStep === 4 && (
                    <div className="p-6 sm:p-8">
                        <h3 className="text-lg font-medium text-gray-900 mb-4">Execute Connection Script</h3>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 flex items-start gap-2 text-sm text-blue-800">
                            <Info size={16} className="mt-0.5 shrink-0" />
                            <span>Run this script <strong>on your target server</strong> to establish the reverse tunnel.</span>
                        </div>
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-amber-800">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                            <span>Make sure the keys from <strong>Step 2</strong> are already in <code className="bg-amber-100 px-1 rounded">~/.ssh/authorized_keys</code> before running. Testing is optional — you can also retrieve scripts later from the Tunnels page.</span>
                        </div>

                        <div className="space-y-6 mb-6">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-800 mb-2">Option 1: Quick Testing (Standard SSH)</h4>
                                <CodeBlock language="bash" value={sshScriptContent} />
                            </div>
                            <div>
                                <h4 className="text-sm font-semibold text-gray-800 mb-2">Option 2: Persistent Connection (AutoSSH)</h4>
                                <CodeBlock language="bash" value={autosshScriptContent} />
                            </div>
                        </div>

                        <div className={`p-5 rounded-lg border flex items-center gap-5 ${status?.is_connected ? 'bg-green-50 border-green-200 text-green-800' : 'bg-yellow-50 border-yellow-200 text-yellow-800'}`}>
                            <ConnectionStatusLight state={status?.is_connected ? 'connected' : 'disconnected'} size={48} />
                            <div>
                                <strong className="block text-sm mb-1">Connection Status</strong>
                                <span className="text-sm">
                                    {status?.is_connected
                                        ? `Connected! Tunnel "${status.host_friendly_name ?? createdHostName}" is active on port ${status.reverse_port ?? sshPort}.`
                                        : "Waiting for connection from the remote endpoint..."}
                                </span>
                            </div>
                        </div>

                        <div className="mt-8 flex justify-between">
                            <button onClick={() => setCurrentStep(3)} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">Back</button>
                            <button onClick={() => setCurrentStep(5)} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">Next Step <ChevronRight size={16} className="ml-2 -mr-1" /></button>
                        </div>
                    </div>
                )}

                {/* --- STEP 5: Completion --- */}
                {currentStep === 5 && (
                    <div className="p-6 sm:p-8 text-center">
                        <div className="mx-auto flex items-center justify-center h-20 w-20 rounded-full bg-green-100 mb-6 shadow-iner border-4 border-white shadow-xl shadow-green-100">
                            <CheckCircle2 size={40} className="text-green-600" />
                        </div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">Tunnel Created!</h2>
                        <p className="text-gray-500 mb-8 max-w-lg mx-auto">
                            Your tunnel <strong>{createdHostName}</strong> has been configured successfully. It is assigned to port <strong>{sshPort}</strong>.
                        </p>

                        <div className="text-left bg-slate-900 rounded-lg p-6 mb-8 max-w-lg mx-auto">
                            <h4 className="text-sm font-medium text-gray-300 mb-1 text-center">SSH Config</h4>
                            <p className="text-xs text-gray-400 mb-3 text-center">Add this to your local <code className="bg-slate-800 px-1 rounded">~/.ssh/config</code> to connect directly via SSH.</p>
                            {configLoading ? (
                                <div className="flex justify-center py-4">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                                </div>
                            ) : (
                                <CodeBlock language="txt" value={configContent} />
                            )}
                        </div>

                        <Link
                            href="/tunnels"
                            className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 shadow-md hover:shadow-lg transition-all"
                        >
                            Go to Tunnels Dashboard
                        </Link>
                    </div>
                )}
            </div>

            {/* Key Modal */}
            {keyModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-black/50" onClick={() => setKeyModalOpen(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl max-w-xl w-full p-6 z-10">
                        <h3 className="text-lg font-bold text-gray-900 mb-1">{keyModalTitle}</h3>
                        <p className="text-xs text-gray-500 mb-4">Copy this key and append it to <code className="bg-gray-100 px-1 rounded">~/.ssh/authorized_keys</code> on your target server.</p>
                        <textarea
                            readOnly
                            value={keyModalContent}
                            rows={6}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-xs font-mono bg-gray-50 resize-none focus:outline-none"
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(keyModalContent);
                                    showSuccess("Key copied to clipboard!");
                                }}
                                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
                            >
                                <Copy size={14} /> Copy
                            </button>
                            <button
                                onClick={() => setKeyModalOpen(false)}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
