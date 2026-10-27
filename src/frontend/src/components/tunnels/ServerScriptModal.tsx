"use client";

/**
 * 目標主機連線腳本:六種腳本(ssh / PowerShell / autossh / systemd / docker run / compose)+ 一次性 curl 網址。
 * 六種腳本是左側分頁(Modal 的 `nav`,每種附一行說明;不跟著內容捲,手機上是內容上方的一列)。
 * Target-host connection script dialog: six script kinds plus a one-time curl URL. The kinds are side tabs (Modal's
 * `nav`, a one-line hint each; never scrolled with the body, a row above it on phones).
 */
import React from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Terminal, Monitor, RefreshCw, Cog, Container, FileCode, Link2, Loader2, Rocket, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { NavTabs } from "@/components/ui/nav-tabs";

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

/** 左側每種腳本下面的一行（短的；長的說明在內容上方）。/ The one-liner under each kind in the rail. */
const TAB_HINTS: Record<string, TranslationKey> = {
    ssh: "scripts.short.ssh",
    powershell: "scripts.short.powershell",
    autossh: "scripts.short.autossh",
    "autossh-service": "scripts.short.autosshService",
    "docker-run": "scripts.short.dockerRun",
    "docker-compose": "scripts.short.dockerCompose",
};

const TAB_CURL_HELPERS: Record<string, TranslationKey> = {
    ssh: "scripts.curlSsh",
    powershell: "scripts.curlPowershell",
    autossh: "scripts.curlAutossh",
    "autossh-service": "scripts.curlAutosshService",
    "docker-run": "scripts.curlDockerRun",
    "docker-compose": "scripts.curlDockerCompose",
};

const LANG: Record<string, string> = {
    ssh: "bash",
    autossh: "bash",
    "docker-run": "bash",
    powershell: "powershell",
    "autossh-service": "bash",
    "docker-compose": "yaml",
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

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("scripts.title")}
            description={tn("scripts.banner", { onTargetServer: <strong>{t("scripts.bannerOnTarget")}</strong> })}
            icon={<Rocket />}
            size="4xl"
            fixedHeight
            isLoading={isInitialLoading}
            nav={
                <NavTabs
                    aria-label={t("scripts.tabsAria")}
                    value={activeTab}
                    onChange={setActiveTab}
                    tabs={TABS.map((tab) => ({ value: tab.id, label: tab.label, icon: <tab.icon />, hint: t(TAB_HINTS[tab.id]) }))}
                />
            }
        >
            <div className="space-y-5">
                {/* 共用選項 / Options shared by every script */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                        id="script-target-port"
                        label={t("scripts.targetPort")}
                        hint={tn("scripts.targetPortHelper", { port: <code className="rounded bg-muted px-1 font-mono">22</code> })}
                    >
                        <Input type="number" min={1} max={65535} value={targetSshPort} onChange={(e) => setTargetSshPort(e.target.value)} placeholder="22" className="font-mono" />
                    </Field>
                    <Field
                        id="script-key-path"
                        label={t("scripts.keyPath")}
                        hint={tn("scripts.keyPathHelper", { path: <code className="rounded bg-muted px-1 font-mono">~/.ssh/id_rsa</code> })}
                    >
                        <Input type="text" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder={t("scripts.keyPathPlaceholder")} className="font-mono" />
                    </Field>
                </div>

                {/* systemd 服務要用哪個帳號 / Account the systemd service runs as */}
                {activeTab === "autossh-service" && (
                    usernames.length > 0 ? (
                        <Field id="script-username" label={t("scripts.targetUsername")} hint={t("scripts.usernameHelper")}>
                            <NativeSelect value={selectedUsernameId ?? ""} onChange={(e) => setSelectedUsernameId(Number(e.target.value))}>
                                {usernames.map((u) => (
                                    <option key={u.id} value={u.id}>
                                        {u.username}{u.created_by ? ` ${t("common.byUser", { user: u.created_by })}` : ""}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                    ) : (
                        <Callout tone="warning">
                            {tn("scripts.noUsernames", { targetServerUsername: <strong>{t("scripts.noUsernamesHighlight")}</strong> })}
                        </Callout>
                    )
                )}

                {/* 腳本 / The script */}
                {!isInitialLoading && (
                    <section className="space-y-2.5">
                        {TAB_DESCRIPTIONS[activeTab] && (
                            <p className="text-sm text-muted-foreground">{t(TAB_DESCRIPTIONS[activeTab])}</p>
                        )}
                        <div className="relative">
                            <CodeBlock language={LANG[activeTab] || "txt"} value={scriptContent} />
                            {isFetchingScript && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/60 transition-all duration-200">
                                    <Loader2 className="size-6 animate-spin text-primary opacity-70" />
                                </div>
                            )}
                        </div>
                    </section>
                )}

                {/* 一次性 curl 網址 / One-time curl URL */}
                {!isInitialLoading && (
                    <section className="space-y-3 rounded-xl bg-surface p-4 ring-1 ring-inset ring-border/80">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Button size="sm" variant="soft" onClick={generateOneTimeUrl} disabled={generatingCurl || !scriptContent || isFetchingScript}>
                                {generatingCurl ? <Loader2 className="animate-spin" /> : <Link2 />}
                                {t("scripts.generateUrl")}
                            </Button>
                            <span className="text-sm text-muted-foreground">{t("scripts.generateUrlHelper")}</span>
                        </div>
                        {curlCommand && (
                            <div className="space-y-2">
                                <CodeBlock language="bash" value={curlCommand} />
                                {TAB_CURL_HELPERS[activeTab] && (
                                    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                                        <Info size={15} className="mt-0.5 shrink-0 text-info" aria-hidden />
                                        {t(TAB_CURL_HELPERS[activeTab])}
                                    </p>
                                )}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </Modal>
    );
}
