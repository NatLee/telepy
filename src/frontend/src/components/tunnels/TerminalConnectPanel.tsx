"use client";

/**
 * 終端機頁的連線選擇器（沒帶 `serverId` 時顯示；側欄的「終端機」就進這裡）：一張路徑圖就是表單——
 * 你的瀏覽器 ─ Telepy ─ 裝置（選裝置、選帳號）─ shell（裝置自己，或它區網裡的主機 + 登入名）。
 * 每一站的選項放在那一站的節點裡，線上 / 離線與隧道延遲即時顯示；按「開啟終端機」導到帶 serverId 的終端機頁。
 * 「怎麼運作」打開同一條路徑的即時說明（階段 idle）。
 * The terminal page's connect picker (shown without `serverId`; the sidebar's Terminal entry lands here): the path
 * diagram is the form — browser ─ Telepy ─ device (pick device + account) ─ shell (the device itself, or a LAN
 * host plus a login). Each choice sits inside its node; online state and the tunnel RTT are live. "Open terminal"
 * navigates to the terminal page with serverId. The info button opens the same path's live explanation.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Info, Plus, Server, TerminalSquare, Waypoints } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { BrowserNode, DeviceNode, NodeField, TelepyNode } from "@/components/flow/ConnectNodes";
import { RequestAccessDialog } from "@/components/tunnels/AccessRequests";
import { TerminalInfoDialog } from "@/components/tunnels/TerminalInfoDialog";
import type { TerminalFlowContext } from "@/components/tunnels/TerminalFlow";
import { useTerminalConnect } from "@/hooks/useTerminalConnect";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { hasSsh, hostName } from "@/lib/lanConnect";

const CARD = "rounded-xl border border-border bg-card shadow-card";

export function TerminalConnectPage() {
    const { t } = useI18n();
    const { state, actions } = useTerminalConnect();
    const { tunnels, loading, failed, tunnel, host, online, rtt, account, login, loginOk, canOpen } = state;
    const [infoOpen, setInfoOpen] = useState(false);
    const [requestOpen, setRequestOpen] = useState(false);
    const noAccounts = !!tunnel && tunnel.usernames.length === 0;
    const target = host ? hostName(host) : tunnel ? t("connect.shellOnDevice", { device: tunnel.name }) : "—";

    const ctx: TerminalFlowContext = {
        phase: "idle",
        failure: null,
        deviceName: tunnel?.name ?? t("connect.device"),
        account,
        lanHost: host ? { name: hostName(host), address: host.address, port: host.ssh_port, login: login.trim() } : null,
        serverToDeviceMs: rtt,
    };

    return (
        <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 animate-fade-in-up sm:px-6 sm:py-8 lg:px-8">
            <PageHeader
                icon={<TerminalSquare />}
                title={t("connect.title")}
                description={t("connect.description")}
                actions={
                    <Button variant="outline" onClick={() => setInfoOpen(true)}>
                        <Info size={16} /> {t("connect.howItWorks")}
                    </Button>
                }
            />

            {loading ? (
                <div className={cn(CARD, "p-8 text-center text-sm text-muted-foreground")}>{t("common.loading")}</div>
            ) : failed ? (
                <Callout tone="danger">{t("connect.loadFailed")}</Callout>
            ) : tunnels.length === 0 ? (
                <Callout tone="tip">
                    {t("connect.noTunnels")}{" "}
                    <Link className="text-primary underline-offset-2 hover:underline" href="/tunnels/create"><Plus size={14} className="inline align-[-2px]" /> {t("desktop.addDevice")}</Link>
                </Callout>
            ) : (
                <form
                    className={cn(CARD, "space-y-5 p-4 sm:p-6")}
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (canOpen) actions.open();
                    }}
                >
                    <FlowPath>
                        <BrowserNode sub={t("connect.youSub")} />
                        <FlowLink label={t("flow.linkWeb")} state="ok" />
                        <TelepyNode sub={t("connect.telepySubTerminal")} />
                        <FlowLink
                            label={t("flow.linkTunnel")}
                            state={tunnel ? (online ? "ok" : "failed") : "waiting"}
                            note={online && typeof rtt === "number" ? `${Math.round(rtt)} ms` : undefined}
                        />
                        <DeviceNode
                            tunnels={tunnels}
                            tunnel={tunnel}
                            onTunnel={actions.setTunnel}
                            account={account}
                            onAccount={actions.setAccount}
                            online={online}
                            sub={host ? t("connect.deviceSubJump") : t("connect.deviceSubShell")}
                            accountHint={host ? t("connect.jumpAccountHint") : undefined}
                            idPrefix="term"
                        />
                        <FlowLink label={host ? t("connect.linkLan", { port: host.ssh_port }) : t("connect.linkShell")} state="waiting" />
                        <FlowNode
                            icon={host ? Server : TerminalSquare}
                            title={host ? hostName(host) : t("connect.shell")}
                            sub={host ? t("connect.targetSubLan", { address: host.address, port: host.ssh_port }) : t("connect.targetSubDevice")}
                            state="waiting"
                            stateText={t("connect.notYet")}
                            wide
                            control={
                                <div className="grid gap-2.5 sm:grid-cols-2 @3xl:grid-cols-1">
                                    <NodeField
                                        id="term-target"
                                        label={t("connect.target")}
                                        hint={tunnel && tunnel.hosts.length === 0 ? (
                                            <Link className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={`/tunnels/network?tunnel=${tunnel.id}`}>
                                                <Waypoints size={12} aria-hidden /> {t("connect.findLan")}
                                            </Link>
                                        ) : undefined}
                                    >
                                        <NativeSelect id="term-target" value={host ? String(host.id) : ""} onChange={(e) => actions.setHost(e.target.value ? Number(e.target.value) : null)} disabled={!tunnel}>
                                            <option value="">{t("connect.targetDevice")}</option>
                                            {tunnel?.hosts.map((h) => (
                                                <option key={h.id} value={h.id}>
                                                    {hostName(h)}{hostName(h) !== h.address ? ` (${h.address})` : ""}{hasSsh(h) ? " · SSH" : ""}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                    </NodeField>
                                    {host && (
                                        <NodeField id="term-login" label={t("connect.login")} hint={loginOk ? undefined : t("network.loginHint")}>
                                            <Input id="term-login" value={login} onChange={(e) => actions.setLogin(e.target.value)} placeholder="admin" autoComplete="off" autoCapitalize="off" spellCheck={false} className="font-mono" aria-invalid={!loginOk} />
                                        </NodeField>
                                    )}
                                </div>
                            }
                        />
                    </FlowPath>

                    {tunnel && !online && <Callout tone="warning">{t("connect.offline", { name: tunnel.name })}</Callout>}
                    {noAccounts && tunnel && (
                        <Callout tone="warning">
                            {t("connect.noAccounts", { name: tunnel.name })}{" "}
                            <button type="button" onClick={() => setRequestOpen(true)} className="text-primary underline-offset-2 hover:underline">{t("share.request.menu")}</button>
                        </Callout>
                    )}
                    {host && host.last_seen && !hasSsh(host) && <Callout tone="warning">{t("network.noSshSeen", { port: host.ssh_port })}</Callout>}

                    <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <button type="button" onClick={() => setInfoOpen(true)} className="flex min-w-0 items-start gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
                            <Info size={14} className="mt-px shrink-0" aria-hidden />
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                                {host
                                    ? t("connect.summaryLan", { device: tunnel?.name ?? "—", account: account || "?", target, login: login.trim() || "?" })
                                    : t("connect.summaryDevice", { device: tunnel?.name ?? "—", account: account || "?" })}
                            </span>
                        </button>
                        <Button type="submit" disabled={!canOpen} className="sm:min-w-40">
                            <TerminalSquare size={16} /> {t("connect.open")}
                        </Button>
                    </div>
                </form>
            )}

            <TerminalInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} ctx={ctx} />
            <RequestAccessDialog isOpen={requestOpen} onClose={() => setRequestOpen(false)} tunnelId={tunnel?.id ?? null} tunnelName={tunnel?.name} />
        </div>
    );
}
