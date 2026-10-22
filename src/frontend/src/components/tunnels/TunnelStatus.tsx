/**
 * 隧道狀態與存取標籤：線上 / 離線是「實色小圓點 + 文字」（不是發光膠囊），擁有者 / 被分享 / 分享人數是 4px 圓角的小標籤。
 * 卡片與表格共用。
 * Tunnel status + access badges: online / offline is a solid dot + plain text (no glowing pill); owner /
 * shared-with-you / share-count are small square-ish chips. Shared by the card and the table row.
 */
import React from "react";
import { Crown, Share2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Tunnel } from "@/types/tunnel";

export function StatusDot({ online, className }: { online: boolean; className?: string }) {
    return (
        <span
            className={cn("inline-flex size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/40", className)}
            aria-hidden
        />
    );
}

export function TunnelStatusPill({ online, className }: { online: boolean; className?: string }) {
    const { t } = useI18n();
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
                online ? "text-foreground" : "text-muted-foreground",
                className
            )}
        >
            <StatusDot online={online} />
            {online ? t("tunnels.online") : t("tunnels.offline")}
        </span>
    );
}

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
