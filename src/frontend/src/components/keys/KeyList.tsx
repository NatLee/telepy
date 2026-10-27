/**
 * 「我的金鑰」清單：一把金鑰一列（名稱 / 類型 / 群組、註解與說明、SHA256 指紋（可複製）、最後使用（時間 + 來源 IP）
 * 與到期、在幾台裝置的清單上），整列點下去開詳細資訊。容器夠寬（`@3xl`）時排成有欄位標題的表格，窄的時候
 * （手機、側欄展開的平板）每列兩行：名稱一行、使用 / 裝置 / 到期一行；指紋與註解留在詳細資訊裡。
 * 金鑰多時不再是一張張大卡片，一個畫面看得到十幾把。
 * "Your keys" as a list: one row per key (name / type / group, comment and description, copyable SHA256
 * fingerprint, last use (time + source IP) and expiry, how many devices' lists it is on); a click on the row opens
 * the details. A wide container (`@3xl`) gets a table with column titles; a narrow one (phones, tablets with the
 * sidebar open) two lines per row: the name, then use / devices / expiry, with the fingerprint and comment left to
 * the details. With many keys a screen now holds a dozen of them instead of three large cards.
 */
import React from "react";
import { CalendarClock, Clock3, HardDrive, KeyRound, Layers, Trash2, TriangleAlert, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { KeyDevice, KeyTarget, UserKey } from "@/types/keys";
import { expiryState } from "@/lib/keyExpiry";
import { cn } from "@/lib/utils";

export function KeyTypeBadge({ type, bits }: { type: string | null; bits: number | null }) {
    const { t } = useI18n();
    if (!type) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[0.75rem] text-warning ring-1 ring-inset ring-warning/30">
                <TriangleAlert size={12} aria-hidden /> {t("keys.unrecognized")}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[0.75rem] text-muted-foreground">
            {type}
            {bits ? ` · ${bits}` : ""}
        </span>
    );
}

/** 「30 天後到期」「已在 2 天前到期」「不到期」；顏色跟著狀態。/ Expiry text coloured by state. */
export function KeyExpiryText({ expiresAt, compact = false }: { expiresAt: string | null; compact?: boolean }) {
    const { t, locale } = useI18n();
    const state = expiryState(expiresAt);
    if (state === "none" || !expiresAt) return compact ? null : <span className="text-muted-foreground">{t("keys.expiry.neverExpires")}</span>;
    const when = formatRelativeTime(expiresAt, locale);
    return (
        <span
            title={new Date(expiresAt).toLocaleString(locale)}
            className={cn(state === "expired" ? "text-destructive" : state === "soon" ? "text-warning" : compact ? "text-muted-foreground" : "text-foreground")}
        >
            {state === "expired" ? t("keys.expiry.expired", { when }) : t("keys.expiry.expires", { when })}
        </span>
    );
}

/** 一把金鑰在哪些裝置的清單上（`useKeysPage().placements` 的值）。/ Where a key is listed (a `placements` value). */
type Placements = { device: KeyDevice; targets: KeyTarget[] }[];

/** 「3 天前使用過」；滑過看完整時間與來源 IP。/ "Used 3 days ago"; hover for the full time and source IP. */
function LastUsed({ keyItem }: { keyItem: UserKey }) {
    const { t, locale } = useI18n();
    if (!keyItem.last_used_at) return <span className="text-muted-foreground">{t("keys.neverUsed")}</span>;
    return (
        <span title={new Date(keyItem.last_used_at).toLocaleString(locale) + (keyItem.last_used_ip ? ` · ${keyItem.last_used_ip}` : "")}>
            {t("keys.used", { when: formatRelativeTime(keyItem.last_used_at, locale) })}
        </span>
    );
}

/** 「7 台 · 已裝上 5」；滑過看裝置名稱。/ "7 devices · 5 installed"; hover for the names. */
function DevicesText({ placements, className }: { placements: Placements; className?: string }) {
    const { t } = useI18n();
    if (placements.length === 0) return <span className={cn("text-muted-foreground", className)}>{t("keys.onNoDevice")}</span>;
    const installed = placements.filter((p) => p.targets.some((tg) => tg.status === "installed")).length;
    return (
        <span className={className} title={placements.map((p) => p.device.host_friendly_name).join(", ")}>
            {t("keys.list.devices", { count: placements.length, installed })}
        </span>
    );
}

/** 金鑰群組的小籤。/ The key group chip. */
function GroupChip({ name }: { name: string }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-px text-[0.75rem] text-muted-foreground" title={t("groups.key.chipTitle")}>
            <Layers size={12} className="shrink-0" aria-hidden /> <span className="truncate">{name}</span>
        </span>
    );
}

