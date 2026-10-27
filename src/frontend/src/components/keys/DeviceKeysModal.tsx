/**
 * 一台裝置的金鑰視窗，分頁放在左側欄（跟偏好設定一樣），視窗固定高度、切頁不跳動。
 * - 頂端狀態列（固定不捲，每頁都在）：是否同步完成、上次檢查時間、唯一的「立即同步」（套用清單 + 重讀每個帳號），以及「金鑰去哪」的資訊按鈕。
 * - 「你的金鑰」：金鑰與金鑰群組在同一張清單（MyKeysOnDevice）——群組一段、組員在下，每把金鑰一列寫明怎麼到這台、裝到哪些帳號、每個帳號的狀態。
 * - 「裝置上的金鑰」：每個帳號一張卡，檔案裡的每把金鑰 × 清單狀態（已在裝置上 / 安裝中 / 失敗 / 移除中 / 服務金鑰 / 手動加的 / 非 Telepy），
 *   在同一列直接處理；列很多時 toolbar 多一列搜尋 / 帳號 / 分類、每張卡先顯示幾列、勾選後一次從裝置移除（KeyRowFilter）。
 * - 「最近的移除」（擁有者 / ADMIN）：7 天內的移除，每筆可還原；批次移除後頁尾也留一列「已移除 N 把 — 還原」。
 * One device's key panel with tabs in a side rail (like Preferences) and a fixed height. A status bar on every
 * tab carries the single "sync now" and the "where keys go" info button. "Your keys" lists keys and key groups
 * together (a section per group, one row per key with how it gets here, its accounts and their state); "On the
 * device" has one card per account comparing the list with the account's authorized_keys (search, buckets and
 * bulk removal for long files); "Recent removals" (owners / ADMIN) restores removals from the last 7 days.
 * Account cards name the key file (Windows admins = the shared administrators_authorized_keys).
 */
import React, { useEffect, useMemo, useState } from "react";
import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    Clock3,
    FileKey,
    FileWarning,
    HardDrive,
    History,
    Info,
    KeyRound,
    Layers,
    Loader2,
    Lock,
    Plus,
    RefreshCw,
    ShieldCheck,
    Trash2,
    Undo2,
    UserPen,
    WifiOff,
    X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { NativeSelect } from "@/components/ui/native-select";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
import { Chip, SectionHeading } from "@/components/ui/section";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { shortFingerprint } from "@/lib/sshKeys";
import type { TranslationKey } from "@/locales/en";
import { oldestCheck, useDeviceKeys, type LastRemoval } from "@/hooks/useDeviceKeys";
import type { DeviceKeys, KeyRemoval, RowState, ViewAccount, ViewRow } from "@/types/keys";
import { isRemovable } from "@/lib/keyRows";
import { accountsFromDevice, placeKey } from "@/lib/keyPlacement";
import { OnlineDot, RoleBadge } from "./DeviceMatrix";
import { KeyPlacementFlow } from "./KeyPlacementFlow";
import { MyKeysOnDevice } from "./MyKeysOnDevice";
import { reachSummary } from "@/lib/myKeysHere";
import { useFeatures } from "@/hooks/useFeatures";
import { RowFilterBar, RowsMore, SelectAllRemovable, useRowFilter, useRowLimit, useRowSelection, type RowFilterState, type RowSelection } from "./KeyRowFilter";

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

