/**
 * 通道詳細資訊裡的「連線紀錄」：24 小時 / 7 天在線率、最近 24 小時每小時一格的長條，以及最近幾次連線
 * （時間、多久、來源 IP——IP 只有能登入裝置的人看得到）。參考 Cloudflare Tunnel 的 connectors 與狀態頁。
 * "Connections" in the tunnel details: 24 h / 7 day uptime, one bar per hour for the last 24 hours and the latest
 * sessions (when, how long, source IP — only for people who can log in to the device).
 */
import React from "react";
import { Activity } from "lucide-react";
import { Section, Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TunnelConnections as Data } from "@/hooks/useTunnelConnections";

function barTone(v: number | null): string {
    if (v === null) return "bg-muted";
    if (v >= 0.999) return "bg-success";
    if (v <= 0.001) return "bg-destructive/70";
    return "bg-warning";
}

/** 秒 → 「3 分鐘」「2.5 小時」「4 天」（Intl 依語系翻單位）。/ Seconds → a localized duration in its largest unit. */
function duration(seconds: number, locale: string): string {
    const [value, unit] =
        seconds >= 86_400 ? [seconds / 86_400, "day"] : seconds >= 3_600 ? [seconds / 3_600, "hour"] : seconds >= 60 ? [seconds / 60, "minute"] : [seconds, "second"];
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(value);
}

export function TunnelConnectionsSection({ data, failed }: { data: Data | null; failed: boolean }) {
    const { t, locale } = useI18n();
    const pct = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(v));
    const time = (iso: string) => new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const hourLabel = (hoursAgo: number) => {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() - hoursAgo);
        return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    };

    return (
        <Section icon={<Activity />} title={t("tunnelDetails.connections")} description={t("tunnelDetails.connectionsHint")}>
            {failed ? (
                <p className="text-sm text-muted-foreground">{t("tunnelDetails.connectionsFailed")}</p>
            ) : !data ? (
                <div className="h-24 animate-pulse rounded-lg bg-surface" aria-hidden />
            ) : !data.tracked_since ? (
                <p className="rounded-lg border border-dashed border-input bg-surface px-3 py-4 text-center text-sm text-muted-foreground">{t("tunnelDetails.noHistory")}</p>
            ) : (
                <div className="space-y-4">
                    <dl className="grid grid-cols-2 gap-2">
                        {([["h24", "tunnelDetails.uptime24h"], ["d7", "tunnelDetails.uptime7d"]] as const).map(([k, label]) => (
                            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
                                <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                                <dd className="mt-0.5 font-mono text-lg tabular-nums text-foreground">{pct(data.uptime[k])}</dd>
                            </div>
                        ))}
                    </dl>

                    <div>
                        <div className="flex h-10 items-end gap-[3px]" role="img" aria-label={t("tunnelDetails.hourlyAria")}>
                            {data.hourly.map((v, i) => {
                                const hoursAgo = data.hourly.length - i;
                                const range = `${hourLabel(hoursAgo)}–${hourLabel(hoursAgo - 1)}`;
                                return (
                                    <span
                                        key={i}
                                        title={v === null ? t("tunnelDetails.hourNoData", { range }) : t("tunnelDetails.hourUp", { range, pct: pct(v) })}
                                        className="flex h-full min-w-0 flex-1 items-end rounded-[2px] bg-muted/60"
                                    >
                                        <span className={cn("w-full rounded-[2px]", barTone(v))} style={{ height: v === null ? "100%" : `${Math.max(v, 0.08) * 100}%` }} />
                                    </span>
                                );
                            })}
                        </div>
                        <div className="mt-1 flex justify-between text-[0.75rem] text-muted-foreground">
                            <span>{t("tunnelDetails.hoursAgo")}</span>
                            <span>{t("tunnelDetails.now")}</span>
                        </div>
                    </div>

                    <div>
                        <p className="mb-1.5 text-xs text-muted-foreground">{t("tunnelDetails.latestConnections")}</p>
                        <ul className="divide-y divide-border rounded-lg border border-border">
                            {data.sessions.map((s) => (
                                <li key={s.connected_at} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                    <span className="tabular-nums text-foreground">{time(s.connected_at)}</span>
                                    {s.disconnected_at ? (
                                        <span className="text-muted-foreground">{s.seconds !== null ? duration(s.seconds, locale) : "—"}</span>
                                    ) : (
                                        <Chip tone="success">{t("tunnelDetails.connectedNow")}</Chip>
                                    )}
                                    {s.ip && <span className="ml-auto font-mono text-xs text-muted-foreground">{s.ip}</span>}
                                </li>
                            ))}
                        </ul>
                        <p className="mt-1.5 text-xs text-muted-foreground">{t("tunnelDetails.trackingSince", { date: time(data.tracked_since) })}</p>
                    </div>
                </div>
            )}
        </Section>
    );
}
