/**
 * 一台裝置的金鑰視窗：清單與裝置上實際內容在同一個畫面。
 * - 頂端狀態列（固定不捲）：是否同步完成、上次檢查時間、唯一的「立即同步」（套用清單 + 重讀每個帳號）。
 * - 「你的金鑰」：勾選 = 放進這台裝置的清單。
 * - 每個帳號一張卡：檔案裡的每把金鑰 × 清單狀態（已在裝置上 / 安裝中 / 失敗 / 移除中 / 服務金鑰 / 手動加的 / 非 Telepy），
 *   在同一列直接處理（移出清單、加入清單、從裝置移除）。
 * One device's key panel with the list and the device's actual authorized_keys in one view: a fixed status
 * bar with the single "sync now" (apply the list + re-read every account), your keys to tick, and one card per
 * account where every key shows both its list state and what is on the device, with its action on the row.
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    Clock3,
    FileWarning,
    HardDrive,
    KeyRound,
    Loader2,
    Lock,
    Plus,
    RefreshCw,
    Trash2,
    UserPen,
    WifiOff,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, SectionHeading } from "@/components/ui/section";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { shortFingerprint } from "@/lib/sshKeys";
import type { TranslationKey } from "@/locales/en";
import { oldestCheck, useDeviceKeys } from "@/hooks/useDeviceKeys";
import type { DeviceKeys, RowState, ViewAccount, ViewRow } from "@/types/keys";
import { OnlineDot, RoleBadge } from "./DeviceMatrix";

type Tone = "neutral" | "success" | "warning" | "danger" | "primary";

const ROW: Record<RowState, { label: TranslationKey; tip: TranslationKey; tone: Tone; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
    service: { label: "keys.row.service", tip: "keys.row.serviceTip", tone: "neutral", icon: Lock },
    installed: { label: "keys.row.installed", tip: "keys.row.installedTip", tone: "success", icon: CircleCheck },
    pending: { label: "keys.row.pending", tip: "keys.row.pendingTip", tone: "warning", icon: Clock3 },
    error: { label: "keys.row.error", tip: "keys.row.errorTip", tone: "danger", icon: CircleAlert },
    removing: { label: "keys.row.removing", tip: "keys.row.removingTip", tone: "warning", icon: Trash2 },
    manual: { label: "keys.row.manual", tip: "keys.row.manualTip", tone: "warning", icon: UserPen },
    unknown: { label: "keys.row.unknown", tip: "keys.row.unknownTip", tone: "neutral", icon: CircleDashed },
    invalid: { label: "keys.row.invalid", tip: "keys.row.invalidTip", tone: "danger", icon: FileWarning },
};

/** 「多久前檢查」：伺服器時間可能比瀏覽器快一點，未來的時間一律當成現在。
 *  "Checked … ago"; the server clock may run slightly ahead, so future times count as now. */
function ago(at: string | number, now: number, locale: string) {
    const ms = typeof at === "number" ? at : Date.parse(at);
    return formatRelativeTime(new Date(Math.min(ms, now)).toISOString(), locale, now);
}

/** 每 15 秒重畫一次，讓「幾秒前檢查」跟著走。/ Re-render every 15 s so "checked … ago" stays current. */
function useNow(ms: number) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}