/** 「最近的移除」分頁：7 天內的移除，每筆可還原。/ The "Recent removals" tab: the last 7 days, each restorable. */
function RemovalsPanel({
    removals,
    busy,
    online,
    onRestore,
    now,
}: {
    removals: { days: number; items: KeyRemoval[] } | null;
    busy: string | null;
    online: boolean;
    onRestore: (id: number) => void;
    now: number;
}) {
    const { t, locale } = useI18n();
    return (
        <section className="space-y-3">
            <SectionHeading title={t("keys.undo.recent")} description={t("keys.undo.recentHint", { days: removals?.days ?? 7 })} />
            {!removals ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" aria-hidden /> {t("keys.loading")}</p>
            ) : removals.items.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">{t("keys.undo.none", { days: removals.days })}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border">
                    {removals.items.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                            <span className="min-w-0">
                                <span className="block text-sm text-foreground">{t("keys.undo.item", { keys: r.keys, account: r.username })}</span>
                                <span className="block text-xs text-muted-foreground">
                                    {ago(r.removed_at, now, locale)} · {t("keys.undo.by", { user: r.removed_by })}
                                </span>
                            </span>
                            {r.restored_at ? (
                                <Chip tone="success"><CircleCheck aria-hidden /> {t("keys.undo.restoredAt")}</Chip>
                            ) : (
                                <Button size="xs" variant="outline" disabled={busy === "restore" || !online} onClick={() => onRestore(r.id)}>
                                    <Undo2 /> {t("keys.undo.restore")}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** 「金鑰去哪」：選一把在清單上的金鑰，看它在這台裝置會進哪些帳號、哪個檔案。/ The placement flow for this device. */
function PlacementDialog({ d, isOpen, onClose }: { d: DeviceKeys; isOpen: boolean; onClose: () => void }) {
    const { t } = useI18n();
    const listed = d.my_keys.filter((k) => k.in_list);
    const [keyId, setKeyId] = useState<number | null>(null);
    const key = listed.find((k) => k.id === keyId) ?? listed[0] ?? null;
    const accounts = useMemo(() => accountsFromDevice(d.view.accounts, d.account_ids), [d.view.accounts, d.account_ids]);
    const allowedIds = d.account_ids.map((a) => a.id);
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("keys.place.title")} description={t("keys.place.subtitle")} icon={<Info />} size="2xl" footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}>
            {key ? (
                <div className="space-y-3">
                    {listed.length > 1 && (
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            {t("keys.place.pickKey")}
                            <NativeSelect value={String(key.id)} onChange={(e) => setKeyId(Number(e.target.value))} className="h-8 max-w-xs">
                                {listed.map((k) => (
                                    <option key={k.id} value={k.id}>{k.name}</option>
                                ))}
                            </NativeSelect>
                        </label>
                    )}
                    <KeyPlacementFlow keyLabel={key.name} listLabel={d.tunnel.host_friendly_name} placements={placeKey(accounts, allowedIds, key.accounts)} />
                    {d.platform?.windows && <Callout tone="info">{t("keys.place.adminFileTip")}</Callout>}
                </div>
            ) : (
                <Callout tone="info">{t("keys.place.noKeys")}</Callout>
            )}
        </Modal>
    );
}

/** 頂端狀態列：一句話說明現況 + 唯一的同步按鈕（+ 資訊、最近的移除）。/ The fixed status bar with the one sync action. */
function StatusBar({ d, syncing, onSync, now, onInfo }: { d: DeviceKeys; syncing: boolean; onSync: () => void; now: number; onInfo: () => void }) {
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
            <span className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" onClick={onInfo} title={t("keys.place.open")} aria-label={t("keys.place.open")}>
                    <Info /> <span className="hidden sm:inline">{t("keys.place.open")}</span>
                </Button>
                <Button size="sm" variant="outline" onClick={onSync} disabled={syncing || !d.tunnel.online} title={t("keys.device.syncHint")}>
                    <RefreshCw className={cn(syncing && "animate-spin")} /> {t("keys.matrix.syncNow")}
                </Button>
            </span>
        </div>
    );
}

/** 頁尾的「已移除 N 把 — 還原」：留著直到還原、關閉或下一次移除。/ The footer's inline undo. */
function UndoBar({ last, busy, online, onUndo, onDismiss }: { last: LastRemoval; busy: string | null; online: boolean; onUndo: () => void; onDismiss: () => void }) {
    const { t } = useI18n();
    return (
        <span role="status" className="mr-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface px-2.5 py-1.5 ring-1 ring-inset ring-border">
            <Trash2 size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-sm text-foreground">{t("keys.undo.removed", { count: last.keys, account: last.accounts.join(", ") })}</span>
            <Button size="xs" variant="outline" disabled={busy === "restore" || !online} onClick={onUndo}>
                {busy === "restore" ? <Loader2 className="animate-spin" /> : <Undo2 />} {t("keys.undo.button")}
            </Button>
            <Button size="xs" variant="ghost" onClick={onDismiss} aria-label={t("keys.undo.dismiss")} title={t("keys.undo.dismiss")}>
                <X />
            </Button>
        </span>
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
    selection,
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
    /** 擁有者 / ADMIN 才有：勾選後一次移除。/ Owners / ADMIN only: bulk selection. */
    selection?: RowSelection;
}) {
    const { t } = useI18n();
    // 服務金鑰：標籤已寫「Telepy 服務」，標題說是這條通道的金鑰、還是舊的共用金鑰。/ Service rows: this tunnel's key or the legacy shared one.
    const title = row.state === "service" ? (row.legacy ? t("keys.row.sharedName") : t("keys.row.serviceName")) : row.name ?? row.comment ?? shortFingerprint(row.fingerprint ?? null);
    // 只經由金鑰群組來的列沒有可移除的清單項目（改群組或授予）。/ Rows that only come through key groups have no list entry to remove.
    const canRemoveFromList = row.on_list && row.direct !== false && row.user_key_id !== null && (row.mine || d.can_manage);
    const canAddToList = !row.on_list && row.mine && row.user_key_id !== null && row.state === "manual";
    const canRemoveFromDevice = d.can_manage && (row.state === "manual" || row.state === "unknown") && !!row.fingerprint;
    const rowBusy = busy === `entry:${row.user_key_id}` || busy === `key:${row.user_key_id}` || busy === `line:${account}:${row.fingerprint}` || (busy === "bulk" && !!selection?.isSelected(account, row));
    const selectable = !!selection && canRemoveFromDevice && isRemovable(row);
    return (
        <li className={cn("flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between", selectable && selection.isSelected(account, row) && "bg-destructive/[0.04]")}>
            <div className="flex min-w-0 items-start gap-2.5">
                {selection && (
                    <span className="flex w-4 shrink-0 justify-center pt-1">
                        {selectable && (
                            <input
                                type="checkbox"
                                className="size-4 cursor-pointer accent-primary"
                                checked={selection.isSelected(account, row)}
                                disabled={busy === "bulk"}
                                onChange={(e) => selection.toggle(account, [row], e.target.checked)}
                                aria-label={t("keys.rows.select", { key: title })}
                            />
                        )}
                    </span>
                )}
            <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StateBadge row={row} online={d.tunnel.online} />
                    <span className="min-w-0 truncate text-sm text-foreground">{row.state === "invalid" ? t("keys.row.invalidLine", { line: row.line_no ?? "?" }) : title}</span>
                    {row.owner && row.state !== "service" && <Chip tone={row.mine ? "primary" : "neutral"}>{row.mine ? t("keys.device.you") : row.owner}</Chip>}
                    {(row.groups ?? []).map((g) => (
                        <Chip key={g.id} title={row.mine ? t("groups.viaGroupTip", { name: g.name }) : t("groups.viaGroupOther", { name: g.name, owner: row.owner ?? "" })}>
                            <Layers aria-hidden /> {t("groups.viaGroupShort", { name: g.name })}
                        </Chip>
                    ))}
                    {row.state === "service" && row.legacy && <Chip tone="warning" title={t(d.view.keep_shared ? "keys.row.keptSharedTip" : "keys.row.legacySharedTip")}>{t("keys.row.legacyShared")}</Chip>}
                    {row.line_count > 1 && (
                        <Chip tone="warning" title={t("keys.rows.linesTip", { count: row.line_count })}>
                            {t("keys.rows.lines", { count: row.line_count })}
                        </Chip>
                    )}
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

function AccountCard({
    account,
    rows,
    d,
    now,
    filter,
    selection,
    renderRow,
}: {
    account: ViewAccount;
    /** 符合篩選的列。/ Rows matching the filter. */
    rows: ViewRow[];
    d: DeviceKeys;
    now: number;
    filter: RowFilterState;
    selection?: RowSelection;
    renderRow: (row: ViewRow, i: number) => React.ReactNode;
}) {
    const { t, locale } = useI18n();
    const limit = useRowLimit(rows.length, filter.resetKey, filter.filtering);
    return (
        <section className="overflow-hidden rounded-xl ring-1 ring-inset ring-border">
            <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/70 bg-surface px-3.5 py-2">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm text-foreground">
                    {account.username} <span className="text-xs text-muted-foreground">{account.file}</span>
                    {account.windows_admin && (
                        <TooltipProvider delayDuration={150}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span tabIndex={0} className="inline-flex rounded-sm font-sans focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                                        <Chip tone="neutral"><ShieldCheck aria-hidden /> {t("keys.place.adminFile")}</Chip>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-xs">{t("keys.place.adminFileTip")}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {selection && <SelectAllRemovable username={account.username} rows={rows} selection={selection} />}
                    <span className="text-xs text-muted-foreground">
                        {account.checked_at
                            ? t("keys.device.accountChecked", { count: account.rows.length, when: ago(account.checked_at, now, locale) })
                            : t("keys.device.accountNotChecked")}
                    </span>
                </span>
            </header>
            {account.error && (
                <div className="px-3.5 pt-2.5">
                    <Callout tone="danger">{t("keys.device.accountError", { error: account.error })}</Callout>
                </div>
            )}
            {rows.length > 0 ? (
                <>
                    <ul className="divide-y divide-border/70">{rows.slice(0, limit.shown).map(renderRow)}</ul>
                    <RowsMore shown={limit.shown} total={rows.length} onMore={limit.more} onAll={limit.all} />
                </>
            ) : account.rows.length > 0 ? (
                <p className="px-3.5 py-3 text-sm text-muted-foreground">{t("keys.rows.noMatch")}</p>
            ) : (
                <p className="px-3.5 py-3 text-sm text-muted-foreground">
                    {account.exists === false ? t("keys.device.noFile") : account.checked_at ? (d.can_manage ? t("keys.device.emptyFile") : t("keys.device.noneOfMine")) : t("keys.device.notReadYet")}
                </p>
            )}
        </section>
    );
}

const NO_ACCOUNTS: ViewAccount[] = [];

type DeviceKeysTab = "keys" | "accounts" | "removals";

export function DeviceKeysModal({ tunnelId, onClose, onChanged }: { tunnelId: number | null; onClose: () => void; onChanged: () => void }) {
    // 「個人 SSH 金鑰」被關掉：不能把自己的金鑰加進清單。/ Personal keys turned off: you cannot add your own keys.
    const keysOn = useFeatures().has("keys.personal");
    const { t } = useI18n();
    const dk = useDeviceKeys(tunnelId, onChanged);
    const [confirm, setConfirm] = useState<{ username: string; row: ViewRow } | null>(null);
    const now = useNow(15_000);
    const d = dk.data;
    const [bulkConfirm, setBulkConfirm] = useState(false);
    const [placement, setPlacement] = useState(false);
    const accounts = d?.view.accounts ?? NO_ACCOUNTS;
    const filter = useRowFilter(accounts, !!d?.tunnel.online);
    const selection = useRowSelection(accounts);
    // 篩選時，沒有符合列的帳號收起來（「需要處理」時有錯誤的帳號照樣顯示）。
    // While filtering, accounts without matches fold away (failing accounts stay under "needs attention").
    const shownAccounts = filter.filtering ? filter.accounts.filter((a) => a.rows.length > 0 || (filter.bucket === "attention" && a.account.error)) : filter.accounts;
    const foldedAccounts = filter.accounts.length - shownAccounts.length;
    const bulkSummary = useMemo(() => [...selection.groups].map(([user, fps]) => `${user} (${fps.length})`).join(", "), [selection.groups]);

    // 在清單上、卻沒有任何帳號能裝的（擁有者還沒給帳號）。/ On the list but in no account yet.
    const unplaced = useMemo(() => (d ? d.entries.filter((e) => e.targets.length === 0) : []), [d]);

    // 分頁：換一台裝置就回到預設那頁。/ Tabs: back to the default tab for every device.
    const [tab, setTab] = useState<{ tunnel: number | null; value: DeviceKeysTab | null }>({ tunnel: tunnelId, value: null });
    if (tab.tunnel !== tunnelId) setTab({ tunnel: tunnelId, value: null });
    // 有自己的金鑰或群組就先看「你的金鑰」，否則先看帳號。/ Start on "Your keys" when there are any, else the accounts.
    const hasMine = keysOn && !!d && (d.my_keys.length > 0 || (d.my_key_groups ?? []).length > 0);
    const showRemovals = !!d?.can_manage;
    const fallback: DeviceKeysTab = hasMine ? "keys" : "accounts";
    const active: DeviceKeysTab = tab.value === "keys" && !keysOn ? "accounts" : tab.value === "removals" && !showRemovals ? fallback : (tab.value ?? fallback);
    const bodyRef = React.useRef<HTMLDivElement>(null);
    const loadRemovals = dk.loadRemovals;
    useEffect(() => {
        if (active === "removals") void loadRemovals();
    }, [active, loadRemovals]);
    const pick = (value: DeviceKeysTab) => {
        setTab({ tunnel: tunnelId, value });
        // 各頁共用同一個捲動區，切頁時回到頂端。/ The pages share one scroll area; start at the top.
        const scroller = bodyRef.current?.parentElement;
        if (scroller) scroller.scrollTop = 0;
    };

    const failedAccounts = accounts.filter((a) => a.error || a.rows.some((r) => r.state === "error")).length;
    const reach = d ? reachSummary(d.my_keys) : null;
    const tabs = d
        ? [
              ...(keysOn
                  ? [{ value: "keys" as const, label: t("keys.device.tabKeys"), hint: t("keys.device.tabKeysHint", { here: reach?.here ?? 0, total: reach?.total ?? 0 }), icon: <KeyRound /> }]
                  : []),
              {
                  value: "accounts" as const,
                  label: <NavTabLabel label={t("keys.device.tabAccounts")} mark={failedAccounts > 0 ? "error" : null} />,
                  hint: t("keys.device.tabAccountsHint", { count: accounts.length }),
                  icon: <FileKey />,
              },
              ...(showRemovals ? [{ value: "removals" as const, label: t("keys.undo.recent"), hint: t("keys.device.tabRemovalsHint", { days: dk.removals?.days ?? 7 }), icon: <History /> }] : []),
          ]
        : [];

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
            size="5xl"
            fixedHeight
            isLoading={dk.loading && !d}
            nav={d ? <NavTabs tabs={tabs} value={active} onChange={pick} aria-label={t("keys.device.titleLoading")} /> : undefined}
            toolbar={
                d ? (
                    <div className="space-y-2.5">
                        <StatusBar d={d} syncing={dk.syncing} onSync={() => dk.sync()} now={now} onInfo={() => setPlacement(true)} />
                        {active === "accounts" && <RowFilterBar filter={filter} />}
                    </div>
                ) : undefined
            }
            footer={
                <>
                    {d && dk.lastRemoval && selection.count === 0 && (
                        <UndoBar last={dk.lastRemoval} busy={dk.busy} online={d.tunnel.online} onUndo={() => dk.lastRemoval && dk.restore(dk.lastRemoval.ids)} onDismiss={dk.dismissRemoval} />
                    )}
                    {d?.can_manage && selection.count > 0 && (
                        <span className="mr-auto flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm text-foreground">{t("keys.rows.selected", { count: selection.count })}</span>
                            <Button variant="ghost" size="sm" onClick={selection.clear} disabled={dk.busy === "bulk"}>
                                {t("keys.rows.clearSelection")}
                            </Button>
                        </span>
                    )}
                    <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
                    {d?.can_manage && selection.count > 0 && (
                        <Button variant="destructive" onClick={() => setBulkConfirm(true)} disabled={dk.busy === "bulk" || !d.tunnel.online}>
                            {dk.busy === "bulk" ? <Loader2 className="animate-spin" /> : <Trash2 />} {t("keys.rows.removeSelected", { count: selection.count })}
                        </Button>
                    )}
                </>
            }
        >
            <div ref={bodyRef}>
                {dk.notFound && <Callout tone="danger">{t("keys.device.notFound")}</Callout>}
                {d && (
                    <>
                        {/* 你的金鑰 + 金鑰群組：同一張清單 / Your keys and key groups in one list */}
                        {keysOn && (
                            <div role="tabpanel" hidden={active !== "keys"}>
                                <MyKeysOnDevice
                                    d={d}
                                    busy={dk.busy}
                                    onToggle={dk.toggleMine}
                                    onAddAll={dk.addAllMine}
                                    onSetAccounts={dk.setAccounts}
                                    onToggleGroup={(id, on, grantId) => void dk.toggleGroup(id, on, grantId)}
                                    onNavigate={onClose}
                                />
                            </div>
                        )}

                        {/* 每個帳號：清單 × 裝置上實際內容 / Each account: the list × what is on the device */}
                        <div role="tabpanel" hidden={active !== "accounts"} className="space-y-6">
                            {d.platform?.error && d.can_manage && !filter.filtering && <Callout tone="warning">{t("keys.device.platformError", { error: d.platform.error })}</Callout>}
                            <section className="space-y-3">
                                <SectionHeading title={t("keys.device.accounts")} description={d.can_manage ? t("keys.device.accountsHintManager") : t("keys.device.accountsHintSharee")} />
                                {d.view.accounts.length === 0 ? (
                                    <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">{t("keys.device.noAccounts")}</p>
                                ) : (
                                    <>
                                        {shownAccounts.map(({ account: a, rows }) => (
                                            <AccountCard
                                                key={a.username}
                                                account={a}
                                                rows={rows}
                                                d={d}
                                                now={now}
                                                filter={filter}
                                                selection={d.can_manage ? selection : undefined}
                                                renderRow={(r, i) => (
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
                                                        selection={d.can_manage ? selection : undefined}
                                                    />
                                                )}
                                            />
                                        ))}
                                        {filter.filtering && (shownAccounts.length === 0 || foldedAccounts > 0) && (
                                            <p className="flex flex-wrap items-center justify-center gap-x-2 rounded-xl border border-dashed border-border px-4 py-3 text-center text-sm text-muted-foreground">
                                                {shownAccounts.length === 0 ? t("keys.rows.noMatch") : t("keys.rows.otherAccounts", { count: foldedAccounts })}
                                                <Button variant="ghost" size="xs" className="text-primary hover:text-primary" onClick={filter.reset}>
                                                    {t("keys.rows.clearFilter")}
                                                </Button>
                                            </p>
                                        )}
                                    </>
                                )}
                            </section>

                            {unplaced.length > 0 && !filter.filtering && (
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
                                                {e.groups.map((g) => (
                                                    <Chip key={g.id} title={t("groups.viaGroup", { name: g.name })}>
                                                        <Layers aria-hidden /> {t("groups.viaGroupShort", { name: g.name })}
                                                    </Chip>
                                                ))}
                                                {e.direct && (e.mine || d.can_manage) && (
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

                        {showRemovals && (
                            <div role="tabpanel" hidden={active !== "removals"}>
                                <RemovalsPanel removals={dk.removals} busy={dk.busy} online={d.tunnel.online} onRestore={(id) => dk.restore([id])} now={now} />
                            </div>
                        )}
                    </>
                )}
            </div>
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
            {d && <PlacementDialog d={d} isOpen={placement} onClose={() => setPlacement(false)} />}
            <ConfirmDialog
                isOpen={bulkConfirm}
                onClose={() => setBulkConfirm(false)}
                onConfirm={async () => {
                    if (await dk.removeLines(selection.groups)) selection.clear();
                    setBulkConfirm(false);
                }}
                title={t("keys.rows.removeSelectedTitle", { count: selection.count })}
                message={t("keys.rows.removeSelectedMessage", { accounts: bulkSummary })}
                confirmText={t("keys.rows.removeSelected", { count: selection.count })}
                isDestructive
            />
        </Modal>
    );
}
