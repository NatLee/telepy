/**
 * 隧道狀態與存取標籤：狀態是「小圓點 + 文字」（不是發光膠囊）——上線實心綠、降級實心琥珀、離線實心灰、從沒連過是虛線空心；
 * 擁有者 / 被分享 / 分享人數是 4px 圓角的小標籤（分享人數 hover 會列出分享給誰）。卡片與表格共用。
 * Tunnel status + access badges: a dot + plain text (no glowing pill) — online solid green, degraded solid amber,
 * offline solid grey, never connected a dashed ring; owner / shared-with-you / share-count are small chips.
 */
import React from "react";
import { CircleDot, Clock, Crown, Hourglass, Share2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { shareExpiryState } from "@/lib/shareExpiry";
import { ShareExpiryText } from "@/components/tunnels/ShareExpiry";
import { SharedWithChip } from "@/components/tunnels/SharedWithChip";
import type { TranslationKey } from "@/locales/en";
import { Tunnel, TunnelHealth } from "@/types/tunnel";
import { quiet, type RowVariant } from "@/components/tunnels/quiet";

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

/**
 * 這條隧道和「我」的關係：我的 / 別人分享給我的，以及我分享給幾個人；還有讓用的人知道的設定（錄影、要先確認）。
 * 卡片是小框（預設）；表格列是安靜的文字（`variant="text"`）：關係用內容色、設定用淡色、要你處理的（存取申請、
 * 快到期的分享）用警示色——整列只有字，沒有一排灰框。
 * How the tunnel relates to me, plus the settings people should know (recorded, confirm first). Chips on cards
 * (default); quiet text on table rows (`variant="text"`): the relation in content tone, settings faint, what needs
 * you (access requests, a share about to end) in the warning tone — words only, no row of grey boxes.
 */
export function TunnelAccessBadges({
    tunnel,
    sharedCount,
    onRequests,
    onShare,
    variant = "chip",
}: {
    tunnel: Tunnel;
    sharedCount: number;
    onRequests?: () => void;
    /** 打開分享視窗（「已分享給 N 人」浮層裡的「管理分享」）。/ Opens the share dialog ("Manage sharing" in the chip's panel). */
    onShare?: () => void;
    variant?: RowVariant;
}) {
    const { t } = useI18n();
    const text = variant === "text";
    const neutral = text ? quiet("muted") : cn(chip, "border-border bg-muted text-foreground/75");
    const expiryOk = shareExpiryState(tunnel.share_expires_at) === "ok";
    return (
        <span className={cn("inline-flex flex-wrap items-center", text ? "gap-x-2.5" : "gap-1")}>
            {tunnel.is_owner ? (
                <span className={text ? quiet("plain") : cn(chip, "border-border bg-muted text-foreground/75")}>
                    <Crown /> {t("tunnels.owner")}
                </span>
            ) : (
                <span className={text ? quiet("info") : cn(chip, "border-info/25 bg-info/10 text-info")}>
                    <Share2 /> {t("tunnels.sharedWithYou")}
                </span>
            )}
            {/* hover / 聚焦 / 點一下 = 分享給誰。/ Hover, focus or tap shows who it is shared with. */}
            {tunnel.is_owner && sharedCount > 0 && (
                <SharedWithChip
                    count={sharedCount}
                    sharees={tunnel.shared_with}
                    onManage={onShare}
                    className={neutral}
                />
            )}
            {/* 限時分享：還剩多久（一天內琥珀色）。/ Timed share: how long is left (amber within a day). */}
            {!tunnel.is_owner && tunnel.share_expires_at && (
                <span className={text ? quiet(expiryOk ? "muted" : "warning") : cn(chip, expiryOk ? "border-border bg-muted" : "border-warning/30 bg-warning/10")}>
                    <Clock className={text ? undefined : "text-muted-foreground"} /> <ShareExpiryText expiresAt={tunnel.share_expires_at} />
                </span>
            )}
            {/* owner / ADMIN：有存取申請在等，點了打開分享視窗。/ Pending access requests open the share dialog. */}
            {!!tunnel.access_requests && onRequests && (
                <button type="button" onClick={onRequests} className={text ? quiet("warning") : cn(chip, "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15")} title={t("share.request.chipHint")}>
                    <Hourglass /> {t("share.request.chip", { count: tunnel.access_requests })}
                </button>
            )}
            {/* 網頁終端機會錄影（讓用的人知道）。/ Web terminals are recorded (so people know). */}
            {tunnel.record_sessions && (
                <span className={neutral} title={t("recordings.chipHint")}>
                    <CircleDot /> {t("recordings.chip")}
                </span>
            )}
            {/* 開 session 前要確認是你。/ Sessions ask for a step-up first. */}
            {tunnel.require_step_up && (
                <span className={neutral} title={t("stepUp.chipHint")}>
                    <ShieldCheck /> {t("stepUp.chip")}
                </span>
            )}
        </span>
    );
}
