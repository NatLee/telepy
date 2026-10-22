/**
 * 隧道狀態與存取標籤：線上 / 離線膠囊（含擴散光環）、擁有者 / 被分享 / 分享人數。卡片與表格共用。
 * Tunnel status + access badges: online / offline pill (with a ping ring) and owner / shared-with-you /
 * share-count chips. Shared by the card and the table row.
 */
import React from "react";
import { Crown, Share2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Tunnel } from "@/types/tunnel";

export function StatusDot({ online, className }: { online: boolean; className?: string }) {
    return (
        <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
            {online && <span className="absolute inline-flex size-full rounded-full bg-emerald-500 animate-status-ping" />}
            <span className={cn("relative inline-flex size-2 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/45")} />
        </span>
    );
}

export function TunnelStatusPill({ online, className }: { online: boolean; className?: string }) {
    const { t } = useI18n();
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
                online
                    ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground ring-border",
                className
            )}
        >
            <StatusDot online={online} />
            {online ? t("tunnels.online") : t("tunnels.offline")}
        </span>
    );
}

const chip = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.75rem] font-medium ring-1 ring-inset whitespace-nowrap [&>svg]:size-3";

/** 這條隧道和「我」的關係：我的 / 別人分享給我的，以及我分享給幾個人。/ How the tunnel relates to me. */
export function TunnelAccessBadges({ tunnel, sharedCount }: { tunnel: Tunnel; sharedCount: number }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {tunnel.is_owner ? (
                <span className={cn(chip, "bg-primary/8 text-primary ring-primary/20")}>
                    <Crown /> {t("tunnels.owner")}
                </span>
            ) : (
                <span className={cn(chip, "bg-info/10 text-info ring-info/25")}>
                    <Share2 /> {t("tunnels.sharedWithYou")}
                </span>
            )}
            {tunnel.is_owner && sharedCount > 0 && (
                <span className={cn(chip, "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300")} title={t("tunnels.sharedWithCount", { count: sharedCount })}>
                    <Users /> {t("tunnels.sharedWithCount", { count: sharedCount })}
                </span>
            )}
        </span>
    );
}
