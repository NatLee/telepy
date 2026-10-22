"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, Monitor, RefreshCw, Cog, Container, FileCode, Link2, Loader2, Rocket, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";

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
        <Modal isOpen={isOpen} onClose={onClose} title={t("scripts.title")} icon={<Rocket />} size="4xl" isLoading={isInitialLoading}>
            <div className="flex flex-col flex-1 min-h-0 gap-5">
                {/* Direction Banner */}
                <Callout tone="warning">
                    {tn("scripts.banner", { onTargetServer: <strong>{t("scripts.bannerOnTarget")}</strong> })}
                </Callout>
                {/* Options Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>{t("scripts.targetPort")}</Label>
                        <Input
                            type="number"
                            min={1}
                            max={65535}
                            value={targetSshPort}
                            onChange={(e) => setTargetSshPort(e.target.value)}
                            placeholder="22"
                        />
                        <p className="text-xs text-muted-foreground">
                            {tn("scripts.targetPortHelper", { port: <code className="rounded bg-muted px-1 font-mono">22</code> })}
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label>{t("scripts.keyPath")}</Label>
                        <Input
                            type="text"
                            value={keyPath}
                            onChange={(e) => setKeyPath(e.target.value)}
                            placeholder={t("scripts.keyPathPlaceholder")}
                        />
                        <p className="text-xs text-muted-foreground">
                            {tn("scripts.keyPathHelper", { path: <code className="rounded bg-muted px-1 font-mono">~/.ssh/id_rsa</code> })}
                        </p>
                    </div>
                </div>

                {/* Username selector for autossh-service */}
                {activeTab === "autossh-service" && (
                    <div className="space-y-2">
                        {usernames.length > 0 ? (
                            <>
                                <Label>{t("scripts.targetUsername")}</Label>
                                <select
                                    className="flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 dark:bg-input/30"
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
                            <Callout tone="warning">
                                {tn("scripts.noUsernames", { targetServerUsername: <strong>{t("scripts.noUsernamesHighlight")}</strong> })}
                            </Callout>
                        )}
                    </div>
                )}

                {/* Tabs:分段膠囊,手機上橫向捲動。/ Segmented pill tabs; scroll sideways on phones. */}
                <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
                    <Segmented
                        kind="tabs"
                        aria-label={t("scripts.tabsAria")}
                        value={activeTab}
                        onChange={setActiveTab}
                        options={TABS.map((tab) => ({ value: tab.id, label: tab.label, icon: <tab.icon size={14} /> }))}
                    />
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
                                    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/50 backdrop-blur-[1px] transition-all duration-200">
                                        <Loader2 className="w-6 h-6 animate-spin text-primary opacity-70" />
                                    </div>
                                )}
                            </div>

                            {/* One-time curl URL section */}
                            <div className="mt-5 rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-border/80 space-y-3">
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                        <Button
                                            size="sm"
                                            variant="soft"
                                            onClick={generateOneTimeUrl}
                                            disabled={generatingCurl || !scriptContent || isFetchingScript}
                                        >
                                            {generatingCurl ? <Loader2 className="animate-spin" /> : <Link2 />}
                                            {t("scripts.generateUrl")}
                                        </Button>
                                        <span className="text-xs text-muted-foreground">
                                            {t("scripts.generateUrlHelper")}
                                        </span>
                                    </div>
                                    {curlCommand && (
                                        <div className="space-y-1.5 mt-1">
                                            <CodeBlock language="bash" value={curlCommand} />
                                            {TAB_CURL_HELPERS[activeTab] && (
                                                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                                                    <Info size={13} className="mt-px shrink-0 text-info" aria-hidden />
                                                    {t(TAB_CURL_HELPERS[activeTab])}
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
