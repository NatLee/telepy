"use client";

/**
 * 裝置平台的小圖示、卡片上的 OS 標籤與「SSH / HTTP」連線方式標籤。圖示是 `lib/platformArt.ts` 的像素圖，
 * 畫在固定的淺色小磚上（深色主題也一樣，黑色的企鵝才看得到）。
 * The platform pixel icon, the card's OS chip and the SSH / HTTP way-in badge. Icons sit on a fixed light tile in
 * both themes so dark pixels (the penguin) stay visible.
 */
import React from "react";
import { Globe, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { platformOf, shortOs, viaOf, type PlatformId } from "@/lib/devicePlatforms";
import { PLATFORM_ART, pixelRuns } from "@/lib/platformArt";
import type { TranslationKey } from "@/locales/en";
import type { TunnelEndpoint } from "@/types/tunnel";

export const PLATFORM_NAME: Record<PlatformId, TranslationKey> = {
    linux: "platforms.name.linux",
    macos: "platforms.name.macos",
    raspberrypi: "platforms.name.raspberrypi",
    openwrt: "platforms.name.openwrt",
    windows: "platforms.name.windows",
    docker: "platforms.name.docker",
    unix: "platforms.name.unix",
};

/** 像素圖示；`size` = 小磚的邊長（px）。/ The pixel icon; `size` is the tile's side in px. */
export function PlatformIcon({ id, size = 16, className }: { id: PlatformId; size?: number; className?: string }) {
    const art = PLATFORM_ART[id];
    const w = art.rows[0].length;
    const h = art.rows.length;
    return (
        <span
            aria-hidden
            className={cn("inline-grid shrink-0 place-items-center rounded-[3px] border border-black/10 bg-[#f6f3ee] dark:border-white/10", className)}
            style={{ width: size, height: size }}
        >
            <svg viewBox={`0 0 ${w} ${h}`} width={size * 0.78} height={size * 0.78} shapeRendering="crispEdges">
                {pixelRuns(art).map((r, i) => (
                    <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
                ))}
            </svg>
        </span>
    );
}

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-px text-[0.75rem] whitespace-nowrap transition-colors";

/**
 * 裝置的作業系統（每天一次的裝置資訊讀到的）；點一下開詳情的「裝置」分頁。沒讀到就不顯示。
 * The device's OS from the daily device facts; a click opens the details' Device tab. Hidden until read.
 */
export function DeviceOsChip({ endpoint, onOpen, className }: { endpoint?: TunnelEndpoint | null; onOpen?: () => void; className?: string }) {
    const { t, locale } = useI18n();
    const facts = endpoint?.facts;
    const id = platformOf(facts);
    if (!endpoint || !facts || !id) return null;
    const name = shortOs(facts.os) ?? t(PLATFORM_NAME[id]);
    const title = [
        facts.os ?? t(PLATFORM_NAME[id]),
        [facts.kernel, facts.arch].filter(Boolean).join(" · ") || null,
        endpoint.facts_at ? t("platforms.osChecked", { time: formatRelativeTime(endpoint.facts_at, locale) }) : null,
    ]
        .filter(Boolean)
        .join("\n");
    return (
        <button
            type="button"
            onClick={onOpen}
            title={title}
            aria-label={t("platforms.osAria", { os: facts.os ?? name })}
            className={cn(CHIP, endpoint.live ? "border-border bg-muted text-foreground/80 hover:border-foreground/30 hover:text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground", className)}
        >
            <PlatformIcon id={id} size={14} />
            <span className="truncate">{name}</span>
        </button>
    );
}

/**
 * 裝置怎麼連 Telepy：SSH（直接連 SSH port）或 HTTP（網頁 port，SSH 包在 WebSocket 裡）。離線時是最後一次的方式。
 * How the device reaches Telepy: SSH (the SSH port) or HTTP (the web port, SSH inside a WebSocket); offline = the last time.
 */
export function TransportBadge({ endpoint, className }: { endpoint?: TunnelEndpoint | null; className?: string }) {
    const { t } = useI18n();
    const via = viaOf(endpoint);
    if (!endpoint || !via) return null;
    const explain = t(via === "ssh" ? "platforms.via.sshTitle" : "platforms.via.httpTitle");
    const title = endpoint.live ? explain : t("platforms.via.last", { text: explain });
    const Icon = via === "ssh" ? KeyRound : Globe;
    return (
        <span
            title={title}
            aria-label={title}
            className={cn(
                CHIP,
                "font-mono [&>svg]:size-3 [&>svg]:shrink-0",
                endpoint.live ? (via === "http" ? "border-info/40 bg-info/10 text-info" : "border-border bg-muted text-foreground/80") : "border-dashed border-border/70 text-muted-foreground",
                className
            )}
        >
            <Icon aria-hidden />
            {t(via === "ssh" ? "platforms.via.ssh" : "platforms.via.http")}
        </span>
    );
}
