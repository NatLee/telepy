"use client";

/**
 * 「反向伺服器設定」：讓 `ssh <別名>` 經 Telepy 連到這台裝置的 ~/.ssh/config。
 * 上方路線圖說明兩個區塊各管哪一段路；下面三步——加進 config（一行指令或手動貼上）→ 確認金鑰進得去（即時狀態，
 * 可一鍵把自己的金鑰加到裝置）→ 連線。帳號選擇放在固定的工具列。
 * The SSH config dialog: the ~/.ssh/config that lets `ssh <alias>` reach this device through Telepy. A route map
 * shows which leg each block covers; below it three steps — add it (one command or by hand) → check your key gets in
 * (live, with a one-click "add my keys") → connect. The account picker sits in the fixed toolbar.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, FileCode2, KeyRound, Loader2, UserRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { ConfigRouteMap, type ConfigPart } from "@/components/sshconfig/ConfigRouteMap";
import { SshConfigInstall } from "@/components/sshconfig/SshConfigInstall";
import { CheckRow, StepPanel, ToolbarField } from "@/components/sshconfig/ConfigSteps";
import { StepFooter, StepTabs, type StepTab } from "@/components/ui/step-tabs";
import { firstOpenStep, type StepState } from "@/lib/stepTabs";
import { allDone, configDoneKey, markKeys, readConfigDone, writeConfigDone, type ConfigDone } from "@/lib/configDone";
import { TransportInfoDialog } from "@/components/sshconfig/TransportInfoDialog";
import { AccountChips } from "@/components/sshconfig/AccountChips";
import { withoutPrefix } from "@/lib/aliasPrefix";
import { TunnelModalProps, type Tunnel } from "@/types/tunnel";
import type { TargetStatus } from "@/types/keys";
import { useConfigModal } from "@/hooks/useConfigModal";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ConfigModalProps = TunnelModalProps & {
    /** 通道頁清單裡的這條（看它的通道現在走哪種方式）。/ This tunnel from the list (how its tunnel came in). */
    tunnel?: Tunnel | null;
    /** 有就顯示「一次設定多台」。/ When given, offers "set up several devices at once". */
    onBulk?: () => void;
};
type AccessState = TargetStatus | "missing";
type ConfigStep = "add" | "access" | "connect";

