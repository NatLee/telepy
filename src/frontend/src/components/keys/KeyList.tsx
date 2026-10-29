/**
 * 「我的金鑰」：列表（`KeyList`）或卡片（`KeyCards`），選哪種跟著帳號走（`view_modes.keys`，偏好設定也看得到）。
 * 列表一把一列（名稱 / 類型、籤、註解與說明、SHA256 指紋（可複製）、最後使用與到期、在幾台裝置的清單上），
 * 容器夠寬（`@3xl`）時排成有欄位標題的表格，窄的時候每列疊成幾行。卡片把同樣的資訊攤開：指紋整串、
 * 每台裝置一個籤（出錯 / 排隊的在前），點裝置籤直接開那台的金鑰面板。
 * 籤（群組、裝置金鑰、到期）一律在名稱下面自己的一行、可換行、不截斷——以前它們跟註解擠在不換行的一行，
 * 籤一多就蓋到隔壁的指紋欄、把註解擠掉。整列 / 整張點下去開詳細資訊。
 * "Your keys" as a list (`KeyList`) or cards (`KeyCards`); the choice follows the account (`view_modes.keys`, also
 * in Preferences). The list has one row per key (name / type, chips, comment and description, copyable SHA256
 * fingerprint, last use and expiry, how many devices' lists it is on): a table with column titles from a wide
 * container (`@3xl`), stacked lines when narrow. Cards spread the same out: the whole fingerprint and one chip per
 * device (failed / queued first), and a device chip opens that device's key panel.
 * Chips (group, device key, expiry) always get their own wrapping line under the name and are never cut. They used
 * to share a no-wrap line with the comment, so a few of them spilled over the fingerprint column and pushed the
 * comment out. A click on a row / card opens the details.
 */
import React from "react";
import { CalendarClock, Clock3, Fingerprint, HardDrive, KeyRound, Laptop, Layers, Trash2, TriangleAlert, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { KeyDevice, KeyTarget, UserKey } from "@/types/keys";
import { expiryState } from "@/lib/keyExpiry";
import { cardDevices, deviceBadgeText, deviceState, keyBadges, type DeviceState, type KeyBadge } from "@/lib/keyBadges";
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
    // 每個帳號都裝好才算這台「已裝上」（卡片的狀態點也這樣算）。/ Installed = every account done (as the cards' dots).
    const installed = placements.filter((p) => deviceState(p.targets) === "installed").length;
    return (
        <span className={className} title={placements.map((p) => p.device.host_friendly_name).join(", ")}>
            {t("keys.list.devices", { count: placements.length, installed })}
        </span>
    );
}

/**
 * 籤裡可以換行的文字（長名稱折到下一行，不截斷）；折行時圖示對齊第一行。
 * Chip text that wraps (long names go to the next line, never cut); the icon stays on the first line when it does.
 */
const CHIP = "max-w-full items-start";
const CHIP_ICON = "mt-[0.1875rem] shrink-0";
const CHIP_TEXT = "min-w-0 whitespace-normal text-left [overflow-wrap:anywhere]";

/**
 * 這把也是你某條隧道的裝置金鑰：那台電腦既是裝置、也用同一把連別的裝置。一條寫名稱，好幾條寫數量。
 * The key also keeps one of your tunnels up: that computer is a device and reaches your other devices with it. One
 * tunnel by name, several by count.
 */
export function DeviceKeyChip({ tunnels }: { tunnels: NonNullable<UserKey["device_of"]> }) {
    const { t } = useI18n();
    if (!tunnels.length) return null;
    const names = tunnels.map((d) => d.name);
    const text = deviceBadgeText(names);
    return (
        <Chip className={cn(CHIP, "bg-info/10 text-info")} title={t("keys.deviceOf.title", { name: names.join(", ") })}>
            <Laptop className={CHIP_ICON} aria-hidden />
            <span className={CHIP_TEXT}>{"one" in text ? t("keys.deviceOf.chip", { name: text.one }) : t("keys.deviceOf.chipMany", { count: text.count })}</span>
        </Chip>
    );
}

