"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, Monitor, RefreshCw, Cog, Container, FileCode, Link2, Loader2 } from "lucide-react";

import { TunnelModalProps } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

interface ServerScriptModalProps extends TunnelModalProps {
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

const TAB_DESCRIPTIONS: Record<string, TranslationKey> = {
    ssh: "scripts.descSsh",
    powershell: "scripts.descPowershell",
    autossh: "scripts.descAutossh",
    "autossh-service": "scripts.descAutosshService",
    "docker-run": "scripts.descDockerRun",
    "docker-compose": "scripts.descDockerCompose",
};

const TAB_CURL_HELPERS: Record<string, TranslationKey> = {
    ssh: "scripts.curlSsh",
    powershell: "scripts.curlPowershell",
    autossh: "scripts.curlAutossh",
    "autossh-service": "scripts.curlAutosshService",
    "docker-run": "scripts.curlDockerRun",
    "docker-compose": "scripts.curlDockerCompose",
};

import { useServerScriptModal } from "@/hooks/useServerScriptModal";

export function ServerScriptModal({ isOpen, onClose, tunnelId, sshPort: defaultSshPort }: ServerScriptModalProps) {
    const { t, tn } = useI18n();
    const { state } = useServerScriptModal(tunnelId, defaultSshPort, isOpen);
    const {
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
    } = state;

    const langMap: Record<string, string> = {
        ssh: "bash",
        autossh: "bash",
        "docker-run": "bash",
        powershell: "powershell",
        "autossh-service": "bash",
        "docker-compose": "yaml",
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("scripts.title")} size="xl" isLoading={isInitialLoading}>
            <div className="flex flex-col flex-1 min-h-0 gap-4">
                {/* Direction Banner */}
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
                    <span className="mt-0.5 shrink-0 text-lg">⚠️</span>
                    <span>{tn("scripts.banner", { onTargetServer: <strong>{t("scripts.bannerOnTarget")}</strong> })}</span>
                </div>
                {/* Options Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">{t("scripts.targetPort")}</Label>
                        <Input
                            type="number"
                            min={1}
                            max={65535}
                            value={targetSshPort}
                            onChange={(e) => setTargetSshPort(e.target.value)}
                            placeholder="22"
                        />
                        <p className="text-xs text-muted-foreground">
                            {tn("scripts.targetPortHelper", { port: <code className="bg-muted px-1 rounded">22</code> })}
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">{t("scripts.keyPath")}</Label>
                        <Input
                            type="text"
                            value={keyPath}
                            onChange={(e) => setKeyPath(e.target.value)}
                            placeholder={t("scripts.keyPathPlaceholder")}
                        />
                        <p className="text-xs text-muted-foreground">
                            {tn("scripts.keyPathHelper", { path: <code className="bg-muted px-1 rounded">~/.ssh/id_rsa</code> })}
                        </p>
                    </div>
                </div>

                {/* Username selector for autossh-service */}
                {activeTab === "autossh-service" && (
                    <div className="space-y-1.5">
                        {usernames.length > 0 ? (
                            <>
                                <Label className="text-sm font-medium">{t("scripts.targetUsername")}</Label>
                                <select
                                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={selectedUsernameId ?? ""}
                                    onChange={(e) => setSelectedUsernameId(Number(e.target.value))}
                                >
                                    {usernames.map((u) => (
                                        <option key={u.id} value={u.id}>
                                            {u.username}{u.created_by ? ` ${t("common.byUser", { user: u.created_by })}` : ""}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-muted-foreground">
                                    {t("scripts.usernameHelper")}
                                </p>
                            </>
                        ) : (
                            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
                                <span className="mt-0.5 shrink-0 text-lg">⚠️</span>
                                <span>{tn("scripts.noUsernames", { targetServerUsername: <strong>{t("scripts.noUsernamesHighlight")}</strong> })}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Tabs */}
                <div className="border-b border-border">
                    <nav className="-mb-px flex space-x-1 overflow-x-auto pb-1" aria-label={t("scripts.tabsAria")}>
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
                <div className="flex-1 min-h-[200px] overflow-auto flex flex-col min-h-0 relative">
                    {isInitialLoading ? null : (
                        <>
                            {TAB_DESCRIPTIONS[activeTab] && (
                                <p className="text-sm text-muted-foreground mb-3">
                                    {t(TAB_DESCRIPTIONS[activeTab])}
                                </p>
                            )}
                            <div className="flex-1 min-h-0 max-h-full overflow-auto relative">
                                <CodeBlock language={langMap[activeTab] || "txt"} value={scriptContent} />
                                {isFetchingScript && (
                                    <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px] flex items-center justify-center rounded-md z-10 transition-all duration-200">
                                        <Loader2 className="w-6 h-6 animate-spin text-primary opacity-70" />
                                    </div>
                                )}
                            </div>

                            {/* One-time curl URL section */}
                            <div className="mt-4 pt-4 border-t border-border space-y-3">
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={generateOneTimeUrl}
                                            disabled={generatingCurl || !scriptContent || isFetchingScript}
                                            className={cn(
                                                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                                "bg-primary text-primary-foreground hover:bg-primary/90",
                                                "disabled:opacity-50 disabled:cursor-not-allowed"
                                            )}
                                        >
                                            {generatingCurl ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Link2 size={14} />
                                            )}
                                            {t("scripts.generateUrl")}
                                        </button>
                                        <span className="text-xs text-muted-foreground">
                                            {t("scripts.generateUrlHelper")}
                                        </span>
                                    </div>
                                    {curlCommand && (
                                        <div className="space-y-1.5 mt-1">
                                            <CodeBlock language="bash" value={curlCommand} />
                                            {TAB_CURL_HELPERS[activeTab] && (
                                                <p className="text-xs text-muted-foreground ml-1">
                                                    ℹ️ {t(TAB_CURL_HELPERS[activeTab])}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
}