function KeyRow({
    keyItem,
    placements,
    groupName,
    onDetails,
    onDelete,
}: {
    keyItem: UserKey;
    placements: Placements;
    groupName: string | null;
    onDetails: () => void;
    onDelete: () => void;
}) {
    const { t } = useI18n();
    const name = keyItem.host_friendly_name;
    const expiring = keyItem.expires_at ? expiryState(keyItem.expires_at) : "none";
    // 整列可點；按鈕、連結與選取文字（例如複製指紋）不算。/ The whole row opens the details, except buttons / links / a text selection.
    const onRowClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        if (window.getSelection()?.toString()) return;
        onDetails();
    };
    return (
        <li
            onClick={onRowClick}
            className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 transition-colors hover:bg-muted/40 @3xl:grid-cols-(--key-cols) @3xl:px-4"
        >
            <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                    <KeyRound size={15} />
                </span>
                <div className="min-w-0 flex-1">
                    {/* 名稱是主要辨識，不截斷：太長就換行，類型籤跟在後面。/ The name is the identifier: it wraps rather than being cut. */}
                    <p className="min-w-0 break-words leading-snug">
                        <button
                            type="button"
                            onClick={onDetails}
                            className="mr-2 rounded-sm text-left text-[0.9375rem] text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            {name}
                        </button>
                        {/* 很窄（手機）時只留「無法辨識」的警告籤，一般類型在詳細資訊裡。/ Very narrow (phones): only the "unrecognized" warning. */}
                        <span className={cn("align-[0.0625rem]", keyItem.key_type ? "hidden @md:inline-block" : "inline-block")}>
                            <KeyTypeBadge type={keyItem.key_type} bits={keyItem.bits} />
                        </span>
                    </p>
                    {/* 第二行。寬：群組、註解與說明；窄：群組、使用 / 裝置 / 到期（指紋在詳細資訊）。
                        Second line. Wide: group, comment + description; narrow: group, use / devices / expiry. */}
                    {(groupName || keyItem.comment || keyItem.description) && (
                        <p className="mt-0.5 hidden min-w-0 items-center gap-1.5 text-[0.75rem] text-muted-foreground @3xl:flex">
                            {groupName && <GroupChip name={groupName} />}
                            <span className="min-w-0 truncate" title={[keyItem.comment, keyItem.description].filter(Boolean).join(" · ")}>
                                {keyItem.comment && <span className="font-mono">{keyItem.comment}</span>}
                                {keyItem.comment && keyItem.description && " · "}
                                {keyItem.description}
                            </span>
                        </p>
                    )}
                    <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.75rem] text-muted-foreground @3xl:hidden">
                        {groupName && <GroupChip name={groupName} />}
                        <span className="inline-flex min-w-0 items-center gap-1">
                            <Clock3 size={12} className="shrink-0" aria-hidden />
                            <LastUsed keyItem={keyItem} />
                        </span>
                        <span className="inline-flex min-w-0 items-center gap-1">
                            <HardDrive size={12} className="shrink-0" aria-hidden />
                            <DevicesText placements={placements} />
                        </span>
                        {expiring !== "none" && (
                            <span className="inline-flex min-w-0 items-center gap-1">
                                <CalendarClock size={12} className="shrink-0" aria-hidden />
                                <KeyExpiryText expiresAt={keyItem.expires_at} compact />
                            </span>
                        )}
                    </p>
                </div>
            </div>

            <div className="hidden min-w-0 items-center gap-0.5 @3xl:flex">
                <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted-foreground" title={keyItem.fingerprint ?? ""}>
                    {keyItem.fingerprint ?? t("keys.noFingerprint")}
                </span>
                {keyItem.fingerprint && <CopyButton value={keyItem.fingerprint} className="size-7" />}
            </div>

            <div className="hidden min-w-0 text-xs @3xl:block">
                <p className="truncate text-foreground/85">
                    <LastUsed keyItem={keyItem} />
                </p>
                {keyItem.expires_at ? (
                    <p className="truncate">
                        <KeyExpiryText expiresAt={keyItem.expires_at} compact />
                    </p>
                ) : (
                    keyItem.last_used_ip && <p className="truncate font-mono text-[0.75rem] text-muted-foreground">{keyItem.last_used_ip}</p>
                )}
            </div>

            <div className="hidden min-w-0 text-xs @3xl:block">
                <DevicesText placements={placements} className="block truncate text-foreground/85" />
                {placements.length > 0 && (
                    <p className="truncate text-[0.75rem] text-muted-foreground" title={placements.map((p) => p.device.host_friendly_name).join(", ")}>
                        {placements.map((p) => p.device.host_friendly_name).join(", ")}
                    </p>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
                <Button variant="ghost" size="icon-sm" onClick={onDetails} aria-label={t("keys.list.detailsAria", { name })} title={t("common.details")} className="text-muted-foreground hover:text-primary">
                    <PanelRightOpen />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={t("keys.list.deleteAria", { name })} title={t("common.delete")} className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive">
                    <Trash2 />
                </Button>
            </div>
        </li>
    );
}

export function KeyList({
    keys,
    placements,
    groupNameOf,
    onDetails,
    onDelete,
}: {
    keys: UserKey[];
    placements: Map<number, Placements>;
    /** 金鑰所在的金鑰群組名稱。/ The key group each key is in. */
    groupNameOf: Map<number, string>;
    onDetails: (k: UserKey) => void;
    onDelete: (k: UserKey) => void;
}) {
    const { t } = useI18n();
    return (
        <div
            className="@container overflow-hidden rounded-xl border border-border bg-card shadow-card"
            style={{ "--key-cols": "minmax(0,1.7fr) minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) auto" } as React.CSSProperties}
        >
            {/* 欄位標題只在表格排版時出現。/ Column titles only in the table layout. */}
            <div className="hidden grid-cols-(--key-cols) gap-x-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted-foreground @3xl:grid" aria-hidden>
                <span className="pl-11">{t("keys.list.colKey")}</span>
                <span>{t("keys.fingerprint")}</span>
                <span>{t("keys.lastUsed")}</span>
                <span>{t("keys.onDevices")}</span>
                <span className="w-[4.125rem]" />
            </div>
            <ul className="divide-y divide-border/70">
                {keys.map((k) => (
                    <KeyRow
                        key={k.id}
                        keyItem={k}
                        placements={placements.get(k.id) ?? []}
                        groupName={groupNameOf.get(k.id) ?? null}
                        onDetails={() => onDetails(k)}
                        onDelete={() => onDelete(k)}
                    />
                ))}
            </ul>
        </div>
    );
}