function StateBadge({ row, online }: { row: ViewRow; online: boolean }) {
    const { t } = useI18n();
    const spec = ROW[row.state];
    const Icon = spec.icon;
    // 裝了但還沒在檔案裡看到：灰色勾。離線的「安裝中」寫成等裝置。/ Unverified installs are grey; offline pending says so.
    const unverified = row.state === "installed" && !row.verified;
    const label = unverified ? t("keys.row.installedUnverified") : row.state === "pending" && !online ? t("keys.row.waiting") : t(spec.label);
    const tip = unverified ? t("keys.row.installedUnverifiedTip") : row.state === "pending" && !online ? t("keys.row.waitingTip") : t(spec.tip);
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span tabIndex={0} className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                        <Chip tone={unverified ? "neutral" : spec.tone}>
                            <Icon className={cn(row.state === "pending" && online && "animate-pulse")} aria-hidden />
                            {label}
                        </Chip>
                    </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{tip}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/** 頂端狀態列：一句話說明現況 + 唯一的同步按鈕。/ The fixed status bar with the one sync action. */
function StatusBar({ d, syncing, onSync, now }: { d: DeviceKeys; syncing: boolean; onSync: () => void; now: number }) {
    const { t, locale } = useI18n();
    const rows = d.view.accounts.flatMap((a) => a.rows);
    const pending = rows.filter((r) => r.state === "pending" || r.state === "removing").length;
    const failed = d.view.accounts.filter((a) => a.error || a.rows.some((r) => r.state === "error")).length;
    const oldest = oldestCheck(d);
    let tone: "success" | "warning" | "danger" | "muted" = "success";
    let icon = <CircleCheck size={16} aria-hidden />;
    let text: string;
    if (syncing) {
        tone = "muted";
        icon = <Loader2 size={16} className="animate-spin" aria-hidden />;
        text = t("keys.device.statusChecking");
    } else if (!d.tunnel.online) {
        tone = pending ? "warning" : "muted";
        icon = <WifiOff size={16} aria-hidden />;
        text = pending ? t("keys.device.statusOfflinePending", { count: pending }) : t("keys.device.statusOffline");
    } else if (failed) {
        tone = "danger";
        icon = <CircleAlert size={16} aria-hidden />;
        text = t("keys.device.statusFailed", { count: failed });
    } else if (pending) {
        tone = "warning";
        icon = <Clock3 size={16} className="animate-pulse" aria-hidden />;
        text = t("keys.device.statusPending", { count: pending });
    } else if (oldest === null) {
        tone = "muted";
        icon = <CircleDashed size={16} aria-hidden />;
        text = t("keys.device.statusNotChecked");
    } else {
        text = t("keys.device.statusUpToDate", { when: ago(oldest, now, locale) });
    }
    return (
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p
                role="status"
                className={cn(
                    "flex min-w-0 items-center gap-2 text-sm",
                    tone === "success" && "text-success",
                    tone === "warning" && "text-warning",
                    tone === "danger" && "text-destructive",
                    tone === "muted" && "text-muted-foreground"
                )}
            >
                {icon}
                <span className="min-w-0">{text}</span>
            </p>
            <Button size="sm" variant="outline" onClick={onSync} disabled={syncing || !d.tunnel.online} title={t("keys.device.syncHint")}>
                <RefreshCw className={cn(syncing && "animate-spin")} /> {t("keys.matrix.syncNow")}
            </Button>
        </div>
    );
}

function KeyRowView({
    row,
    account,
    accountError,
    d,
    busy,
    onRemoveFromList,
    onAddToList,
    onRemoveFromDevice,
}: {
    row: ViewRow;
    account: string;
    /** 帳號卡已顯示的錯誤，列上就不再重複。/ Shown on the account card already; not repeated on the row. */
    accountError: string | null;
    d: DeviceKeys;
    busy: string | null;
    onRemoveFromList: (row: ViewRow) => void;
    onAddToList: (row: ViewRow) => void;
    onRemoveFromDevice: (account: string, row: ViewRow) => void;
}) {
    const { t } = useI18n();
    // 服務金鑰：標籤已寫「Telepy 服務」，標題用它自己的註解。/ The badge already says "Telepy service"; title it by its comment.
    const title = row.state === "service" ? row.comment ?? t("keys.row.serviceName") : row.name ?? row.comment ?? shortFingerprint(row.fingerprint ?? null);
    const canRemoveFromList = row.on_list && row.user_key_id !== null && (row.mine || d.can_manage);
    const canAddToList = !row.on_list && row.mine && row.user_key_id !== null && row.state === "manual";
    const canRemoveFromDevice = d.can_manage && (row.state === "manual" || row.state === "unknown") && !!row.fingerprint;
    const rowBusy = busy === `entry:${row.user_key_id}` || busy === `key:${row.user_key_id}` || busy === `line:${account}:${row.fingerprint}`;
    return (
        <li className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StateBadge row={row} online={d.tunnel.online} />
                    <span className="min-w-0 truncate text-sm text-foreground">{row.state === "invalid" ? t("keys.row.invalidLine", { line: row.line_no ?? "?" }) : title}</span>
                    {row.owner && row.state !== "service" && <Chip tone={row.mine ? "primary" : "neutral"}>{row.mine ? t("keys.device.you") : row.owner}</Chip>}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                    {row.state === "invalid" ? (
                        <span className="truncate" title={row.raw ?? ""}>{row.raw}</span>
                    ) : (
                        <>
                            {row.key_type && <span>{row.key_type}{row.bits ? ` · ${row.bits}` : ""}</span>}
                            {row.fingerprint && <span title={row.fingerprint}>{shortFingerprint(row.fingerprint)}</span>}
                            {row.state !== "service" && row.name && row.comment && <span className="truncate">{row.comment}</span>}
                        </>
                    )}
                </div>
                {row.options && <div className="truncate font-mono text-xs text-warning" title={row.options}>{t("keys.row.options", { options: row.options })}</div>}
                {row.error && row.error !== accountError && (row.state === "error" || row.state === "removing") && <div className="break-words text-xs text-destructive">{row.error}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1 self-start sm:self-center">
                {rowBusy && <Loader2 size={14} className="animate-spin text-muted-foreground" aria-hidden />}
                {canAddToList && (
                    <Button variant="ghost" size="xs" className="text-primary hover:text-primary" disabled={rowBusy} onClick={() => onAddToList(row)}>
                        <Plus /> {t("keys.row.addToList")}
                    </Button>
                )}
                {canRemoveFromList && (
                    <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:bg-destructive/8 hover:text-destructive"
                        disabled={rowBusy}
                        title={t("keys.row.removeFromListTip")}
                        onClick={() => onRemoveFromList(row)}
                    >
                        <Trash2 /> {t("keys.row.removeFromList")}
                    </Button>
                )}
                {canRemoveFromDevice && (
                    <Button variant="ghost" size="xs" className="text-destructive hover:bg-destructive/8 hover:text-destructive" disabled={rowBusy} onClick={() => onRemoveFromDevice(account, row)}>
                        <Trash2 /> {t("keys.row.removeFromDevice")}
                    </Button>
                )}
            </div>
        </li>
    );
}

function AccountCard({ account, d, now, children }: { account: ViewAccount; d: DeviceKeys; now: number; children: React.ReactNode }) {
    const { t, locale } = useI18n();
    return (
        <section className="overflow-hidden rounded-xl ring-1 ring-inset ring-border">
            <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/70 bg-surface px-3.5 py-2">
                <span className="font-mono text-sm text-foreground">
                    {account.username} <span className="text-xs text-muted-foreground">~/.ssh/authorized_keys</span>
                </span>
                <span className="text-xs text-muted-foreground">
                    {account.checked_at
                        ? t("keys.device.accountChecked", { count: account.rows.length, when: ago(account.checked_at, now, locale) })
                        : t("keys.device.accountNotChecked")}
                </span>
            </header>
            {account.error && (
                <div className="px-3.5 pt-2.5">
                    <Callout tone="danger">{t("keys.device.accountError", { error: account.error })}</Callout>
                </div>
            )}
            {account.rows.length > 0 ? (
                <ul className="divide-y divide-border/70">{children}</ul>
            ) : (
                <p className="px-3.5 py-3 text-sm text-muted-foreground">
                    {account.exists === false ? t("keys.device.noFile") : account.checked_at ? (d.can_manage ? t("keys.device.emptyFile") : t("keys.device.noneOfMine")) : t("keys.device.notReadYet")}
                </p>
            )}
        </section>
    );
}

export function DeviceKeysModal({ tunnelId, onClose, onChanged }: { tunnelId: number | null; onClose: () => void; onChanged: () => void }) {
    const { t } = useI18n();
    const dk = useDeviceKeys(tunnelId, onChanged);
    const [confirm, setConfirm] = useState<{ username: string; row: ViewRow } | null>(null);
    const now = useNow(15_000);
    const d = dk.data;

    // 在清單上、卻沒有任何帳號能裝的（擁有者還沒給帳號）。/ On the list but in no account yet.
    const unplaced = useMemo(() => (d ? d.entries.filter((e) => e.targets.length === 0) : []), [d]);

    return (
        <Modal
            isOpen={tunnelId !== null}
            onClose={onClose}
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
            isLoading={dk.loading && !d}
            toolbar={d ? <StatusBar d={d} syncing={dk.syncing} onSync={() => dk.sync()} now={now} /> : undefined}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            {dk.notFound && <Callout tone="danger">{t("keys.device.notFound")}</Callout>}
            {d && (
                <div className="space-y-6">
                    {/* 你的金鑰 / Your keys */}
                    <section>
                        <SectionHeading
                            title={t("keys.device.myKeys")}
                            description={
                                d.accounts.length > 0
                                    ? t("keys.device.myKeysHint", { accounts: d.accounts.join(", ") })
                                    : d.can_manage
                                      ? t("keys.matrix.noAccountsOwner")
                                      : t("keys.matrix.noAccountsSharee")
                            }
                            className="mb-2.5"
                        />
                        {d.my_keys.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {t("keys.device.noMyKeys")}{" "}
                                <Link href="/tunnels/keys" onClick={onClose} className="text-primary hover:underline">{t("keys.addKey")}</Link>
                            </p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {d.my_keys.map((k) => {
                                    const busy = dk.busy === `key:${k.id}` || dk.busy === "all";
                                    return (
                                        <label
                                            key={k.id}
                                            className="inline-flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-border transition-colors hover:bg-muted/50 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/35"
                                            title={k.fingerprint ?? ""}
                                        >
                                            {busy ? (
                                                <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                                            ) : (
                                                <input type="checkbox" checked={k.in_list} onChange={(e) => dk.toggleMine(k.id, e.target.checked)} className="size-4 accent-primary" />
                                            )}
                                            <KeyRound size={14} className="text-muted-foreground" aria-hidden />
                                            <span className="text-sm text-foreground">{k.name}</span>
                                            <span className="font-mono text-xs text-muted-foreground">{k.key_type ?? "?"}</span>
                                        </label>
                                    );
                                })}
                                {d.my_keys.some((k) => !k.in_list) && d.my_keys.length > 1 && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-primary hover:text-primary"
                                        disabled={dk.busy === "all"}
                                        onClick={() => dk.addAllMine(d.my_keys.filter((k) => !k.in_list).map((k) => k.id))}
                                    >
                                        <Plus /> {t("keys.device.addAllMine")}
                                    </Button>
                                )}
                            </div>
                        )}
                    </section>

                    {/* 每個帳號：清單 × 裝置上實際內容 / Each account: the list × what is on the device */}
                    <section className="space-y-3">
                        <SectionHeading title={t("keys.device.accounts")} description={d.can_manage ? t("keys.device.accountsHintManager") : t("keys.device.accountsHintSharee")} />
                        {d.view.accounts.length === 0 ? (
                            <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">{t("keys.device.noAccounts")}</p>
                        ) : (
                            d.view.accounts.map((a) => (
                                <AccountCard key={a.username} account={a} d={d} now={now}>
                                    {a.rows.map((r, i) => (
                                        <KeyRowView
                                            key={`${r.state}:${r.fingerprint ?? r.line_no ?? i}`}
                                            row={r}
                                            account={a.username}
                                            accountError={a.error}
                                            d={d}
                                            busy={dk.busy}
                                            onRemoveFromList={(row) => row.user_key_id !== null && dk.removeEntry(row.user_key_id)}
                                            onAddToList={(row) => row.user_key_id !== null && dk.toggleMine(row.user_key_id, true)}
                                            onRemoveFromDevice={(username, row) => setConfirm({ username, row })}
                                        />
                                    ))}
                                </AccountCard>
                            ))
                        )}
                    </section>

                    {unplaced.length > 0 && (
                        <section>
                            <SectionHeading title={t("keys.device.unplaced")} description={t("keys.device.unplacedHint")} className="mb-2.5" />
                            <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border">
                                {unplaced.map((e) => (
                                    <li key={e.user_key_id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                                            <span className="truncate text-sm text-foreground">{e.name}</span>
                                            <Chip tone={e.mine ? "primary" : "neutral"}>{e.mine ? t("keys.device.you") : e.owner.username}</Chip>
                                            <span className="font-mono text-xs text-muted-foreground" title={e.fingerprint ?? ""}>{shortFingerprint(e.fingerprint)}</span>
                                        </span>
                                        {(e.mine || d.can_manage) && (
                                            <Button
                                                variant="ghost"
                                                size="xs"
                                                className="text-destructive hover:bg-destructive/8 hover:text-destructive"
                                                disabled={dk.busy === `entry:${e.user_key_id}`}
                                                onClick={() => dk.removeEntry(e.user_key_id)}
                                            >
                                                <Trash2 /> {t("keys.row.removeFromList")}
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            )}
            <ConfirmDialog
                isOpen={!!confirm}
                onClose={() => setConfirm(null)}
                onConfirm={async () => {
                    if (confirm?.row.fingerprint) await dk.removeLine(confirm.username, confirm.row.fingerprint);
                    setConfirm(null);
                }}
                title={t("keys.row.removeTitle")}
                message={t("keys.row.removeMessage", {
                    key: confirm?.row.name || confirm?.row.comment || shortFingerprint(confirm?.row.fingerprint ?? null),
                    account: confirm?.username ?? "",
                })}
                confirmText={t("keys.row.removeFromDevice")}
                isDestructive
            />
        </Modal>
    );
}