export function ConfigModal({ isOpen, onClose, tunnelId, onBulk, tunnel }: ConfigModalProps) {
    const { t, tn } = useI18n();
    const {
        state: { data, loading, targetUsers, selectedIds, serverStanza, deviceStanzas, deviceKeys, transport },
        actions: { toggleUser, selectAllUsers, handleTransportChange, savePrefix }
    } = useConfigModal(isOpen, tunnelId);
    // SSH over WebSocket：筆電先存小程式，伺服器區塊的 ProxyCommand 用它。/ The carrier the server stanza's ProxyCommand runs.
    const wsClient = data?.transport === "websocket" && data.ws_client_url ? { url: data.ws_client_url, path: data.ws_client_path, wsUrl: data.ws_url } : null;
    const [active, setActive] = useState<ConfigPart | null>(null);
    const [transportInfo, setTransportInfo] = useState(false);
    // Telepy 的主機金鑰（伺服器區塊釘住它）。/ Telepy's host key, pinned by the server stanza.
    const knownHosts = data?.known_hosts ?? null;

    const keysData = deviceKeys.data;
    const online = keysData ? keysData.tunnel.online : null;
    const hosts = data?.hosts ?? [];
    const deviceName = keysData?.tunnel.host_friendly_name ?? hosts[0]?.alias ?? "";
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;

    // 我的金鑰在某個帳號上的狀態（和指令速查的設定清單同一套判斷）。/ My keys' state in one account.
    const accessOf = (username: string): AccessState => {
        const targets = (keysData?.entries ?? []).filter((e) => e.mine).flatMap((e) => e.targets.filter((tg) => tg.username === username));
        if (targets.some((tg) => tg.status === "installed")) return "installed";
        if (targets.some((tg) => tg.status === "pending")) return "pending";
        if (targets.some((tg) => tg.status === "error")) return "error";
        return "missing";
    };
    const keyCount = keysData?.my_keys.length ?? 0;
    const missingKeyIds = (keysData?.my_keys ?? []).filter((k) => !k.in_list).map((k) => k.id);
    const states = hosts.map((h) => accessOf(h.username));
    const accessDone = keysData !== null && keyCount > 0 && states.length > 0 && states.every((s) => s === "installed");
    const accessStatus = !keysData ? null
        : accessDone ? <Chip tone="success"><Check />{t("config.access.ready")}</Chip>
        : keyCount > 0 && states.some((s) => s === "pending") ? <Chip tone="warning">{t("config.access.installing")}</Chip>
        : <Chip tone="warning">{t("config.access.needed")}</Chip>;

    const accessChip = (s: AccessState, error: string | null) => {
        switch (s) {
            case "installed": return <Chip tone="success"><Check />{t("config.access.installed")}</Chip>;
            case "pending": return <Chip tone="warning">{online === false ? t("config.access.waitingOnline") : t("config.access.pending")}</Chip>;
            case "error": return <Chip tone="danger" className="h-auto max-w-full whitespace-normal [overflow-wrap:anywhere] sm:max-w-56 sm:truncate sm:whitespace-nowrap" title={error ?? ""}>{t("config.access.error", { error: error ?? "" })}</Chip>;
            default: return <Chip>{t("config.access.missing")}</Chip>;
        }
    };
    const errorOf = (username: string) =>
        (keysData?.entries ?? []).filter((e) => e.mine).flatMap((e) => e.targets).find((tg) => tg.username === username && tg.error)?.error ?? null;

    const firstAlias = hosts[0]?.alias;
    const caption = firstAlias
        ? tn("config.map.caption", { cmd: code(`ssh ${firstAlias}`) })
        : t("config.map.captionNoHost");
    const role = keysData?.tunnel.role;

    // 「我已經加好了」：每個帳號一筆，跟指令速查的清單共用。/ "I've added it", per account, shared with the command sheet.
    const [configDone, setConfigDone] = useState<ConfigDone>(readConfigDone);
    const doneKeys = tunnelId === null ? [] : hosts.map((h) => configDoneKey(tunnelId, h.username));
    const addDone = allDone(configDone, doneKeys);
    const markAdded = (done: boolean) => setConfigDone((prev) => {
        const next = markKeys(prev, doneKeys, done);
        writeConfigDone(next);
        return next;
    });
    const pendingCount = states.filter((s) => s === "pending").length;
    const readyCount = states.filter((s) => s === "installed").length;
    const accessState: StepState = !keysData ? "todo" : accessDone ? "done" : keyCount === 0 ? "attention" : pendingCount > 0 ? "working" : "attention";
    const connectState: StepState = addDone && accessDone && online ? "done" : online === false ? "attention" : "todo";
    const steps: StepTab<ConfigStep>[] = [
        { value: "add", label: t("config.step.add"), state: addDone ? "done" : "todo", status: addDone ? t("config.steps.addDone") : t("config.steps.addTodo") },
        {
            value: "access",
            label: t("config.step.access"),
            state: accessState,
            status: !keysData ? t("config.access.loading") : keyCount === 0 ? t("config.steps.noKey") : t("config.steps.accessCount", { ready: readyCount, count: hosts.length }),
        },
        {
            value: "connect",
            label: t("config.step.connect"),
            state: connectState,
            status: connectState === "done" ? t("config.steps.connectReady") : online === false ? t("config.state.offline") : t("config.steps.connectTodo"),
        },
    ];
    // 使用者點過就照他的；不然停在第一個沒做完的那步。/ The clicked step, else the first unfinished one.
    const [picked, setPicked] = useState<{ tunnel: number | null; step: ConfigStep } | null>(null);
    const current: ConfigStep = picked?.tunnel === tunnelId ? picked.step : (firstOpenStep(steps) ?? "add");
    const go = (step: ConfigStep) => setPicked({ tunnel: tunnelId, step });

    // 帳號與連到 Telepy 的方式：只影響要加進 config 的內容，所以放在第一步（不佔對話框固定的一列）。
    // Accounts and how to reach Telepy only change what goes into the config, so they live in the first step.
    const settings = (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    {targetUsers.length > 1 && (
                        <ToolbarField label={t("config.loginAs")}>
                            <AccountChips
                                accounts={targetUsers}
                                selected={new Set(selectedIds)}
                                onToggle={toggleUser}
                                onAll={selectAllUsers}
                                defaultId={data?.default_username_id}
                            />
                        </ToolbarField>
                    )}
                    <ToolbarField label={t("config.transportLabel")} info={{ label: t("config.ti.open"), onClick: () => setTransportInfo(true) }}>
                        <Segmented
                            size="sm"
                            fullWidth
                            aria-label={t("config.transportLabel")}
                            value={transport}
                            onChange={handleTransportChange}
                            options={[
                                { value: "ssh", label: t("config.transportSsh") },
                                { value: "websocket", label: t("config.transportWeb") },
                            ]}
                        />
                    </ToolbarField>
                </div>
    );
    const routeMap = (
        <div className="space-y-2.5">
            <ConfigRouteMap
                server={data?.server ? { host: data.server.host, port: String(data.server.port) } : null}
                hosts={hosts}
                deviceName={deviceName}
                reversePort={data?.reverse_port ?? null}
                online={online}
                active={active}
                onActive={setActive}
            />
            <p className="text-center text-sm leading-relaxed text-muted-foreground">{caption}</p>
        </div>
    );
    const installer = data && (
        <>
            <SshConfigInstall serverStanza={serverStanza} deviceStanzas={deviceStanzas} knownHosts={knownHosts} wsClient={wsClient} legacyAlias={data.server.legacy_alias} aliasPrefix={{ value: data.alias_prefix ?? "", example: withoutPrefix(hosts[0]?.alias, data.alias_prefix ?? ""), onSave: savePrefix }} active={active} onActive={setActive} />
            {onBulk && (
                <p className="text-xs text-muted-foreground">
                    {t("config.bulk.fromSingle")}{" "}
                    <button type="button" onClick={onBulk} className="text-primary underline-offset-4 hover:underline">
                        {t("config.bulk.fromSingleAction")}
                    </button>
                </p>
            )}
        </>
    );
    // 跑完指令後自己勾（Telepy 看不到筆電的 config）。/ Ticked by hand after running it (Telepy can't see the laptop's config).
    const addMark = addDone ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-success/10 px-3 py-2.5 text-success ring-1 ring-inset ring-success/30">
            <Check size={16} aria-hidden />
            <span className="min-w-0 flex-1 text-foreground">{t("config.steps.addDoneBody")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => markAdded(false)}>{t("sheet.setup.configUnmark")}</Button>
        </div>
    ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface px-3 py-2.5 ring-1 ring-inset ring-border/70">
            <span className="min-w-0 flex-1 text-muted-foreground">{t("config.steps.addAsk")}</span>
            <Button type="button" size="sm" onClick={() => { markAdded(true); go("access"); }}>
                <Check size={15} />
                {t("sheet.setup.configMark")}
            </Button>
        </div>
    );

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("config.title")}
            description={tn("config.subtitle", { cmd: code(firstAlias ? `ssh ${firstAlias}` : "ssh") })}
            icon={<FileCode2 />}
            size="5xl"
            isLoading={loading}
            nav={hosts.length > 0 ? <StepTabs aria-label={t("ui.steps.aria")} tabs={steps} value={current} onChange={go} /> : undefined}
            fixedHeight={hosts.length > 0}
            footer={hosts.length > 0 ? <StepFooter tabs={steps} value={current} onChange={go} final={<Button type="button" onClick={onClose}>{t("common.close")}</Button>} /> : undefined}
        >
            {data && (
                <div className="space-y-6">
                    {hosts.length === 0 ? (
                        <>
                            {settings}
                            {routeMap}
                            <Callout tone="warning">
                                {role === "owner" || role === "admin"
                                    ? t("config.noAccounts.owner", { action: t("tunnelActions.targetServerUsers") })
                                    : t("config.noAccounts.sharee")}
                            </Callout>
                            {installer}
                        </>
                    ) : (
                        <>
                            <StepPanel hidden={current !== "add"} title={t("config.step.add")} hint={t("config.step.addHint")}>
                                {settings}
                                {routeMap}
                                {installer}
                                {addMark}
                            </StepPanel>

                            <StepPanel hidden={current !== "access"} title={t("config.step.access")} status={accessStatus}>
                                {!keysData ? (
                                    <p className="flex items-center gap-2 text-muted-foreground">
                                        {deviceKeys.loading && <Loader2 size={14} className="animate-spin" aria-hidden />}
                                        {deviceKeys.loading ? t("config.access.loading") : tn("config.access.manual", { path: code("~/.ssh/authorized_keys") })}
                                    </p>
                                ) : (
                                    <>
                                        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                                            <CheckRow
                                                icon={<KeyRound />}
                                                right={keyCount > 0 ? (
                                                    <Check size={16} className="text-success" aria-label={t("config.access.ready")} />
                                                ) : (
                                                    <Button asChild size="sm">
                                                        <Link href="/tunnels/keys" prefetch={false}><KeyRound size={15} />{t("config.access.addKey")}</Link>
                                                    </Button>
                                                )}
                                            >
                                                {keyCount > 0 ? t("config.access.keys", { count: keyCount }) : t("config.access.noKeys")}
                                            </CheckRow>
                                            {keyCount > 0 && hosts.map((h, i) => (
                                                <CheckRow key={h.username_id} icon={<UserRound />} right={accessChip(states[i], errorOf(h.username))}>
                                                    {tn("config.access.onAccount", { user: <span className="font-mono">{h.username}</span> })}
                                                </CheckRow>
                                            ))}
                                        </ul>
                                        {keyCount > 0 && missingKeyIds.length > 0 && states.some((s) => s === "missing") && (
                                            <Button size="sm" onClick={() => deviceKeys.addAllMine(missingKeyIds)} disabled={deviceKeys.busy !== null}>
                                                {deviceKeys.busy === "all" ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                                                {t("config.access.addMine")}
                                            </Button>
                                        )}
                                        <p className="text-xs text-muted-foreground">
                                            {tn("config.access.manual", { path: code("~/.ssh/authorized_keys") })}{" "}
                                            <Link href={`/tunnels/keys/devices?device=${tunnelId}`} prefetch={false} className="text-primary underline-offset-4 hover:underline">
                                                {t("config.access.manage")}
                                            </Link>
                                        </p>
                                    </>
                                )}
                            </StepPanel>

                            <StepPanel
                                hidden={current !== "connect"}
                                title={t("config.step.connect")}
                                status={online === null ? null : (
                                    <span className={cn("inline-flex items-center gap-1.5 text-xs", online ? "text-success" : "text-muted-foreground")}>
                                        <span className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
                                        {online ? t("config.state.online") : t("config.state.offline")}
                                    </span>
                                )}
                            >
                                {connectState !== "done" && (
                                    <Callout tone={online === false ? "warning" : "info"}>
                                        {online === false ? t("config.connect.offline") : t("config.steps.connectFirst")}
                                    </Callout>
                                )}
                                <p className="text-muted-foreground">{t("config.connect.body")}</p>
                                <div className="space-y-2">
                                    {hosts.map((h) => <MiniCommand key={h.alias} command={`ssh ${h.alias}`} />)}
                                </div>
                                <Link
                                    href={`/tunnels/cheatsheet?tunnel=${tunnelId}`}
                                    prefetch={false}
                                    className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
                                >
                                    {t("config.connect.more")}
                                    <ArrowRight size={14} aria-hidden />
                                </Link>
                            </StepPanel>
                        </>
                    )}
                </div>
            )}
            <TransportInfoDialog
                isOpen={transportInfo}
                onClose={() => setTransportInfo(false)}
                choice={transport}
                onChoose={handleTransportChange}
                server={data?.server ? { host: data.server.host, port: String(data.server.port) } : null}
                wsUrl={data?.ws_url ?? null}
                devices={[{ online: online ?? tunnel?.endpoint?.live ?? null, transport: tunnel?.endpoint?.live ? tunnel.endpoint.transport : null }]}
                deviceName={deviceName}
            />
        </Modal>
    );
}
