"use client";

/**
 * 「這條連線上走哪些東西」：畫面、輸入、剪貼簿、聲音、檔案五條並排的直線，左端是你的瀏覽器、右端是桌面，
 * 箭頭 = 方向；有在走的是實線（綠），自己關掉的是虛線，管理員擋掉 / 這種連法沒有的線中間打 ✕，旁邊一句為什麼。
 * 資料來自 lib/desktopStreams 的純函式。只用直線與直角。
 * The streams on this connection as five parallel straight lines between your browser and the desktop: arrows show
 * the direction, a solid line flows, a dashed one is switched off, a crossed one is blocked or not on this way.
 */
import React from "react";
import { ArrowLeft, ArrowRight, ClipboardCopy, FolderUp, Image as ImageIcon, Laptop, Monitor, MousePointer2, Volume2, X, type LucideIcon } from "lucide-react";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { streamFlows, type StreamId, type StreamRow, type StreamState } from "@/lib/desktopStreams";
import type { TranslationKey } from "@/locales/en";

const ICON: Record<StreamId, LucideIcon> = { picture: ImageIcon, input: MousePointer2, clipboard: ClipboardCopy, sound: Volume2, files: FolderUp };
const LABEL: Record<StreamId, TranslationKey> = {
    picture: "desktop.streams.picture",
    input: "desktop.streams.input",
    clipboard: "desktop.streams.clipboard",
    sound: "desktop.streams.sound",
    files: "desktop.streams.files",
};
const STATE_LABEL: Record<StreamState, TranslationKey> = {
    on: "desktop.streams.state.on",
    oneWay: "desktop.streams.state.oneWay",
    off: "desktop.streams.state.off",
    blocked: "desktop.streams.state.blocked",
    unsupported: "desktop.streams.state.unsupported",
};
const STATE_TONE: Record<StreamState, "success" | "primary" | "neutral" | "warning"> = { on: "success", oneWay: "success", off: "neutral", blocked: "warning", unsupported: "neutral" };

/** 一條直線：兩端箭頭依方向；走著 = 實線，關掉 = 虛線，擋掉 / 沒有 = 虛線 + 中間的 ✕。/ One straight line with arrowheads. */
function StreamLine({ row }: { row: StreamRow }) {
    const flows = streamFlows(row.state);
    const crossed = row.state === "blocked" || row.state === "unsupported";
    const tone = flows ? "text-success" : row.state === "blocked" ? "text-warning" : "text-muted-foreground/70";
    const left = flows && (row.dir === "toBrowser" || row.dir === "both");
    const right = flows && (row.dir === "toDesktop" || row.dir === "both");
    return (
        <span className={cn("relative flex min-w-0 flex-1 items-center", tone)} aria-hidden>
            {left ? <ArrowLeft size={14} className="-mr-1 shrink-0" /> : <span className="w-2.5 shrink-0" />}
            <span className={cn("h-0 flex-1 border-t-2", flows ? "border-current" : "border-dashed border-current")} />
            {right ? <ArrowRight size={14} className="-ml-1 shrink-0" /> : <span className="w-2.5 shrink-0" />}
            {crossed && (
                <span className="absolute left-1/2 top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-sm border border-current bg-card">
                    <X size={12} />
                </span>
            )}
        </span>
    );
}

export function DesktopStreams({ rows, connected }: { rows: StreamRow[]; connected: boolean }) {
    const { t } = useI18n();
    return (
        <section className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4" aria-label={t("desktop.streams.title")}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="text-sm text-foreground">{t("desktop.streams.title")}</h3>
                <span className="text-xs text-muted-foreground">{connected ? t("desktop.streams.nowConnected") : t("desktop.streams.nextSession")}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Laptop size={13} aria-hidden /> {t("flow.you")}</span>
                <span className="flex-1" />
                <span className="inline-flex items-center gap-1">{t("desktop.flow.deviceDesktop")} <Monitor size={13} aria-hidden /></span>
            </div>
            <ul className="space-y-2.5">
                {rows.map((r) => {
                    const Icon = ICON[r.id];
                    return (
                        <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]" data-stream={r.id} data-state={r.state}>
                            <span className="col-span-2 flex items-center gap-1.5 text-sm text-foreground sm:col-span-1">
                                <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden /> {t(LABEL[r.id])}
                            </span>
                            <StreamLine row={r} />
                            <Chip tone={STATE_TONE[r.state]}>{t(STATE_LABEL[r.state])}</Chip>
                            <span className="col-span-2 text-xs leading-snug text-muted-foreground sm:col-span-2 sm:col-start-2">{t(r.reason)}</span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