function BadgeChip({ badge }: { badge: KeyBadge }) {
    const { t, locale } = useI18n();
    switch (badge.kind) {
        case "expired":
        case "expiring": {
            const when = formatRelativeTime(badge.at, locale);
            return (
                <Chip tone={badge.kind === "expired" ? "danger" : "warning"} className={CHIP} title={new Date(badge.at).toLocaleString(locale)}>
                    <CalendarClock className={CHIP_ICON} aria-hidden />
                    <span className={CHIP_TEXT}>{badge.kind === "expired" ? t("keys.expiry.expired", { when }) : t("keys.expiry.expires", { when })}</span>
                </Chip>
            );
        }
        case "device":
            return <DeviceKeyChip tunnels={badge.names.map((name, i) => ({ id: i, name }))} />;
        case "group":
            return (
                <Chip className={CHIP} title={t("groups.key.chipTitle")}>
                    <Layers className={CHIP_ICON} aria-hidden />
                    <span className={CHIP_TEXT}>{badge.name}</span>
                </Chip>
            );
    }
}

/** 一把金鑰的籤：自己一行、可換行。/ A key's chips: their own line, wrapping. */
function KeyBadges({ badges, className }: { badges: KeyBadge[]; className?: string }) {
    if (!badges.length) return null;
    return (
        <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
            {badges.map((b) => (
                <BadgeChip key={b.kind} badge={b} />
            ))}
        </div>
    );
}

/** 整列 / 整張可點；按鈕、連結與選取文字（例如複製指紋）不算。/ The whole row / card opens the details, except buttons / links / a text selection. */
function openUnlessControl(onDetails: () => void) {
    return (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        if (window.getSelection()?.toString()) return;
        onDetails();
    };
}

function KeyActions({ name, onDetails, onDelete }: { name: string; onDetails: () => void; onDelete: () => void }) {
    const { t } = useI18n();
    return (
        <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" onClick={onDetails} aria-label={t("keys.list.detailsAria", { name })} title={t("common.details")} className="text-muted-foreground hover:text-primary">
                <PanelRightOpen />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={t("keys.list.deleteAria", { name })} title={t("common.delete")} className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive">
                <Trash2 />
            </Button>
        </div>
    );
}

interface KeyItemProps {
    keyItem: UserKey;
    placements: Placements;
    groupName: string | null;
    onDetails: () => void;
    onDelete: () => void;
}

function KeyRow({ keyItem, placements, groupName, onDetails, onDelete }: KeyItemProps) {
    const name = keyItem.host_friendly_name;
    const expiring = keyItem.expires_at ? expiryState(keyItem.expires_at) : "none";
    // 列表有自己的到期欄位（寬）/ 到期文字（窄），籤不重複放到期。/ The list shows expiry in its own field, so no expiry chip.
    const badges = keyBadges(keyItem, groupName, false);
    const note = [keyItem.comment, keyItem.description].filter(Boolean).join(" · ");
    return (
        <li
            onClick={openUnlessControl(onDetails)}
            className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 transition-colors hover:bg-muted/40 @3xl:grid-cols-(--key-cols) @3xl:items-center @3xl:px-4"
        >
            <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
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
                    <KeyBadges badges={badges} className="mt-1" />
                    {/* 註解與說明（寬才有；窄的時候在詳細資訊裡）。/ Comment and description (wide only; the details have them when narrow). */}
                    {note && (
                        <p className="mt-0.5 hidden min-w-0 text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere] @3xl:line-clamp-2" title={note}>
                            {keyItem.comment && <span className="font-mono">{keyItem.comment}</span>}
                            {keyItem.comment && keyItem.description && " · "}
                            {keyItem.description}
                        </p>
                    )}
                    {/* 窄：使用 / 裝置 / 到期一行（寬的時候各有欄位）。/ Narrow: use / devices / expiry on one line (columns when wide). */}
                    <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.75rem] text-muted-foreground @3xl:hidden">
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

            <FingerprintText keyItem={keyItem} className="hidden @3xl:flex" truncate />

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

            <KeyActions name={name} onDetails={onDetails} onDelete={onDelete} />
        </li>
    );
}

