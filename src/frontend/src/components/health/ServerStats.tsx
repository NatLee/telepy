/**
 * 伺服器健康頁「總覽」的即時狀態：版本與運作時間、通道狀態長條、目前的連線階段、帳號、儲存空間、Webhook，
 * 以及最近 24 小時三張每小時長條圖。資料來自 `GET /api/site/health/stats`；舊的後端（404）整塊不畫。
 * Live status on the Server health page's Overview: version + uptime, the tunnel status bar, live sessions,
 * accounts, storage, webhooks and three hourly charts for the last 24 hours. Data from `GET /api/site/health/stats`;
 * an older backend (404) renders nothing.
 */
import React, { useMemo } from "react";
import { Gauge } from "lucide-react";
import { Section } from "@/components/ui/section";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { StatsHourlyChart } from "@/components/health/StatsHourlyChart";
import { useServerStats } from "@/hooks/useServerStats";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import {
    LOW_DISK,
    diskFree,
    formatBytes,
    formatUptime,
    hourBars,
    isQuiet,
    sessionKinds,
    tunnelSegments,
    type ServerStats as Stats,
    type TunnelState,
} from "@/lib/serverStats";

const STATE_LABEL: Record<TunnelState, TranslationKey> = {
    online: "tunnels.online",
    degraded: "tunnels.degraded",
    offline: "tunnels.offline",
    never: "tunnels.never",
};

const SEGMENT: Record<TunnelState, string> = {
    online: "bg-success",
    degraded: "bg-warning",
    offline: "bg-muted-foreground/40",
    never: "border border-dashed border-muted-foreground/70",
};

function Tile({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0 rounded-xl border border-border bg-card p-4", className)}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <div className="mt-1 min-w-0 break-words">{children}</div>
        </div>
    );
}

