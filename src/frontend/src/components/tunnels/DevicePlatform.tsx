"use client";

/**
 * 裝置平台的小圖示、卡片上的 OS 標籤與「SSH / SSH over WSS」連線方式標籤。圖示是 `lib/platformArt.ts` 的像素圖，
 * 畫在固定的淺色小磚上（深色主題也一樣，黑色的企鵝才看得到）。
 * The platform pixel icon, the card's OS chip and the "SSH / SSH over WSS" way-in badge. Icons sit on a fixed light tile in
 * both themes so dark pixels (the penguin) stay visible.
 */
import React, { useState } from "react";
import { ArrowRightLeft, Globe, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { platformOf, shortOs, wayInOf, type PlatformId, type Via, type WayInState } from "@/lib/devicePlatforms";
import { PLATFORM_ART, pixelRuns } from "@/lib/platformArt";
import type { TranslationKey } from "@/locales/en";
import type { Tunnel, TunnelEndpoint } from "@/types/tunnel";
import { useHttps } from "@/components/tunnels/TransportVisibility";
import { quiet, type RowVariant } from "@/components/tunnels/quiet";

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
export function DeviceOsChip({ endpoint, onOpen, variant = "chip", className }: { endpoint?: TunnelEndpoint | null; onOpen?: () => void; variant?: RowVariant; className?: string }) {
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
            className={cn(
                variant === "text"
                    ? quiet(endpoint.live ? "plain" : "muted")
                    : cn(CHIP, endpoint.live ? "border-border bg-muted text-foreground/80 hover:border-foreground/30 hover:text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground"),
                className
            )}
        >
            <PlatformIcon id={id} size={14} />
            <span className="truncate">{name}</span>
        </button>
    );
}

const VIA_LABEL: Record<Via, TranslationKey> = { ssh: "platforms.via.ssh", wss: "platforms.via.wss", ws: "platforms.via.ws" };
const VIA_TITLE: Record<Via, TranslationKey> = { ssh: "platforms.via.sshTitle", wss: "platforms.via.wssTitle", ws: "platforms.via.wsTitle" };
const STATE_TEXT: Record<WayInState, TranslationKey> = { live: "platforms.via.stateLive", last: "platforms.via.stateLast", setup: "platforms.via.stateSetup" };

/**
 * 裝置怎麼連 Telepy：「SSH」（SSH port）或「SSH over WSS」（網頁 port，SSH 包在 WebSocket 裡；Telepy 走 http 時是 WS）。
 * 連著 = 實心；離線（最後一次的方式）或還沒連過（加進來時設定的方式）= 虛線。實際走的跟設定的不同時多一個 ⇄。
 * How the device reaches Telepy: "SSH" (the SSH port) or "SSH over WSS" (the web port, SSH inside a WebSocket; WS when
 * Telepy is on http). Solid while connected; dashed when offline (the last way) or not connected yet (how it was set
 * up). A ⇄ marks a device that came in another way than it was set up for.
 */
export function TransportBadge({ tunnel, variant = "chip", className }: { tunnel: Pick<Tunnel, "way_in" | "endpoint">; variant?: RowVariant; className?: string }) {
    const { t } = useI18n();
    const https = useHttps();
    const [open, setOpen] = useState(false);
    const way = wayInOf(tunnel, https);
    if (!way) return null;
    const label = t(VIA_LABEL[way.via]);
    const lines = [t(VIA_TITLE[way.via]), t(STATE_TEXT[way.state]), way.auto ? t("platforms.via.auto") : null, way.setup ? t("platforms.via.setupDiffers", { way: t(VIA_LABEL[way.setup]) }) : null].filter((l): l is string => !!l);
    const Icon = way.via === "ssh" ? KeyRound : Globe;
    // 滑鼠停著看 title；點一下（觸控也行）開一個小說明。/ Hover shows the title; a click (touch too) opens a short note.
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title={open ? undefined : lines.join("\n")}
                    aria-label={t("platforms.via.aria", { way: label })}
                    className={cn(
                        // 表格列：安靜的等寬文字（網頁 port 的方式維持 info 色，離線 / 還沒連過淡一點）。/ Table rows: quiet mono text.
                        variant === "text"
                            ? quiet(way.state !== "live" ? "muted" : way.via !== "ssh" ? "info" : "plain", "font-mono")
                            : cn(
                                  CHIP,
                                  "font-mono [&>svg]:size-3 [&>svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                  way.state === "live"
                                      ? way.via !== "ssh"
                                          ? "border-info/40 bg-info/10 text-info hover:border-info/70"
                                          : "border-border bg-muted text-foreground/80 hover:border-foreground/30 hover:text-foreground"
                                      : "border-dashed border-border/70 text-muted-foreground hover:text-foreground"
                              ),
                        className
                    )}
                >
                    <Icon aria-hidden />
                    {label}
                    {way.setup && <ArrowRightLeft aria-hidden />}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-1.5 p-3 text-xs leading-relaxed">
                <p className="flex items-center gap-1.5 font-mono text-sm text-foreground [&>svg]:size-3.5">
                    <Icon aria-hidden />
                    {label}
                </p>
                {lines.map((l) => (
                    <p key={l} className="text-muted-foreground">
                        {l}
                    </p>
                ))}
            </PopoverContent>
        </Popover>
    );
}
