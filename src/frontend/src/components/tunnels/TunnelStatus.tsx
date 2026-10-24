/**
 * 隧道狀態與存取標籤：狀態是「小圓點 + 文字」（不是發光膠囊）——上線實心綠、降級實心琥珀、離線實心灰、從沒連過是虛線空心；
 * 擁有者 / 被分享 / 分享人數是 4px 圓角的小標籤。卡片與表格共用。
 * Tunnel status + access badges: a dot + plain text (no glowing pill) — online solid green, degraded solid amber,
 * offline solid grey, never connected a dashed ring; owner / shared-with-you / share-count are small chips.
 */
import React from "react";
import { Crown, Share2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { TranslationKey } from "@/locales/en";
import { Tunnel, TunnelHealth } from "@/types/tunnel";

const DOT: Record<TunnelHealth, string> = {
    online: "bg-success",
    degraded: "bg-warning",
    offline: "bg-muted-foreground/40",
    never: "border border-dashed border-muted-foreground/70",
};

const LABEL: Record<TunnelHealth, TranslationKey> = {
    online: "tunnels.online",
    degraded: "tunnels.degraded",
    offline: "tunnels.offline",
    never: "tunnels.never",
};

/** `health` 優先；只給 `online` 時是兩態（指令速查的裝置選單用）。/ `health` wins; `online` alone gives two states. */
export function StatusDot({ online, health, className }: { online?: boolean; health?: TunnelHealth; className?: string }) {
    const h = health ?? (online ? "online" : "offline");
    return <span className={cn("inline-flex size-2 shrink-0 rounded-full", DOT[h], className)} aria-hidden />;
}

export function TunnelStatusPill({ health, lastSeenAt, className }: { health: TunnelHealth; lastSeenAt?: string | null; className?: string }) {
    const { t, locale } = useI18n();
    const hint =
        health === "degraded"
            ? t("tunnels.degradedHint")
            : health === "never"
                ? t("tunnels.neverHint")
                : health === "offline" && lastSeenAt
                    ? t("tunnels.lastSeen", { time: formatRelativeTime(lastSeenAt, locale) })
                    : undefined;
    return (
        <span
            title={hint}
            className={cn(
                "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
                health === "online" ? "text-foreground" : health === "degraded" ? "text-warning" : "text-muted-foreground",
                className
            )}
        >
            <StatusDot health={health} />
            {t(LABEL[health])}
        </span>
    );
}

/** 離線隧道的「最後上線 3 小時前」。/ "Last seen 3 hours ago" for an offline tunnel. */
export function TunnelLastSeen({ at, className }: { at?: string | null; className?: string }) {
    const { t, locale } = useI18n();
    if (!at) return null;
    return (
        <span className={cn("text-[0.75rem] text-muted-foreground whitespace-nowrap", className)} title={new Date(at).toLocaleString(locale)}>
            {t("tunnels.lastSeen", { time: formatRelativeTime(at, locale, undefined, "short") })}
        </span>
    );
}

/** 卡片 / 表格左邊的伺服器圖示方塊顏色。/ Colour of the server icon tile on the card / row. */
export const HEALTH_TILE: Record<TunnelHealth, string> = {
    online: "border-success/25 bg-success/10 text-success",
    degraded: "border-warning/30 bg-warning/10 text-warning",
    offline: "border-border bg-surface text-muted-foreground",
    never: "border-dashed border-input bg-surface text-muted-foreground",
};

const chip = "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[0.75rem] whitespace-nowrap [&>svg]:size-3";

/** 這條隧道和「我」的關係：我的 / 別人分享給我的，以及我分享給幾個人。/ How the tunnel relates to me. */
export function TunnelAccessBadges({ tunnel, sharedCount }: { tunnel: Tunnel; sharedCount: number }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {tunnel.is_owner ? (
                <span className={cn(chip, "border-border bg-muted text-foreground/75")}>
                    <Crown /> {t("tunnels.owner")}
                </span>
            ) : (
                <span className={cn(chip, "border-info/25 bg-info/10 text-info")}>
                    <Share2 /> {t("tunnels.sharedWithYou")}
                </span>
            )}
            {tunnel.is_owner && sharedCount > 0 && (
                <span className={cn(chip, "border-border bg-muted text-foreground/75")} title={t("tunnels.sharedWithCount", { count: sharedCount })}>
                    <Users /> {t("tunnels.sharedWithCount", { count: sharedCount })}
                </span>
            )}
        </span>
    );
}
