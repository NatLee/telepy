"use client";

/**
 * 定時重掃的時間線：一條直線，上次（實心）─ 現在（直立的短線）─ 接下來幾次（空心圈），標籤放得下才寫（`lanSchedule.labelled`），
 * 每個點滑過都看得到時間。
 * The rescan timeline: one straight line, the last run (filled) ─ now (an upright tick) ─ the next runs (rings); a label
 * only where it fits (`lanSchedule.labelled`), every point shows its time on hover.
 */
import React from "react";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { labelled, timeline } from "@/lib/lanSchedule";
import { cn } from "@/lib/utils";

export function ScheduleTimeline({ lastAt, nextAt, everySecs, now, className }: { lastAt: string | null; nextAt: string; everySecs: number; now: number; className?: string }) {
    const { t, locale } = useI18n();
    const points = timeline(lastAt, nextAt, everySecs, now, 3);
    if (points.length === 0) return null;
    const show = labelled(points);
    const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const label = (kind: string, time: number) =>
        kind === "now" ? t("network.schedule.now") : kind === "last" ? t("network.schedule.lastRun", { when: formatRelativeTime(new Date(time).toISOString(), locale, now) }) : formatRelativeTime(new Date(time).toISOString(), locale, now);
    return (
        <div className={cn("px-2 pb-7 pt-2", className)} role="img" aria-label={points.map((p) => `${label(p.kind, p.time)} (${fmt.format(new Date(p.time))})`).join(", ")}>
            <div className="relative h-4">
                <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                {points.map((p, i) => {
                    const edge = p.at < 0.08 ? "left" : p.at > 0.92 ? "right" : "center";
                    return (
                        <span key={`${p.kind}-${i}`} className="absolute top-1/2 -translate-y-1/2" style={{ left: `${p.at * 100}%` }} title={`${label(p.kind, p.time)} · ${fmt.format(new Date(p.time))}`}>
                            {p.kind === "now" ? (
                                <span aria-hidden className="block h-4 w-0.5 -translate-x-1/2 rounded-full bg-primary" />
                            ) : (
                                <span aria-hidden className={cn("block size-3 -translate-x-1/2 rounded-full border-2", p.kind === "last" ? "border-muted-foreground bg-muted-foreground" : "border-success bg-card")} />
                            )}
                            {show[i] && (
                                <span
                                    className={cn(
                                        "absolute top-5 whitespace-nowrap text-[0.6875rem] leading-tight",
                                        p.kind === "now" ? "text-primary" : p.kind === "last" ? "text-muted-foreground" : "text-foreground/80",
                                        edge === "left" ? "left-0 -translate-x-1.5" : edge === "right" ? "right-0 translate-x-1.5" : "left-0 -translate-x-1/2"
                                    )}
                                >
                                    {label(p.kind, p.time)}
                                </span>
                            )}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}
