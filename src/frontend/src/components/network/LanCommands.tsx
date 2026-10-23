"use client";

/**
 * 主機面板的「指令」分頁：就地給出這台區網主機能用的指令，不必跳到指令速查頁——登入（含每段說明）、
 * 把它開著的服務轉到你電腦上、經跳板複製檔案；可切換「免設定」與「用 ssh config」。
 * The host panel's Commands tab: the commands for this LAN host right here — log in (with a breakdown),
 * forward its services to your computer, copy files through the jump — with or without an ssh config.
 */
import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { AnnotatedCommand, CommandBar, InlineCommand } from "@/components/cheatsheet/CommandView";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import { isValidPort, type ConnectMode, type ConnectTarget } from "@/lib/forwardRecipes";
import { forwardUrl, lanAlias, lanCopySegments, lanForwardSegments, lanSshConfig, lanSshSegments, serviceName, suggestLocalPort } from "@/lib/lanConnect";
import type { LanHost } from "@/types/lan";

function ForwardRow({ target, host, port, mode }: { target: ConnectTarget; host: LanHost; port: number; mode: ConnectMode }) {
    const { t } = useI18n();
    const local = suggestLocalPort(port);
    const url = forwardUrl(port, local);
    const name = serviceName(port);
    return (
        <li className="space-y-1">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-foreground">{port}</span>
                {name && <span className="text-muted-foreground">{name}</span>}
                <span className="text-xs text-muted-foreground">→ {url ? t("network.cmd.forwardOpen", { url }) : t("network.cmd.forwardLocal", { port: local })}</span>
            </p>
            <InlineCommand segments={lanForwardSegments(target, host, port, local, mode)} />
        </li>
    );
}

export function LanCommands({ host, target, login }: { host: LanHost; target: ConnectTarget | null; login: string }) {
    const { t, tn } = useI18n();
    const [mode, setMode] = useState<ConnectMode>("direct");
    const [upload, setUpload] = useState(true);
    const [localPath, setLocalPath] = useState("./file");
    const [remotePath, setRemotePath] = useState("~/");
    const [otherPort, setOtherPort] = useState("");

    if (!target) return <Loader2 size={16} className="animate-spin text-muted-foreground" aria-label={t("common.loading")} />;

    const ports = host.open_ports.filter((p) => p !== host.ssh_port);
    const extra = isValidPort(otherPort.trim()) ? Number(otherPort.trim()) : null;
    const login1 = lanSshSegments(target, host, login, mode);

    return (
        <div className="space-y-5">
            <div className="space-y-1.5">
                <Segmented
                    options={[
                        { value: "direct" as const, label: t("network.cmd.modeDirect") },
                        { value: "alias" as const, label: t("network.cmd.modeAlias") },
                    ]}
                    value={mode}
                    onChange={setMode}
                    kind="toggle"
                    size="sm"
                />
                <p className="text-xs text-muted-foreground">
                    {mode === "direct"
                        ? t("network.oneLinerHint")
                        : tn("network.configHint", { alias: <code className="font-mono">{target.alias}</code> })}
                </p>
            </div>

            <Section title={t("network.cmd.loginTitle")}>
                <CommandBar segments={login1} />
                <details className="group mt-2">
                    <summary className="cursor-pointer text-xs text-primary hover:underline">{t("network.cmd.breakdown")}</summary>
                    <div className="mt-2"><AnnotatedCommand segments={login1} /></div>
                </details>
            </Section>

            <Section title={t("network.cmd.forwardTitle")} description={t("network.cmd.forwardHint")}>
                {ports.length > 0 && (
                    <ul className="space-y-3">
                        {ports.map((p) => <ForwardRow key={p} target={target} host={host} port={p} mode={mode} />)}
                    </ul>
                )}
                <div className="mt-3 space-y-2">
                    <Label htmlFor="lan-other-port" className="text-xs text-muted-foreground">
                        {ports.length ? t("network.cmd.otherPort") : t("network.cmd.noPorts")}
                    </Label>
                    <Input id="lan-other-port" inputMode="numeric" value={otherPort} onChange={(e) => setOtherPort(e.target.value)} placeholder="8080" className="h-8 w-32 font-mono" />
                    {extra && <ul><ForwardRow target={target} host={host} port={extra} mode={mode} /></ul>}
                </div>
            </Section>

            <Section title={t("network.cmd.copyTitle")}>
                <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
                    <Segmented
                        options={[
                            { value: "up" as const, label: t("sheet.field.upload") },
                            { value: "down" as const, label: t("sheet.field.download") },
                        ]}
                        value={upload ? "up" : "down"}
                        onChange={(v) => setUpload(v === "up")}
                        kind="toggle"
                        size="sm"
                    />
                    <div className="space-y-1">
                        <Label htmlFor="lan-copy-local" className="text-xs text-muted-foreground">{t("sheet.field.localPath")}</Label>
                        <Input id="lan-copy-local" value={localPath} onChange={(e) => setLocalPath(e.target.value)} className="h-8 font-mono" spellCheck={false} />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="lan-copy-remote" className="text-xs text-muted-foreground">{t("sheet.field.remotePath")}</Label>
                        <Input id="lan-copy-remote" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} className="h-8 font-mono" spellCheck={false} />
                    </div>
                </div>
                <div className="mt-3"><CommandBar segments={lanCopySegments(target, host, login, mode, upload, localPath, remotePath)} /></div>
            </Section>

            {mode === "alias" && (
                <Section title={t("network.configTitle")}>
                    <CodeBlock language="ssh" value={lanSshConfig(target.alias, host, login)} />
                    <p className="text-xs text-muted-foreground">
                        {tn("network.configThen", { command: <code className="font-mono">ssh {lanAlias(target.alias, host)}</code> })}
                    </p>
                </Section>
            )}
        </div>
    );
}
