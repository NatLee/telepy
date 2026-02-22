"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, Monitor, RefreshCw, Cog, Container, FileCode, Info } from "lucide-react";

interface ServerScriptModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
    sshPort: number | null;
}

const TABS = [
    { id: "ssh", label: "SSH", icon: Terminal, ext: "ssh" },
    { id: "powershell", label: "PowerShell", icon: Monitor, ext: "ps1" },
    { id: "autossh", label: "AutoSSH", icon: RefreshCw, ext: "sh" },
    { id: "autossh-service", label: "AutoSSH Service", icon: Cog, ext: "service" },
    { id: "docker-run", label: "Docker Run", icon: Container, ext: "sh" },
    { id: "docker-compose", label: "Docker Compose", icon: FileCode, ext: "yaml" },
];

const TAB_DESCRIPTIONS: Record<string, string> = {
    ssh: "Run this on your target server to establish a one-time reverse SSH tunnel back to Telepy. Suitable for quick testing.",
    powershell: "Run this on a Windows target server. On Windows Server, you may need to add the service key to the administrators_authorized_keys file instead of the user's authorized_keys.",
    autossh: "Run this on your target server. AutoSSH automatically reconnects the reverse tunnel if the connection drops — ideal for production use.",
    "autossh-service": "Install this as a systemd service on your target server so the reverse tunnel starts automatically on boot.",
    "docker-run": "Run this on your target server to start the reverse tunnel inside a Docker container.",
    "docker-compose": "Use this Docker Compose file on your target server for a persistent, reproducible tunnel deployment.",
};

const TAB_TUTORIALS: Record<string, string[]> = {
    "autossh-service": [
        "1. Save this file as /etc/systemd/system/telepy-tunnel.service",
        "2. Run: sudo systemctl daemon-reload",
        "3. Run: sudo systemctl enable telepy-tunnel.service",
        "4. Run: sudo systemctl start telepy-tunnel.service",
        "5. Check status: sudo systemctl status telepy-tunnel.service",
    ],
};

export function ServerScriptModal({ isOpen, onClose, tunnelId, sshPort: defaultSshPort }: ServerScriptModalProps) {
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
            setTargetSshPort("22");
        }
    }, [isOpen]);

    const langMap: Record<string, string> = {
        ssh: "bash",
        autossh: "bash",
        "docker-run": "bash",
        powershell: "powershell",
        "autossh-service": "ini",
        "docker-compose": "yaml",
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Target Server Connection Script" size="xl" isLoading={loading}>
            <div className="flex flex-col flex-1 min-h-0 gap-4">
                {/* Direction Banner */}
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
                    <span className="mt-0.5 shrink-0 text-lg">⚠️</span>
                    <span>Run the script below <strong>on your target server</strong> to connect it back to the Telepy SSH server. This establishes the reverse tunnel that allows you to access your server from here.</span>
                </div>
                {/* Options Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">Target Server SSH Port</Label>
                        <Input
                            type="number"
                            min={1}
                            max={65535}
                            value={targetSshPort}
                            onChange={(e) => setTargetSshPort(e.target.value)}
                            placeholder="22"
                        />
                        <p className="text-xs text-muted-foreground">
                            The SSH port on your target server (default: <code className="bg-muted px-1 rounded">22</code>).
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">Optional Key Path</Label>
                        <Input
                            type="text"
                            value={keyPath}
                            onChange={(e) => setKeyPath(e.target.value)}
                            placeholder="e.g. ~/.ssh/id_rsa"
                        />
                        <p className="text-xs text-muted-foreground">
                            Leave empty for default <code className="bg-muted px-1 rounded">~/.ssh/id_rsa</code>. Auto-updates on change.
                        </p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="border-b border-border">
                    <nav className="-mb-px flex space-x-1 overflow-x-auto pb-1" aria-label="Tabs">
                        {TABS.map((tab) => {
                            const Icon = tab.icon;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={cn(
                                        activeTab === tab.id
                                            ? "border-primary text-primary bg-primary/5"
                                            : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                                        "whitespace-nowrap py-2 px-3 border-b-2 font-medium text-sm transition-colors flex items-center gap-1.5 rounded-t-md"
                                    )}
                                >
                                    <Icon size={14} />
                                    {tab.label}
                                </button>
                            );
                        })}
                    </nav>
                </div>

                {/* Content */}
                <div className="flex-1 min-h-[200px] overflow-auto flex flex-col min-h-0">
                    {loading ? null : (
                        <>
                            {TAB_DESCRIPTIONS[activeTab] && (
                                <p className="text-sm text-muted-foreground mb-3">
                                    {TAB_DESCRIPTIONS[activeTab]}
                                </p>
                            )}
                            {TAB_TUTORIALS[activeTab] && (
                                <>
                                    <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 flex items-start gap-2 text-xs text-blue-800 dark:text-blue-200 mb-3">
                                        <Info size={14} className="mt-0.5 shrink-0" />
                                        <span>You can replace the <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">User</code> field with your own username in the command.</span>
                                    </div>
                                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 mb-3">
                                        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200 mb-2">How to set up:</p>
                                        <ol className="text-xs text-amber-700 dark:text-amber-300 space-y-1 list-none">
                                            {TAB_TUTORIALS[activeTab].map((step, i) => (
                                                <li key={i} className="font-mono">{step}</li>
                                            ))}
                                        </ol>
                                    </div>
                                </>
                            )}
                            <div className="flex-1 min-h-0 max-h-full overflow-auto">
                                <CodeBlock language={langMap[activeTab] || "txt"} value={scriptContent} />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
}
