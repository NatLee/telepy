/**
 * 伺服器健康頁「總覽」的即時數字，三塊各自畫：現在（通道狀態長條、連線階段、帳號、Webhook）、儲存空間（資料磁碟 +
 * Telepy 放在磁碟上的每一類東西）、最近 24 小時三張每小時長條圖。資料來自 `GET /api/site/health/stats`，由頁面抓一次、
 * 三塊共用，跟檢查（`/api/site/health`）同時抓，誰先到誰先畫；舊的後端（404）整塊不畫。
 * The Server health page's live numbers in three blocks that render on their own: right now (tunnel bar, live
 * sessions, accounts, webhooks), storage (the data disk + each kind of thing Telepy keeps on it) and three hourly
 * charts for the last 24 hours. Data from `GET /api/site/health/stats`, fetched once by the page and shared, at the
 * same time as the checks (`/api/site/health`), so whichever arrives first draws first; an older backend (404)
 * renders nothing.
 */
import React, { useMemo } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Gauge, HardDrive } from "lucide-react";
import { Section } from "@/components/ui/section";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { StatsHourlyChart } from "@/components/health/StatsHourlyChart";
import type { ServerStatsState } from "@/hooks/useServerStats";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import {
    LOW_DISK,
    diskFree,
    formatBytes,
    hourBars,
    isQuiet,
    sessionKinds,
    storageParts,
    tunnelSegments,
    type StoragePartId,
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

const PART_LABEL: Record<StoragePartId, TranslationKey> = {
    database: "health.stats.database",
    wal: "health.stats.wal",
    recordings: "health.stats.recordings",
    logs: "health.stats.logs",
    carriers: "health.stats.carriers",
    datasets: "health.stats.datasets",
};

/**
 * 有地方可以管的那幾類：載體與 IP / 廠商資料在「相依服務」分頁的面板，錄影在管理區的錄影頁。
 * The kinds with a place to manage them: carriers and the IP / vendor data have panels on the services tab,
 * recordings have the admin recordings page.
 */
export type StorageTarget = { tab: "services"; anchor: "carriers" | "datasets" } | { href: string };
const PART_TARGET: Partial<Record<StoragePartId, StorageTarget>> = {
    carriers: { tab: "services", anchor: "carriers" },
    datasets: { tab: "services", anchor: "datasets" },
    recordings: { href: "/tunnels/admin/recordings" },
};

function useFormat() {
    const { locale } = useI18n();
    const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
    return {
        n: (v: number | null | undefined) => (v === null || v === undefined ? "—" : nf.format(v)),
        bytes: (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatBytes(v, locale)),
        pct: (v: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(v),
    };
}

function Tile({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0 rounded-xl border border-border bg-card p-4", className)} data-refresh-item>
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

/** 還沒到：幾塊灰色的格子（高度接近真的，到了不會跳太多）。/ Not here yet: grey blocks about as tall as the real ones. */
function Skeleton({ className, label }: { className: string; label: string }) {
    return (
        <div className={className} aria-busy="true" aria-label={label}>
            <div className="h-full min-h-24 animate-pulse rounded-xl border border-border bg-surface" />
        </div>
    );
}

/** 每一塊共用：沒資料時是骨架或「載入失敗」，有舊資料又重抓失敗時上面多一行。/ Shared by every block: skeleton or failure, stale note. */
function Block({ state, skeleton, children }: { state: ServerStatsState; skeleton: React.ReactNode; children: React.ReactNode }) {
    const { t } = useI18n();
    if (!state.stats) return state.loading ? <>{skeleton}</> : <p className="text-sm text-muted-foreground">{t("health.stats.failed")}</p>;
    return (
        <>
            {state.failed && <p className="text-sm text-muted-foreground">{t("health.stats.staleFailed")}</p>}
            {children}
        </>
    );
}

/** 現在：通道、連線階段、帳號、Webhook。/ Right now: tunnels, live sessions, accounts, webhooks. */
export function LiveNumbers({ state }: { state: ServerStatsState }) {
    const { t } = useI18n();
    const { n } = useFormat();
    if (state.missing) return null;
    const label = t("health.stats.loading");
    return (
        <Section icon={<Gauge />} title={t("health.stats.title")} description={t("health.stats.description")}>
            <div className="@container">
                <Block
                    state={state}
                    skeleton={
                        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3 @4xl:grid-cols-5">
                            <Skeleton className="h-36 @lg:col-span-3 @4xl:col-span-2" label={label} />
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-36" label={label} />
                            ))}
                        </div>
                    }
                >
                    {state.stats && <LiveTiles stats={state.stats} n={n} />}
                </Block>
            </div>
        </Section>
    );
}

function LiveTiles({ stats, n }: { stats: NonNullable<ServerStatsState["stats"]>; n: (v: number | null | undefined) => string }) {
    const { t } = useI18n();
    const { tunnels, gateway, sessions, users, webhooks } = stats;
    const segments = tunnels ? tunnelSegments(tunnels) : [];
    return (
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3 @4xl:grid-cols-5" data-refresh-list>
            {tunnels && (
                <Tile label={t("health.stats.tunnels")} className="@lg:col-span-3 @4xl:col-span-2">
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
    );
}

/**
 * 儲存空間：左邊是資料磁碟（剩多少），右邊是 Telepy 自己放在上面的每一類東西——一個顏色的長條清單，大的在前、
 * 數字直接寫在旁邊（各類大小差好幾個數量級，疊成一條會看不到小的）。載體與 IP / 廠商資料連到它們的面板。
 * Storage: the data disk (how much is free) on the left, each kind of thing Telepy keeps on it on the right — a
 * one-colour bar list, largest first, the size written beside each bar (the kinds differ by orders of magnitude,
 * so one stacked bar would hide the small ones). Carriers and the IP / vendor data link to their panels.
 */
export function StoragePanel({ state, onOpen }: { state: ServerStatsState; onOpen: (target: Extract<StorageTarget, { tab: string }>) => void }) {
    const { t } = useI18n();
    if (state.missing) return null;
    return (
        <Section icon={<HardDrive />} title={t("health.stats.storage")} description={t("health.stats.storageDescription")}>
            <div className="@container">
                <Block
                    state={state}
                    skeleton={
                        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                            <Skeleton className="h-36" label={t("health.stats.loading")} />
                            <Skeleton className="h-56" label={t("health.stats.loading")} />
                        </div>
                    }
                >
                    {state.stats?.storage ? <StorageBody storage={state.stats.storage} onOpen={onOpen} /> : <p className="text-sm text-muted-foreground">{t("health.stats.failed")}</p>}
                </Block>
            </div>
        </Section>
    );
}

function StorageBody({ storage, onOpen }: { storage: NonNullable<NonNullable<ServerStatsState["stats"]>["storage"]>; onOpen: (target: Extract<StorageTarget, { tab: string }>) => void }) {
    const { t } = useI18n();
    const { bytes, pct } = useFormat();
    const free = diskFree(storage.data_dir);
    const low = free !== null && free < LOW_DISK;
    const disk = storage.data_dir;
    const { parts, total, atLeast } = storageParts(storage);
    // 長條以最大的一類為滿格（比例看大小差多少；佔全部的百分比寫在 title）。/ Bars scale to the largest kind; the share of the total is in the title.
    const max = parts.reduce((a, p) => Math.max(a, p.bytes), 0);
    const size = (b: number, least: boolean) => (least ? t("health.stats.atLeast", { size: bytes(b) }) : bytes(b));

    return (
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-refresh-list>
            <Tile label={t("health.stats.dataDisk")}>
                {disk && free !== null && disk.total_bytes !== null && disk.free_bytes !== null ? (
                    <>
                        <Value sub={t("health.stats.diskFreePct", { pct: pct(free) })}>
                            <span className={cn(low && "text-warning")}>{bytes(disk.free_bytes)}</span>
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
                            {t("health.stats.diskFree", { free: bytes(disk.free_bytes), total: bytes(disk.total_bytes) })}
                            {disk.path && <span className="font-mono [overflow-wrap:anywhere]"> · {disk.path}</span>}
                        </p>
                        {low && <p className="mt-1.5 text-xs text-warning">{t("health.stats.diskLow")}</p>}
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("health.stats.diskUnknown")}</p>
                )}
            </Tile>

            <div className="min-w-0 rounded-xl border border-border bg-card p-4" data-refresh-item>
                <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-sm text-muted-foreground">{t("health.stats.telepyKeeps")}</span>
                    <span className="text-sm tabular-nums text-foreground">{t("health.stats.telepyTotal", { size: size(total, atLeast) })}</span>
                </p>
                {parts.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">{t("health.stats.failed")}</p>
                ) : (
                    <ul className="mt-3 space-y-2.5">
                        {parts.map((p) => {
                            const target = PART_TARGET[p.id];
                            const name = t(PART_LABEL[p.id]);
                            const linkClass =
                                "inline-flex min-w-0 items-center gap-1 rounded-sm text-left text-foreground underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
                            const label = !target ? (
                                <span className="min-w-0 text-foreground">{name}</span>
                            ) : "href" in target ? (
                                <Link href={target.href} className={linkClass}>
                                    {name} <ArrowRight size={13} className="shrink-0" aria-hidden />
                                </Link>
                            ) : (
                                <button type="button" onClick={() => onOpen(target)} className={linkClass}>
                                    {name} <ArrowRight size={13} className="shrink-0" aria-hidden />
                                </button>
                            );
                            const width = max > 0 ? (p.bytes / max) * 100 : 0;
                            return (
                                <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-sm @lg:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] @lg:items-center">
                                    <div className="min-w-0">{label}</div>
                                    <span className="text-right tabular-nums text-foreground @lg:order-3" title={total > 0 ? t("health.stats.shareOfTotal", { pct: pct(p.share) }) : undefined}>
                                        {size(p.bytes, p.atLeast)}
                                    </span>
                                    {/* 一個顏色、細的；0 也留著軌道，看得出「沒有」。/ One colour, thin; an empty track still shows "none". */}
                                    <span className="col-span-2 h-2 overflow-hidden rounded-full bg-muted @lg:order-2 @lg:col-span-1" aria-hidden>
                                        {width > 0 && <span className="block h-full min-w-1 rounded-full bg-foreground/55" style={{ width: `${width}%` }} />}
                                    </span>
                                    {/* IP 與廠商資料的兩份，在整列下面一行。/ The two parts of the IP and vendor data, one line under the row. */}
                                    {p.split && (p.split.geoip !== null || p.split.oui !== null) && (
                                        <p className="col-span-2 -mt-0.5 text-xs text-muted-foreground @lg:order-4 @lg:col-span-3">
                                            {t("health.stats.datasetsSplit", { geoip: bytes(p.split.geoip ?? 0), oui: bytes(p.split.oui ?? 0) })}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}

/** 最近 24 小時：閘道事件、登入、API 呼叫。/ The last 24 hours: gateway events, sign-ins, API calls. */
export function ActivityPanel({ state }: { state: ServerStatsState }) {
    const { t } = useI18n();
    if (state.missing) return null;
    const activity = state.stats?.activity ?? null;
    const charts = activity
        ? ([
              ["gatewayEvents", "gatewayOk", "gatewayProblems", hourBars(activity.gateway_events, activity.gateway_problems)],
              ["signIns", "signInsOk", "signInsFailed", hourBars(activity.sign_ins, activity.sign_ins_failed)],
              ["apiCalls", "apiOk", "apiErrors", hourBars(activity.api_calls, activity.api_errors)],
          ] as const).filter(([, , , bars]) => bars !== null)
        : [];
    // 有資料但沒有任何一張圖（舊的後端）= 不畫這一塊。/ Data but no chart at all (an older backend) = no block.
    if (state.stats && charts.length === 0) return null;
    return (
        <Section icon={<Activity />} title={t("health.stats.last24h")} description={t("health.stats.last24hDescription")}>
            <div className="@container">
                <Block
                    state={state}
                    skeleton={
                        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-44" label={t("health.stats.loading")} />
                            ))}
                        </div>
                    }
                >
                    {isQuiet(activity) ? (
                        <p className="rounded-xl border border-dashed border-input bg-surface px-4 py-3 text-sm text-muted-foreground">{t("health.stats.quiet")}</p>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3" data-refresh-list>
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
                </Block>
            </div>
        </Section>
    );
}
