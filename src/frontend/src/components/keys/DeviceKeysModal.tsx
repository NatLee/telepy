/**
 * 一台裝置的金鑰視窗。「金鑰清單」分頁：勾選自己的金鑰、看每把金鑰在每個帳號的狀態、（擁有者 / ADMIN）
 * 看所有人的與待移除的；「裝置上實際內容」分頁（擁有者 / ADMIN）：即時讀每個帳號的 authorized_keys，逐行標出
 * 來源，移除清單外的金鑰。
 * One device's key panel. "Key list": tick your keys, per-account state, (owner / ADMIN) everyone's entries
 * and pending removals. "On the device" (owner / ADMIN): live authorized_keys of every account, each line
 * labelled by origin, with removal of keys that are not on the list.
 */
import React, { useState } from "react";
import Link from "next/link";
import { FileSearch, HardDrive, KeyRound, Loader2, Plus, RefreshCw, Trash2, WifiOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { shortFingerprint } from "@/lib/sshKeys";
import type { TranslationKey } from "@/locales/en";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import type { AuditKind, AuditLine } from "@/types/keys";
import { OnlineDot, RoleBadge } from "./DeviceMatrix";
import { TargetChips } from "./TargetChips";

const KIND: Record<AuditKind, { label: TranslationKey; className: string }> = {
    service: { label: "keys.audit.kind.service", className: "bg-info/10 text-info ring-info/25" },
    managed: { label: "keys.audit.kind.managed", className: "bg-success/10 text-success ring-success/25" },
    telepy_user: { label: "keys.audit.kind.telepyUser", className: "bg-warning/10 text-warning ring-warning/30" },
    unknown: { label: "keys.audit.kind.unknown", className: "bg-muted text-muted-foreground ring-border" },
    invalid: { label: "keys.audit.kind.invalid", className: "bg-destructive/8 text-destructive ring-destructive/25" },
};

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <div className="mb-2">
            <h3 className="text-sm text-foreground">{children}</h3>
            {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function DeviceKeysModal({ tunnelId, onClose, onChanged }: { tunnelId: number | null; onClose: () => void; onChanged: () => void }) {
    const { t } = useI18n();
    const dk = useDeviceKeys(tunnelId, onChanged);
    const [tab, setTab] = useState<"list" | "audit">("list");
    const [confirm, setConfirm] = useState<{ username: string; line: AuditLine } | null>(null);
    const d = dk.data;

    const close = () => {
        setTab("list");
        onClose();
    };

    const openAudit = (v: "list" | "audit") => {
        setTab(v);
        if (v === "audit" && d?.tunnel.online && !dk.audit && !dk.auditLoading) dk.loadAudit();
    };

    return (
        <Modal
            isOpen={tunnelId !== null}
            onClose={close}
            title={d ? t("keys.device.title", { device: d.tunnel.host_friendly_name }) : t("keys.device.titleLoading")}
            description={
                d ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                        <RoleBadge role={d.tunnel.role} />
                        <OnlineDot online={d.tunnel.online} />
                    </span>
                ) : undefined
            }
            icon={<HardDrive />}
            size="3xl"
            isLoading={dk.loading}
            footer={
                <>
                    <Button variant="outline" onClick={close}>{t("common.close")}</Button>
                    {d && (
                        <Button onClick={() => dk.sync()} disabled={dk.busy === "sync" || !d.tunnel.online}>
                            <RefreshCw className={cn(dk.busy === "sync" && "animate-spin")} /> {t("keys.matrix.syncNow")}
                        </Button>
                    )}
                </>
            }
        >
            {dk.notFound && <Callout tone="danger">{t("keys.device.notFound")}</Callout>}
            {d && (
                <div className="space-y-5">
                    {d.can_manage && (
                        <Segmented
                            kind="tabs"
                            fullWidth
                            value={tab}
                            onChange={openAudit}
                            aria-label={t("keys.device.tabsAria")}
                            options={[
                                { value: "list", label: t("keys.device.tabList"), icon: <KeyRound size={15} /> },
                                { value: "audit", label: t("keys.device.tabAudit"), icon: <FileSearch size={15} /> },
                            ]}
                        />
                    )}
                    {!d.tunnel.online && tab === "list" && (
                        <Callout tone="warning" icon={<WifiOff size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />}>
                            {t("keys.device.offline")}
                        </Callout>
                    )}

                    {tab === "list" ? (
                        <>
                            {/* 我的金鑰 / My keys */}
                            <section>
                                <SectionTitle
                                    hint={
                                        d.accounts.length > 0
                                            ? t("keys.device.myKeysHint", { accounts: d.accounts.join(", ") })
                                            : d.can_manage
                                              ? t("keys.matrix.noAccountsOwner")
                                              : t("keys.matrix.noAccountsSharee")
                                    }
                                >
                                    {t("keys.device.myKeys")}
                                </SectionTitle>
                                {d.my_keys.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">
                                        {t("keys.device.noMyKeys")}{" "}
                                        <Link href="/tunnels/keys" onClick={close} className="text-primary hover:underline">{t("keys.addKey")}</Link>
                                    </p>
                                ) : (
                                    <div className="grid gap-1.5 sm:grid-cols-2">
                                        {d.my_keys.map((k) => {
                                            const busy = dk.busy === `key:${k.id}`;
                                            return (
                                                <label
                                                    key={k.id}
                                                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30"
                                                >
                                                    {busy ? (
                                                        <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                                                    ) : (
                                                        <input type="checkbox" checked={k.in_list} onChange={(e) => dk.toggleMine(k.id, e.target.checked)} className="size-4 accent-primary" />
                                                    )}
                                                    <span className="min-w-0">
                                                        <span className="block truncate text-sm text-foreground">{k.name}</span>
                                                        <span className="block truncate font-mono text-[11px] text-muted-foreground" title={k.fingerprint ?? ""}>
                                                            {k.key_type ?? "?"} · {shortFingerprint(k.fingerprint)}
                                                        </span>
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                                {d.my_keys.some((k) => !k.in_list) && d.my_keys.length > 1 && (
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        className="mt-2 text-primary hover:text-primary"
                                        disabled={dk.busy === "all"}
                                        onClick={() => dk.addAllMine(d.my_keys.filter((k) => !k.in_list).map((k) => k.id))}
                                    >
                                        <Plus /> {t("keys.device.addAllMine")}
                                    </Button>
                                )}
                            </section>

                            {/* 清單 / The list */}
                            <section>
                                <SectionTitle hint={d.can_manage ? t("keys.device.listHintManager") : t("keys.device.listHintSharee")}>
                                    {d.can_manage ? t("keys.device.everyone") : t("keys.device.status")}
                                </SectionTitle>
                                {d.entries.length === 0 ? (
                                    <p className="rounded-lg bg-surface px-3 py-4 text-center text-sm text-muted-foreground ring-1 ring-border">{t("keys.device.emptyList")}</p>
                                ) : (
                                    <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-border">
                                        {d.entries.map((e) => (
                                            <li key={e.user_key_id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                                                <div className="min-w-0 space-y-1">
                                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                                        <span className="truncate text-sm text-foreground">{e.name}</span>
                                                        <span className={cn("rounded-full px-1.5 py-px text-[10px] ring-1 ring-inset", e.mine ? "bg-primary/8 text-primary ring-primary/25" : "bg-brand-2/10 text-brand-2 ring-brand-2/30")}>
                                                            {e.mine ? t("keys.device.you") : e.owner.username}
                                                        </span>
                                                        <span className="font-mono text-[11px] text-muted-foreground" title={e.fingerprint ?? ""}>{shortFingerprint(e.fingerprint)}</span>
                                                    </div>
                                                    <TargetChips targets={e.targets} online={d.tunnel.online} />
                                                </div>
                                                {(e.mine || d.can_manage) && (
                                                    <Button
                                                        variant="ghost"
                                                        size="xs"
                                                        className="self-start text-destructive hover:bg-destructive/8 hover:text-destructive sm:self-center"
                                                        disabled={dk.busy === `entry:${e.user_key_id}`}
                                                        onClick={() => dk.removeEntry(e.user_key_id)}
                                                    >
                                                        <Trash2 /> {t("keys.device.removeFromList")}
                                                    </Button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            {d.can_manage && d.removals.length > 0 && (
                                <section>
                                    <SectionTitle hint={t("keys.device.removalsHint")}>{t("keys.device.removals")}</SectionTitle>
                                    <ul className="space-y-1.5">
                                        {d.removals.map((r) => (
                                            <li key={`${r.username}:${r.fingerprint}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/6 px-3 py-2 text-xs ring-1 ring-warning/25">
                                                <Trash2 size={13} className="text-warning" aria-hidden />
                                                <span className="font-mono">{r.username}</span>
                                                <span className="text-muted-foreground">{r.owner ?? t("keys.device.deletedKey")}</span>
                                                <span className="font-mono text-muted-foreground" title={r.fingerprint}>{shortFingerprint(r.fingerprint)}</span>
                                                {r.status === "error" && <span className="text-destructive" title={r.error ?? ""}>{t("keys.status.error")}</span>}
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                        </>
                    ) : d.tunnel.online ? (
                        <AuditTab dk={dk} onRemove={(username, line) => setConfirm({ username, line })} />
                    ) : (
                        <Callout tone="warning" icon={<WifiOff size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />}>
                            {t("keys.audit.offline")}
                        </Callout>
                    )}
                </div>
            )}
            <ConfirmDialog
                isOpen={!!confirm}
                onClose={() => setConfirm(null)}
                onConfirm={async () => {
                    if (confirm?.line.fingerprint) await dk.removeLine(confirm.username, confirm.line.fingerprint);
                    setConfirm(null);
                }}
                title={t("keys.audit.removeTitle")}
                message={t("keys.audit.removeMessage", {
                    key: confirm?.line.comment || shortFingerprint(confirm?.line.fingerprint),
                    account: confirm?.username ?? "",
                })}
                confirmText={t("keys.audit.remove")}
                isDestructive
            />
        </Modal>
    );
}

function AuditTab({ dk, onRemove }: { dk: ReturnType<typeof useDeviceKeys>; onRemove: (username: string, line: AuditLine) => void }) {
    const { t } = useI18n();
    if (dk.auditLoading) {
        return (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" /> {t("keys.audit.reading")}
            </div>
        );
    }
    if (dk.auditError) {
        return <Callout tone={dk.auditError === "offline" ? "warning" : "danger"}>{dk.auditError === "offline" ? t("keys.err.deviceOffline") : dk.auditError}</Callout>;
    }
    if (!dk.audit) return null;
    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">{t("keys.audit.intro")}</p>
                <Button variant="outline" size="xs" onClick={() => dk.loadAudit()}>
                    <RefreshCw /> {t("keys.audit.reload")}
                </Button>
            </div>
            {dk.audit.accounts.length === 0 && <p className="text-sm text-muted-foreground">{t("keys.audit.noAccounts")}</p>}
            {dk.audit.accounts.map((a) => (
                <section key={a.username} className="rounded-xl ring-1 ring-border">
                    <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/70 bg-surface px-3 py-2">
                        <span className="font-mono text-sm text-foreground">
                            {a.username} <span className="text-xs text-muted-foreground">~/.ssh/authorized_keys</span>
                        </span>
                        {a.ok && <span className="text-[11px] text-muted-foreground">{t("keys.audit.lineCount", { count: a.lines.length })}</span>}
                    </header>
                    <div className="p-3">
                        {!a.ok ? (
                            <Callout tone="danger">{t("keys.audit.accountError", { error: a.error ?? "" })}</Callout>
                        ) : !a.exists ? (
                            <p className="text-sm text-muted-foreground">{t("keys.audit.noFile")}</p>
                        ) : a.lines.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("keys.audit.emptyFile")}</p>
                        ) : (
                            <ul className="space-y-2">
                                {a.lines.map((l) => {
                                    const kind = KIND[l.kind];
                                    const removable = (l.kind === "unknown" || l.kind === "telepy_user") && !!l.fingerprint;
                                    return (
                                        <li key={l.line_no} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="min-w-0 space-y-1">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <span className={cn("rounded-full px-2 py-px text-[11px] ring-1 ring-inset", kind.className)}>
                                                        {t(kind.label)}
                                                        {l.owner ? ` · ${l.owner}` : ""}
                                                    </span>
                                                    {l.key_type && <span className="font-mono text-[11px] text-muted-foreground">{l.key_type}{l.bits ? ` · ${l.bits}` : ""}</span>}
                                                    {l.comment && <span className="truncate font-mono text-[11px] text-foreground/80">{l.comment}</span>}
                                                </div>
                                                <div className="truncate font-mono text-[11px] text-muted-foreground" title={l.fingerprint ?? l.raw ?? ""}>
                                                    {l.fingerprint ?? l.raw}
                                                </div>
                                                {l.options && <div className="truncate font-mono text-[11px] text-warning" title={l.options}>{t("keys.audit.options", { options: l.options })}</div>}
                                            </div>
                                            {removable && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="self-start text-destructive hover:bg-destructive/8 hover:text-destructive"
                                                    disabled={dk.busy === `line:${a.username}:${l.fingerprint}`}
                                                    onClick={() => onRemove(a.username, l)}
                                                >
                                                    <Trash2 /> {t("keys.audit.remove")}
                                                </Button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </section>
            ))}
        </div>
    );
}
