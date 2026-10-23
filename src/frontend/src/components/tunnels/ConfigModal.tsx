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
import { NativeSelect } from "@/components/ui/native-select";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { ConfigRouteMap, type ConfigPart } from "@/components/sshconfig/ConfigRouteMap";
import { SshConfigInstall } from "@/components/sshconfig/SshConfigInstall";
import { TunnelModalProps, TargetUser } from "@/types/tunnel";
import type { TargetStatus } from "@/types/keys";
import { useConfigModal } from "@/hooks/useConfigModal";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ConfigModalProps = TunnelModalProps;
type AccessState = TargetStatus | "missing";

function AccountPicker({ users, value, onChange }: { users: TargetUser[]; value: string; onChange: (v: string) => void }) {
    const { t } = useI18n();
    const all = { value: "all", label: t("config.allAccounts", { count: users.length }) };
    return (
        <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-sm text-muted-foreground">{t("config.loginAs")}</span>
            {users.length <= 4 ? (
                <Segmented
                    size="sm"
                    aria-label={t("config.loginAs")}
                    value={value}
                    onChange={onChange}
                    options={[...users.map((u) => ({ value: String(u.id), label: <span className="font-mono">{u.username}</span>, title: u.username })), all]}
                />
            ) : (
                <NativeSelect className="w-56" aria-label={t("config.loginAs")} value={value} onChange={(e) => onChange(e.target.value)}>
                    {users.map((u) => (
                        <option key={u.id} value={String(u.id)}>{u.username}</option>
                    ))}
                    <option value="all">{all.label}</option>
                </NativeSelect>
            )}
        </div>
    );
}

function Step({ n, done = false, title, status, hint, last = false, children }: {
    n: number;
    done?: boolean;
    title: React.ReactNode;
    status?: React.ReactNode;
    hint?: React.ReactNode;
    last?: boolean;
    children: React.ReactNode;
}) {
    return (
        <li className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span
                className={cn(
                    "grid size-7 place-items-center rounded-full text-xs",
                    done ? "bg-success text-success-foreground" : "bg-muted text-foreground ring-1 ring-inset ring-border"
                )}
                aria-hidden
            >
                {done ? <Check size={15} strokeWidth={3} /> : n}
            </span>
            {!last && <span className="absolute bottom-1 left-[0.8125rem] top-9 w-px bg-border" aria-hidden />}
            <div className={cn("min-w-0", !last && "pb-7")}>
                <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h3 className="text-base text-foreground">{title}</h3>
                    {status}
                </div>
                {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
                <div className="mt-3 space-y-3 text-sm">{children}</div>
            </div>
        </li>
    );
}

/** 一列檢查項目：圖示 + 說明 + 右側狀態 / 動作。/ One check row: icon + text + status or action on the right. */
function CheckRow({ icon, children, right }: { icon: React.ReactNode; children: React.ReactNode; right: React.ReactNode }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <span className="shrink-0 text-muted-foreground [&>svg]:size-4" aria-hidden>{icon}</span>
            <span className="min-w-0 flex-1 text-foreground">{children}</span>
            <span className="shrink-0">{right}</span>
        </li>
    );
}

export function ConfigModal({ isOpen, onClose, tunnelId }: ConfigModalProps) {
    const { t, tn } = useI18n();
    const {
        state: { data, loading, targetUsers, selectedUserId, serverStanza, deviceStanzas, deviceKeys },
        actions: { handleUserChange }
    } = useConfigModal(isOpen, tunnelId);
    const [active, setActive] = useState<ConfigPart | null>(null);

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
            case "error": return <Chip tone="danger" className="max-w-56 truncate" title={error ?? ""}>{t("config.access.error", { error: error ?? "" })}</Chip>;
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

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("config.title")}
            description={tn("config.subtitle", { cmd: code(firstAlias ? `ssh ${firstAlias}` : "ssh") })}
            icon={<FileCode2 />}
            size="3xl"
            isLoading={loading}
            toolbar={targetUsers.length > 1 ? <AccountPicker users={targetUsers} value={selectedUserId} onChange={handleUserChange} /> : undefined}
        >
            {data && (
                <div className="space-y-6">
                    <div className="space-y-2.5">
                        <ConfigRouteMap
                            server={data.server ? { host: data.server.host, port: String(data.server.port) } : null}
                            hosts={hosts}
                            deviceName={deviceName}
                            reversePort={data.reverse_port ?? null}
                            online={online}
                            active={active}
                            onActive={setActive}
                        />
                        <p className="text-center text-sm leading-relaxed text-muted-foreground">{caption}</p>
                    </div>

                    {hosts.length === 0 && (
                        <Callout tone="warning">
                            {role === "owner" || role === "admin"
                                ? t("config.noAccounts.owner", { action: t("tunnelActions.targetServerUsers") })
                                : t("config.noAccounts.sharee")}
                        </Callout>
                    )}

                    <ol className="list-none">
                        <Step n={1} title={t("config.step.add")} hint={t("config.step.addHint")} last={hosts.length === 0}>
                            <SshConfigInstall serverStanza={serverStanza} deviceStanzas={deviceStanzas} active={active} onActive={setActive} />
                        </Step>

                        {hosts.length > 0 && (
                            <Step n={2} done={accessDone} title={t("config.step.access")} status={accessStatus}>
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
                                            <Link href={`/tunnels/keys?device=${tunnelId}`} prefetch={false} className="text-primary underline-offset-4 hover:underline">
                                                {t("config.access.manage")}
                                            </Link>
                                        </p>
                                    </>
                                )}
                            </Step>
                        )}

                        {hosts.length > 0 && (
                            <Step
                                n={3}
                                last
                                title={t("config.step.connect")}
                                status={online === null ? null : (
                                    <span className={cn("inline-flex items-center gap-1.5 text-xs", online ? "text-success" : "text-muted-foreground")}>
                                        <span className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
                                        {online ? t("config.state.online") : t("config.state.offline")}
                                    </span>
                                )}
                            >
                                <p className="text-muted-foreground">{t("config.connect.body")}</p>
                                <div className="space-y-2">
                                    {hosts.map((h) => <MiniCommand key={h.alias} command={`ssh ${h.alias}`} />)}
                                </div>
                                {online === false && <p className="text-xs text-muted-foreground">{t("config.connect.offline")}</p>}
                                <Link
                                    href={`/tunnels/cheatsheet?tunnel=${tunnelId}`}
                                    prefetch={false}
                                    className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
                                >
                                    {t("config.connect.more")}
                                    <ArrowRight size={14} aria-hidden />
                                </Link>
                            </Step>
                        )}
                    </ol>
                </div>
            )}
        </Modal>
    );
}
