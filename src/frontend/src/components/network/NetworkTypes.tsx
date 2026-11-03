"use client";

/**
 * 「網路上有什麼」：每種機器類型一條橫條（圖示、名稱、條、台數），最後是還認不出來的。點一條 = 搜尋 `type:<類型>`，
 * 再點一次取消。單一顏色、照台數排長短、數字印出來；給螢幕閱讀器的是同一份清單的文字。
 * "What's on the network": one bar per machine type (icon, name, bar, count), the unidentified ones last. A click
 * searches `type:<kind>`, a second click clears it. One colour, lengths by count, numbers printed; screen readers get
 * the same list as text.
 */
import React from "react";
import { HelpCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { DEVICE_ICON } from "@/components/network/deviceIcons";
import { kindTally, type DeviceKind, type HostIdentity } from "@/lib/lanIdentity";
import type { TranslationKey } from "@/locales/en";

export function NetworkTypes({ hosts, active, onPick }: {
    hosts: { identity?: HostIdentity | null }[];
    /** 目前搜尋裡的 `type:` 值。/ The `type:` value in the current search. */
    active: DeviceKind | null;
    onPick: (kind: DeviceKind | null) => void;
}) {
    const { t } = useI18n();
    const { kinds, unknown } = kindTally(hosts);
    if (kinds.length === 0) return null;
    const max = Math.max(unknown, ...kinds.map((k) => k.count));
    const row = (key: string, icon: React.ReactNode, label: string, count: number, pick: (() => void) | null, on: boolean) => (
        <li key={key}>
            <button
                type="button"
                disabled={!pick}
                onClick={pick ?? undefined}
                aria-pressed={pick ? on : undefined}
                className={cn(
                    "grid w-full grid-cols-[1.25rem_minmax(0,7rem)_minmax(0,1fr)_2rem] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
                    pick && "hover:bg-muted/60",
                    on && "bg-primary/8 ring-1 ring-inset ring-primary/40",
                )}
            >
                <span className="text-muted-foreground [&_svg]:size-4" aria-hidden>{icon}</span>
                <span className="truncate text-foreground">{label}</span>
                <span className="h-2 rounded-full bg-muted" aria-hidden>
                    <span className={cn("block h-2 rounded-full", pick ? "bg-primary/70" : "bg-muted-foreground/40")} style={{ width: `${Math.max(4, (count / max) * 100)}%` }} />
                </span>
                <span className="text-right tabular-nums text-muted-foreground">{count}</span>
            </button>
        </li>
    );
    return (
        <section aria-label={t("network.types.title")} className="rounded-xl border border-border bg-card p-3 shadow-card">
            <div className="mb-1.5 flex items-center justify-between gap-2 px-1.5">
                <h2 className="text-sm text-foreground">{t("network.types.title")}</h2>
                {active && (
                    <button type="button" onClick={() => onPick(null)} className="text-xs text-primary hover:underline">{t("network.types.clear")}</button>
                )}
            </div>
            <ul className="grid gap-x-4 @2xl:grid-cols-2">
                {kinds.map((k) => row(k.kind, DEVICE_ICON[k.kind], t(`network.type.${k.kind}` as TranslationKey), k.count, () => onPick(active === k.kind ? null : k.kind), active === k.kind))}
                {unknown > 0 && row("unknown", <HelpCircle />, t("network.types.unknown"), unknown, null, false)}
            </ul>
        </section>
    );
}
