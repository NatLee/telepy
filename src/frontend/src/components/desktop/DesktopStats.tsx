"use client";

/**
 * 工具列的延遲 / 串流狀態按鈕：訊號格 + 畫面往返 ms + 狀態字，點開是每一段的數字（畫面往返、網路往返、隧道、
 * fps、流量、落後幀）、解析度與縮放，以及「延遲主要在哪一段」。數字來自中繼每秒的 `telepy-stats`。
 * The toolbar's latency / stream button: signal bars, the frame round trip and a health word; the popover breaks
 * it down per hop with resolution, scale and where the delay sits. Numbers come from the relay's per-second stats.
 */
import React from "react";
import { Activity } from "lucide-react";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Property, PropertyList } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatMs, formatRate, laggingHop, streamHealth, type StreamHealth, type StreamStats } from "@/lib/desktopStats";
import type { Framebuffer, Viewport } from "@/lib/desktopScreens";
import type { TranslationKey } from "@/locales/en";

const HEALTH_KEY: Record<StreamHealth, TranslationKey> = {
    live: "desktop.stats.health.live",
    slow: "desktop.stats.health.slow",
    stalled: "desktop.stats.health.stalled",
    idle: "desktop.stats.health.idle",
};

const HEALTH_DOT: Record<StreamHealth, string> = {
    live: "bg-success",
    slow: "bg-warning",
    stalled: "bg-destructive",
    idle: "bg-muted-foreground/50",
};

export function DesktopStatsButton({ stats, unstable, now, framebuffer, viewport, scale, engine = "guacd" }: {
    stats: StreamStats | null;
    unstable: boolean;
    /** 每秒 tick 的現在時間（判斷統計有沒有停）。/ Ticks every second so stale stats show as stalled. */
    now: number;
    framebuffer: Framebuffer | null;
    viewport: Viewport | null;
    /** 顯示比例（1 = 1:1）。/ Display scale. */
    scale: number | null;
    /** guacd（中繼量的畫面往返）或 RustDesk（核心自己量的往返，沒有畫面往返 / 待畫幀）。/ Which engine the numbers come from. */
    engine?: "guacd" | "rustdesk";
}) {
    const { t } = useI18n();
    const rd = engine === "rustdesk";
    const health = streamHealth(stats, unstable, now);
    const where = stats ? laggingHop(stats) : null;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2 text-xs text-foreground hover:bg-muted"
                    aria-label={t("desktop.stats.button")}
                    title={t("desktop.stats.button")}
                >
                    <LatencyIndicator rttMs={rd ? stats?.netMs ?? null : stats?.frameMs ?? null} online={health !== "stalled"} size="xs" withTooltip={false} reserveWidth />
                    <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-1.5 rounded-full", HEALTH_DOT[health])} aria-hidden />
                        <span className={cn("hidden md:inline", health === "stalled" ? "text-destructive" : health === "slow" ? "text-warning" : "text-muted-foreground")}>{t(HEALTH_KEY[health])}</span>
                    </span>
                    {stats && health !== "stalled" && <span className="hidden font-mono tabular-nums text-muted-foreground lg:inline">{stats.fps} fps</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] space-y-3 p-3">
                <div className="flex items-center gap-2 text-sm text-foreground">
                    <Activity size={15} className="text-muted-foreground" aria-hidden />
                    <span>{t("desktop.stats.title")}</span>
                    <span className="flex-1" />
                    <span className={cn("inline-flex items-center gap-1.5 text-xs", health === "stalled" ? "text-destructive" : health === "slow" ? "text-warning" : "text-muted-foreground")}>
                        <span className={cn("size-1.5 rounded-full", HEALTH_DOT[health])} aria-hidden />
                        {t(HEALTH_KEY[health])}
                    </span>
                </div>
                {stats ? (
                    <>
                        <PropertyList className="px-3">
                            {!rd && (
                                <Property label={<Label title={t("desktop.stats.frame")} hint={t("desktop.stats.frameHint")} />} mono>
                                    <LatencyIndicator rttMs={stats.frameMs} size="xs" withTooltip={false} />
                                </Property>
                            )}
                            <Property label={<Label title={t("desktop.stats.net")} hint={t(rd ? "desktop.stats.netHintRd" : "desktop.stats.netHint")} />} mono>
                                <LatencyIndicator rttMs={stats.netMs} size="xs" withTooltip={false} />
                            </Property>
                            <Property label={<Label title={t("desktop.stats.tunnel")} hint={t("desktop.stats.tunnelHint")} />} mono>
                                <LatencyIndicator rttMs={stats.tunnelMs} size="xs" withTooltip={false} />
                            </Property>
                            <Property label={t("desktop.stats.fps")} mono>{stats.fps}</Property>
                            <Property label={t("desktop.stats.down")} mono>{formatRate(stats.downBps)}</Property>
                            {stats.audioBps != null && <Property label={t("desktop.stats.sound")} mono>{formatRate(stats.audioBps)}</Property>}
                            <Property label={t("desktop.stats.up")} mono>{formatRate(stats.upBps)}</Property>
                            {!rd && (
                                <Property label={<Label title={t("desktop.stats.behind")} hint={t("desktop.stats.behindHint")} />} mono>
                                    <span className={stats.behind >= 3 ? "text-warning" : undefined}>{stats.behind}</span>
                                    {stats.merged > 1 && <span className="ml-2 text-xs text-warning">{t("desktop.stats.merged", { n: stats.merged })}</span>}
                                </Property>
                            )}
                            {framebuffer && (
                                <Property label={t("desktop.stats.resolution")} mono>
                                    {framebuffer.width}×{framebuffer.height}
                                    {viewport && <span className="text-muted-foreground"> → {viewport.width}×{viewport.height}</span>}
                                    {scale !== null && <span className="ml-2 text-xs text-muted-foreground">{t("desktop.stats.scale", { pct: Math.round(scale * 100) })}</span>}
                                </Property>
                            )}
                        </PropertyList>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            {rd && `${t("desktop.stats.rdNote")} `}
                            {where === "web" && t("desktop.stats.where.web")}
                            {where === "tunnel" && t("desktop.stats.where.tunnel")}
                            {where === "browser" && t("desktop.stats.where.browser")}
                            {where === null && (health === "stalled" ? t("desktop.stats.where.stalled") : t("desktop.stats.where.fine"))}
                            {" "}
                            {formatMs(stats.frameMs) !== "—" && (where === "tunnel" || where === "web") && t("desktop.stats.tipSpeed")}
                        </p>
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("desktop.stats.noData")}</p>
                )}
            </PopoverContent>
        </Popover>
    );
}

function Label({ title, hint }: { title: string; hint: string }) {
    return (
        <span className="block">
            {title}
            <span className="block text-xs leading-snug text-muted-foreground/80">{hint}</span>
        </span>
    );
}