function Value({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
    return (
        <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl text-foreground">{children}</span>
            {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
        </p>
    );
}

/** 標籤 : 數字 的小清單。/ A small label : number list. */
function Rows({ rows }: { rows: [React.ReactNode, React.ReactNode, string?][] }) {
    if (!rows.length) return null;
    return (
        <dl className="mt-3 space-y-1 text-sm">
            {rows.map(([label, value, tone], i) => (
                <div key={i} className="flex items-baseline justify-between gap-3">
                    <dt className="min-w-0 text-muted-foreground">{label}</dt>
                    <dd className={cn("shrink-0 tabular-nums text-foreground", tone)}>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function ServerStats({ reloadKey }: { reloadKey: number }) {
    const { t } = useI18n();
    const { stats, loading, failed, missing } = useServerStats(reloadKey);
    if (missing) return null;

    return (
        <Section icon={<Gauge />} title={t("health.stats.title")} description={t("health.stats.description")}>
            {!stats ? (
                loading ? (
                    <div className="@container" aria-busy="true" aria-label={t("health.stats.loading")}>
                        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
                            {Array.from({ length: 6 }, (_, i) => (
                                <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-surface" />
                            ))}
                        </div>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("health.stats.failed")}</p>
                )
            ) : (
                <>
                    {failed && <p className="text-sm text-muted-foreground">{t("health.stats.staleFailed")}</p>}
                    <StatsBody stats={stats} />
                </>
            )}
        </Section>
    );
}

function StatsBody({ stats }: { stats: Stats }) {
    const { t, locale } = useI18n();
    const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
    const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : nf.format(v));
    const bytes = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatBytes(v, locale));
    const date = (iso: string) => new Date(iso).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    const { server, tunnels, gateway, sessions, users, storage, activity, webhooks } = stats;

    // 運作時間：優先用後端給的秒數，否則用後端的現在 − 啟動時間。/ Uptime: the backend's seconds, else its now − start time.
    const uptime =
        server?.uptime_secs ??
        (server?.started_at && server.now ? Math.max(0, (Date.parse(server.now) - Date.parse(server.started_at)) / 1000) || null : null);

    const segments = tunnels ? tunnelSegments(tunnels) : [];
    const free = diskFree(storage?.data_dir);
    const low = free !== null && free < LOW_DISK;
    const pct = (v: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(v);

    const charts = activity
        ? ([
            ["gatewayEvents", "gatewayOk", "gatewayProblems", hourBars(activity.gateway_events, activity.gateway_problems)],
            ["signIns", "signInsOk", "signInsFailed", hourBars(activity.sign_ins, activity.sign_ins_failed)],
            ["apiCalls", "apiOk", "apiErrors", hourBars(activity.api_calls, activity.api_errors)],
        ] as const).filter(([, , , bars]) => bars !== null)
        : [];

    return (
        <div className="@container space-y-5">
            <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
                {server && (
                    <Tile label={t("health.stats.version")}>
                        {/* 本機建的映像沒有版本號：那就把運作時間當主值。/ Locally built images carry no version: uptime becomes the headline. */}
                        {server.version ? (
                            <>
                                <Value>{server.version}</Value>
                                {uptime !== null && <p className="mt-1 text-sm text-foreground">{t("health.stats.upFor", { time: formatUptime(uptime, locale) })}</p>}
                            </>
                        ) : (
                            uptime !== null && <Value>{t("health.stats.upFor", { time: formatUptime(uptime, locale) })}</Value>
                        )}
                        {server.started_at && <p className="text-xs text-muted-foreground">{t("health.stats.since", { date: date(server.started_at) })}</p>}
                    </Tile>
                )}

                {tunnels && (
                    <Tile label={t("health.stats.tunnels")}>
                        <Value sub={tunnels.total !== null ? t("health.stats.tunnelsTotal", { n: n(tunnels.total) }) : undefined}>
                            {n(tunnels.online)} <span className="text-base text-muted-foreground">{t("tunnels.online")}</span>
                        </Value>
                        {segments.length ? (
                            <>
                                <div
                                    role="img"
                                    aria-label={t("health.stats.tunnelBar", {
                                        online: n(tunnels.online ?? 0),
                                        degraded: n(tunnels.degraded ?? 0),
                                        offline: n(tunnels.offline ?? 0),
                                        never: n(tunnels.never ?? 0),
                                    })}
                                    className="mt-3 flex h-2.5 gap-[2px]"
                                >
                                    {segments.map((s, i) => (
                                        <span
                                            key={s.state}
                                            className={cn("min-w-1.5", SEGMENT[s.state], i === 0 && "rounded-l-full", i === segments.length - 1 && "rounded-r-full")}
                                            style={{ width: `${s.pct}%` }}
                                            title={`${t(STATE_LABEL[s.state])}: ${n(s.count)}`}
                                        />
                                    ))}
                                </div>
                                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    {(["online", "degraded", "offline", "never"] as const).map((state) =>
                                        tunnels[state] === null ? null : (
                                            <li key={state} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                                <StatusDot health={state} />
                                                {t(STATE_LABEL[state])}
                                                <span className="tabular-nums text-foreground">{n(tunnels[state])}</span>
                                            </li>
                                        )
                                    )}
                                </ul>
                            </>
                        ) : (
                            <p className="mt-2 text-sm text-muted-foreground">{t("health.stats.noTunnels")}</p>
                        )}
                        {gateway && (
                            <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                                {t("health.stats.gateway", { connections: n(gateway.connections), forwards: n(gateway.forwards) })}
                            </p>
                        )}
                    </Tile>
                )}

                {sessions && (
                    <Tile label={t("health.stats.sessions")}>
                        {(() => {
                            const kinds = sessionKinds(sessions.by_kind);
                            const total = sessions.total ?? kinds.reduce((a, [, v]) => a + v, 0);
                            return (
                                <>
                                    <Value>{n(total)}</Value>
                                    {total === 0 ? (
                                        <p className="mt-1 text-sm text-muted-foreground">{t("health.stats.sessionsNone")}</p>
                                    ) : (
                                        <Rows
                                            rows={kinds.map(([kind, count]) => {
                                                const known = PRESENCE_KINDS[kind];
                                                const Icon = known?.icon;
                                                return [
                                                    <span key={kind} className="inline-flex min-w-0 items-center gap-1.5">
                                                        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
                                                        <span className={cn("min-w-0 break-words", !known && "font-mono text-xs")}>{known ? t(known.label) : kind}</span>
                                                    </span>,
                                                    n(count),
                                                ];
                                            })}
                                        />
                                    )}
                                </>
                            );
                        })()}
                    </Tile>
                )}

                {users && (
                    <Tile label={t("health.stats.users")}>
                        <Value sub={users.total !== null ? t("health.stats.usersOf", { total: n(users.total) }) : undefined}>{n(users.active ?? users.total)}</Value>
                        <Rows
                            rows={[
                                ...(users.admins !== null ? [[t("health.stats.admins"), n(users.admins)] as [string, string]] : []),
                                ...(users.signed_in_24h !== null ? [[t("health.stats.signedIn24h"), n(users.signed_in_24h)] as [string, string]] : []),
                            ]}
                        />
                    </Tile>
                )}

                {storage && (
                    <Tile label={t("health.stats.storage")}>
                        {storage.data_dir && free !== null && storage.data_dir.total_bytes !== null && storage.data_dir.free_bytes !== null ? (
                            <>
                                <Value sub={t("health.stats.diskFreePct", { pct: pct(free) })}>
                                    <span className={cn(low && "text-warning")}>{bytes(storage.data_dir.free_bytes)}</span>
                                </Value>
                                <div
                                    role="meter"
                                    aria-label={t("health.stats.diskMeter")}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round((1 - free) * 100)}
                                    className={cn("mt-2 h-2 overflow-hidden rounded-full", low ? "bg-warning/15" : "bg-muted")}
                                >
                                    <span className={cn("block h-full rounded-full", low ? "bg-warning" : "bg-foreground/45")} style={{ width: `${(1 - free) * 100}%` }} />
                                </div>
                                <p className="mt-1.5 text-xs text-muted-foreground">
                                    {t("health.stats.diskFree", { free: bytes(storage.data_dir.free_bytes), total: bytes(storage.data_dir.total_bytes) })}
                                    {storage.data_dir.path && <span className="font-mono [overflow-wrap:anywhere]"> · {storage.data_dir.path}</span>}
                                </p>
                                {low && <p className="mt-1.5 text-xs text-warning">{t("health.stats.diskLow")}</p>}
                            </>
                        ) : null}
                        <Rows
                            rows={(
                                [
                                    ["database", storage.db_bytes],
                                    ["wal", storage.wal_bytes],
                                    ["recordings", storage.recordings_bytes],
                                    ["logs", storage.logs_bytes],
                                ] as const
                            )
                                .filter(([, v]) => v !== null)
                                .map(([k, v]) => [t(`health.stats.${k}`), bytes(v)])}
                        />
                    </Tile>
                )}

                {webhooks && (
                    <Tile label={t("health.stats.webhooks")}>
                        <Value sub={webhooks.total !== null ? t("health.stats.webhooksOf", { total: n(webhooks.total) }) : undefined}>{n(webhooks.enabled ?? webhooks.total)}</Value>
                        <Rows
                            rows={[
                                ...(webhooks.paused !== null
                                    ? [[t("health.stats.webhooksPaused"), n(webhooks.paused), webhooks.paused > 0 ? "text-warning" : undefined] as [string, string, string?]]
                                    : []),
                                ...(webhooks.failing_recent !== null
                                    ? [[t("health.stats.webhooksFailing"), n(webhooks.failing_recent), webhooks.failing_recent > 0 ? "text-destructive" : undefined] as [string, string, string?]]
                                    : []),
                            ]}
                        />
                    </Tile>
                )}
            </div>

            {charts.length > 0 && (
                <div className="space-y-3">
                    <h4 className="text-base text-foreground">{t("health.stats.last24h")}</h4>
                    {isQuiet(activity) ? (
                        <p className="rounded-xl border border-dashed border-input bg-surface px-4 py-3 text-sm text-muted-foreground">{t("health.stats.quiet")}</p>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
                            {charts.map(([title, ok, sub, bars]) => (
                                <StatsHourlyChart
                                    key={title}
                                    title={t(`health.stats.${title}`)}
                                    okLabel={t(`health.stats.${ok}`)}
                                    subLabel={t(`health.stats.${sub}`)}
                                    bars={bars!}
                                    hours={activity?.hours ?? null}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