/** 指紋 + 複製。列表裡一行截斷（滑過看全部），卡片裡整串換行。/ Fingerprint + copy: one cut line in the list (hover for all), wrapped whole on cards. */
function FingerprintText({ keyItem, className, truncate = false }: { keyItem: UserKey; className?: string; truncate?: boolean }) {
    const { t } = useI18n();
    return (
        <div className={cn("min-w-0 items-center gap-0.5", className)}>
            <span
                className={cn("min-w-0 font-mono text-[0.75rem] text-muted-foreground", truncate ? "truncate" : "[overflow-wrap:anywhere]")}
                title={keyItem.fingerprint ?? ""}
            >
                {keyItem.fingerprint ?? t("keys.noFingerprint")}
            </span>
            {keyItem.fingerprint && <CopyButton value={keyItem.fingerprint} className="size-7 shrink-0" />}
        </div>
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
            style={{ "--key-cols": "minmax(0,2fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto" } as React.CSSProperties}
        >
            {/* 欄位標題只在表格排版時出現。/ Column titles only in the table layout. */}
            <div className="hidden grid-cols-(--key-cols) gap-x-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted-foreground @3xl:grid" aria-hidden>
                <span className="pl-11">{t("keys.list.colKey")}</span>
                <span>{t("keys.fingerprint")}</span>
                <span>{t("keys.lastUsed")}</span>
                <span>{t("keys.onDevices")}</span>
                <span className="w-[4.125rem]" />
            </div>
            <ul data-refresh-list className="divide-y divide-border/70">
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

const DOT: Record<DeviceState, string> = { installed: "bg-success", pending: "bg-warning", error: "bg-destructive" };

/** 卡片上的一台裝置：狀態點 + 名稱，點了開那台的金鑰面板。/ A device on a card: state dot + name; opens that device's key panel. */
function DeviceChip({ name, state, online, onOpen }: { name: string; state: DeviceState; online: boolean; onOpen: () => void }) {
    const { t } = useI18n();
    const status = t(`keys.status.${state}`);
    return (
        <button
            type="button"
            onClick={onOpen}
            title={`${name} · ${status}${online ? "" : ` · ${t("keys.card.offline")}`}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-sm bg-muted px-1.5 py-px text-xs leading-5 text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
            <span className={cn("size-1.5 shrink-0 rounded-full", DOT[state], !online && "opacity-40")} aria-hidden />
            <span className={CHIP_TEXT}>{name}</span>
            <span className="sr-only">{status}</span>
        </button>
    );
}

function CardField({ icon, label, children, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0", className)}>
            <dt className="flex items-center gap-1 text-[0.75rem] text-muted-foreground [&>svg]:size-3 [&>svg]:shrink-0">
                {icon}
                {label}
            </dt>
            <dd className="mt-0.5 min-w-0 text-xs text-foreground/85">{children}</dd>
        </div>
    );
}

function KeyCard({ keyItem, placements, groupName, onDetails, onDelete, onDevice }: KeyItemProps & { onDevice: (tunnelId: number) => void }) {
    const { t } = useI18n();
    const name = keyItem.host_friendly_name;
    // 卡片沒有到期欄位以外的醒目處，到期 / 快到期做成籤放上面。/ Cards put an expired / expiring chip up top.
    const badges = keyBadges(keyItem, groupName, true);
    const devices = cardDevices(placements.map((p) => ({ id: p.device.tunnel_id, name: p.device.host_friendly_name, online: p.device.online, state: deviceState(p.targets) })));
    const installed = placements.filter((p) => deviceState(p.targets) === "installed").length;
    return (
        <article
            onClick={openUnlessControl(onDetails)}
            className="flex min-w-0 cursor-pointer flex-col rounded-xl border border-border bg-card shadow-card transition-colors hover:border-foreground/20"
        >
            <header className="flex items-start gap-3 px-4 pt-3.5">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                    <KeyRound size={15} />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 className="min-w-0 break-words leading-snug">
                        <button
                            type="button"
                            onClick={onDetails}
                            className="rounded-sm text-left text-[0.9375rem] text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            {name}
                        </button>
                    </h3>
                    <div className="mt-1">
                        <KeyTypeBadge type={keyItem.key_type} bits={keyItem.bits} />
                    </div>
                </div>
                <div className="-mr-1.5 -mt-0.5">
                    <KeyActions name={name} onDetails={onDetails} onDelete={onDelete} />
                </div>
            </header>

            {/* 籤用整張卡的寬度（不擠在名稱與按鈕中間）。/ Chips get the card's full width (not squeezed between the name and the buttons). */}
            <KeyBadges badges={badges} className="mt-2.5 px-4" />

            {(keyItem.comment || keyItem.description) && (
                <div className="mt-2 space-y-0.5 px-4 text-xs text-muted-foreground">
                    {keyItem.comment && <p className="font-mono [overflow-wrap:anywhere]">{keyItem.comment}</p>}
                    {keyItem.description && (
                        <p className="line-clamp-2 whitespace-pre-line" title={keyItem.description}>
                            {keyItem.description}
                        </p>
                    )}
                </div>
            )}

            <div className="mx-4 mt-2.5 flex items-start gap-1.5 rounded-md bg-surface py-1 pl-2 pr-0.5 ring-1 ring-inset ring-border">
                <Fingerprint size={13} className="mt-[0.4rem] shrink-0 text-muted-foreground" aria-label={t("keys.fingerprint")} />
                <FingerprintText keyItem={keyItem} className="flex flex-1 justify-between" />
            </div>

            <dl className="mt-3 grid flex-1 grid-cols-2 content-start gap-x-4 gap-y-2.5 border-t border-border px-4 pb-3.5 pt-3">
                <CardField icon={<Clock3 />} label={t("keys.lastUsed")}>
                    <LastUsed keyItem={keyItem} />
                    {keyItem.last_used_ip && <span className="block font-mono text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere]">{keyItem.last_used_ip}</span>}
                </CardField>
                <CardField icon={<CalendarClock />} label={t("keys.expiry.label")}>
                    <KeyExpiryText expiresAt={keyItem.expires_at} />
                </CardField>
                <CardField
                    icon={<HardDrive />}
                    label={placements.length ? t("keys.list.devices", { count: placements.length, installed }) : t("keys.onDevices")}
                    className="col-span-2"
                >
                    {placements.length === 0 ? (
                        <span className="text-muted-foreground">{t("keys.onNoDevice")}</span>
                    ) : (
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                            {devices.shown.map((d) => (
                                <DeviceChip key={d.id} name={d.name} state={d.state} online={d.online} onOpen={() => onDevice(d.id)} />
                            ))}
                            {devices.more.length > 0 && (
                                <button
                                    type="button"
                                    onClick={onDetails}
                                    title={devices.more.map((d) => d.name).join(", ")}
                                    className="rounded-sm px-1 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                                >
                                    {t("keys.card.moreDevices", { count: devices.more.length })}
                                </button>
                            )}
                        </div>
                    )}
                </CardField>
            </dl>
        </article>
    );
}

/** 卡片檢視：容器寬度決定 1 / 2 / 3 欄（每頁 12 / 24 / 48 / 96 張剛好排滿）。/ Card view: 1 / 2 / 3 columns by container width. */
export function KeyCards({
    keys,
    placements,
    groupNameOf,
    onDetails,
    onDelete,
    onDevice,
}: {
    keys: UserKey[];
    placements: Map<number, Placements>;
    groupNameOf: Map<number, string>;
    onDetails: (k: UserKey) => void;
    onDelete: (k: UserKey) => void;
    /** 打開那台裝置的金鑰面板。/ Opens that device's key panel. */
    onDevice: (tunnelId: number) => void;
}) {
    return (
        <div className="@container">
            <div data-refresh-list className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
                {keys.map((k) => (
                    <KeyCard
                        key={k.id}
                        keyItem={k}
                        placements={placements.get(k.id) ?? []}
                        groupName={groupNameOf.get(k.id) ?? null}
                        onDetails={() => onDetails(k)}
                        onDelete={() => onDelete(k)}
                        onDevice={onDevice}
                    />
                ))}
            </div>
        </div>
    );
}
