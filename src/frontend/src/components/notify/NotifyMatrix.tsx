"use client";

/**
 * 通知矩陣：事件（照 webhook 目錄分組）× 管道（頁面提示 / 桌面通知）。
 * - `mine`：每格是結果的開關，旁邊標「跟隨網站預設」/「已覆寫」/ 🔒「強制」；有覆寫的列可以「回到預設」。
 * - `site`（管理員）：每格是網站預設，每列一個「允許使用者覆寫」開關（關 = 強制，格子固定為開）。
 * Notification matrix: events (grouped like the webhook catalogue) × channels (in-app / desktop).
 * - `mine`: each cell is the effective switch with a chip (follows the site default / overrides / enforced);
 *   rows with an override can be reset.
 * - `site` (admins): each cell is the site default; each row has a "Let people override" switch (off = enforced,
 *   the cells are then fixed on).
 */
import React from "react";
import { Lock, RotateCcw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EVENT_KEYS, GROUP_KEY, GROUP_ORDER } from "@/lib/webhooks";
import { cellChip, groupEvents, hasOverride, NOTIFY_CHANNELS, resolveNotify, type NotifyChannel, type NotifyEvent } from "@/lib/notifyPrefs";

const CHANNEL_KEY = { toast: "notifyPrefs.channel.toast", desktop: "notifyPrefs.channel.desktop" } as const;

interface MineProps {
    mode: "mine";
    events: NotifyEvent[];
    onChange: (event: NotifyEvent, channel: NotifyChannel, value: boolean | null) => void;
    onReset: (event: NotifyEvent) => void;
}

interface SiteProps {
    mode: "site";
    events: NotifyEvent[];
    onChange: (event: NotifyEvent, channel: NotifyChannel, value: boolean) => void;
    onLock: (event: NotifyEvent, locked: boolean) => void;
}

export function NotifyMatrix(props: MineProps | SiteProps) {
    const { t } = useI18n();
    const site = props.mode === "site";
    // 寬的時候是表格（欄名在上）；窄的時候每格自己帶管道名。/ A table when wide (column names on top); each cell names its channel when narrow.
    const cols = site ? "@xl:grid-cols-[minmax(0,1fr)_6rem_6rem_14rem]" : "@xl:grid-cols-[minmax(0,1fr)_10rem_10rem_6.5rem]";
    return (
        <div className="@container space-y-5">
            <div className={cn("hidden gap-3 border-b border-border pb-2 text-xs text-muted-foreground @xl:grid", cols)} aria-hidden>
                <span />
                {NOTIFY_CHANNELS.map((c) => <span key={c}>{t(CHANNEL_KEY[c])}</span>)}
                <span>{site ? t("notifyPrefs.allowOverride") : ""}</span>
            </div>
            {groupEvents(props.events, GROUP_ORDER).map((g) => (
                <section key={g.group} className="space-y-1">
                    <SectionHeading title={t(GROUP_KEY[g.group])} />
                    <ul className="divide-y divide-border">
                        {g.events.map((ev) => {
                            const keys = EVENT_KEYS[ev.event];
                            const name = keys ? t(keys.label) : ev.event;
                            return (
                                <li key={ev.event} className={cn("grid gap-x-3 gap-y-2 py-3 @xl:items-start", cols)}>
                                    <div className="min-w-0">
                                        <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                                            {name}
                                            {ev.locked && <Chip><Lock /> {t("notifyPrefs.chip.locked")}</Chip>}
                                        </p>
                                        {keys && <p className="text-xs leading-snug text-muted-foreground">{t(keys.hint)}</p>}
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 @xl:contents">
                                        {NOTIFY_CHANNELS.map((c) => (
                                            <Cell key={c} ev={ev} channel={c} name={name} {...props} />
                                        ))}
                                    </div>
                                    {props.mode === "mine" ? (
                                        <div className="@xl:text-right">
                                            {hasOverride(ev) && !ev.locked && (
                                                <Button type="button" size="sm" variant="ghost" onClick={() => props.onReset(ev)} aria-label={t("notifyPrefs.resetAria", { event: name })}>
                                                    <RotateCcw size={14} /> {t("notifyPrefs.reset")}
                                                </Button>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="min-w-0 space-y-1">
                                            <Switch size="sm" checked={!ev.locked} onCheckedChange={(on) => props.onLock(ev, !on)} aria-label={`${name}: ${t("notifyPrefs.allowOverride")}`}>
                                                <span className="text-sm text-foreground @xl:sr-only">{t("notifyPrefs.allowOverride")}</span>
                                            </Switch>
                                            {ev.locked ? (
                                                <p className="flex items-start gap-1 text-xs leading-snug text-muted-foreground">
                                                    <Lock size={12} className="mt-0.5 shrink-0" aria-hidden /> {t("notifyPrefs.enforcedHint")}
                                                </p>
                                            ) : (
                                                <p className="text-xs leading-snug text-muted-foreground">{t("notifyPrefs.allowOverrideHint")}</p>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function Cell(props: (MineProps | SiteProps) & { ev: NotifyEvent; channel: NotifyChannel; name: string }) {
    const { t } = useI18n();
    const { ev, channel, name } = props;
    const channelName = t(CHANNEL_KEY[channel]);
    const label = <span className="text-xs text-muted-foreground @xl:hidden">{channelName}</span>;
    if (!ev.channels.includes(channel)) {
        return (
            <div className="flex flex-col items-start gap-1" title={t("notifyPrefs.noChannelHint", { channel: channelName })}>
                {label}
                <span className="text-sm text-muted-foreground">—</span>
                <span className="sr-only">{t("notifyPrefs.noChannelHint", { channel: channelName })}</span>
            </div>
        );
    }
    if (props.mode === "site") {
        const v = ev.site[channel];
        return (
            <div className="flex flex-col items-start gap-1">
                {label}
                <Switch
                    size="sm"
                    checked={ev.locked || v !== false}
                    disabled={ev.locked}
                    onCheckedChange={(on) => props.onChange(ev, channel, on)}
                    aria-label={t("notifyPrefs.siteValueAria", { event: name, channel: channelName })}
                />
            </div>
        );
    }
    const { on } = resolveNotify(ev, channel);
    const chip = cellChip(ev, channel);
    return (
        <div className="flex flex-col items-start gap-1">
            {label}
            <Switch
                size="sm"
                checked={on}
                disabled={ev.locked}
                onCheckedChange={(next) => {
                    // 回到跟網站一樣的值 = 不再覆寫。/ Matching the site value again = no override.
                    const siteOn = ev.site[channel] !== false;
                    props.onChange(ev, channel, next === siteOn ? null : next);
                }}
                aria-label={t("notifyPrefs.cellAria", { event: name, channel: channelName })}
            />
            {chip === "locked" ? (
                <span className="sr-only">{t("notifyPrefs.lockedHint")}</span>
            ) : (
                <Chip tone={chip === "overrides" ? "primary" : "neutral"} title={chip === "overrides" ? undefined : t("notifyPrefs.chip.follows")}>
                    {t(chip === "overrides" ? "notifyPrefs.chip.overrides" : "notifyPrefs.chip.follows")}
                </Chip>
            )}
        </div>
    );
}
