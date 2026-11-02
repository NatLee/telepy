"use client";

/**
 * 管理區「伺服器狀態」頁：`telepy-server doctor` 的檢查分成左側分頁（總覽 + 設定 / 資料與審計 / 金鑰與閘道 / 相依服務 /
 * 訪客位址），分頁記在 `?tab=`。總覽 = 狀態卡（結論、每組一格、版本與運作時間）、要處理的項目，再來是即時數字、
 * 儲存空間、最近 24 小時；每組 = 每項檢查一張卡（翻譯過的名稱、在檢查什麼、怎麼修，加上後端原文）。「訪客位址」分頁
 * 最後接「Telepy 怎麼看你的位址」。檢查與即時數字同時抓、各自先到先畫，總覽不必等最慢的那一項；進頁面時審計鏈沿用
 * 後端背景（每 10 分鐘）驗好的結果，按重新整理才全部重跑（含審計鏈）。不輪詢。
 * The admin "Server health" page: the `telepy-server doctor` checks in left side tabs (an overview + configuration /
 * data & audit / keys & gateway / companion services / visitor addresses), the tab kept in `?tab=`. The overview =
 * a status card (the verdict, one cell per group, version / uptime), what needs action, then the live numbers,
 * storage and the last 24 hours; each group = one card per check (translated title, what it checks, how to fix it,
 * plus the backend's own text). The addresses tab ends with "How Telepy sees your address".
 * The checks and the live numbers are fetched at the same time and each part draws as soon as its data is in, so the
 * overview never waits for the slowest check. On open the audit chain reuses the backend's background verification
 * (every 10 minutes); Refresh reruns everything, the audit chain included. The page never polls.
 * 已確認：⚠ / ✗ 卡可以「確認…」（附備註，結果一樣就不再算警報，一變又亮起），確認過的卡變中性、細節收起來；
 * 之前確認過但結果變了的卡，最上面說明一次。純邏輯在 lib/healthAck。
 * Acknowledgements: a warning / failure card can be acknowledged with a note (no longer an alert while the result
 * stays the same, red again once it changes); an acknowledged card turns neutral with its details folded away; a
 * card whose earlier acknowledgement no longer matches says so on top. Pure logic in lib/healthAck.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CheckCheck, ChevronDown, CircleAlert, CircleCheck, CircleX, Database, Globe, HeartPulse, Info, KeyRound, LayoutGrid, LoaderCircle, Puzzle, SlidersHorizontal, Stamp } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AdminChip } from "@/components/layout/AdminViews";
import { ClientIpCheckPanel } from "@/components/auth/ClientIpCheck";
import { AuditResealDialog } from "@/components/health/AuditResealDialog";
import { CarriersPanel } from "@/components/health/CarriersPanel";
import { DatasetsPanel } from "@/components/health/DatasetsPanel";
import { HealthAckDialog } from "@/components/health/HealthAckDialog";
import { ServerHealthInfoDialog } from "@/components/health/ServerHealthInfoDialog";
import { ActivityPanel, LiveNumbers, StoragePanel, type StorageTarget } from "@/components/health/ServerStats";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { useServerHealth, type AckOutcome } from "@/hooks/useServerHealth";
import { useServerStats, type ServerStatsState } from "@/hooks/useServerStats";
import { canReseal } from "@/lib/auditReseal";
import { ackedSummary, canAcknowledge, cardLook, tileTone } from "@/lib/healthAck";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatUptime } from "@/lib/serverStats";
import {
    HEALTH_GROUPS,
    auditReusedAt,
    checksIn,
    countStatuses,
    groupCounts,
    groupOf,
    groupStatuses,
    initialHealthTab,
    parseHealthTab,
    problems,
    worstStatus,
    type HealthCheck,
    type HealthCheckId,
    type HealthGroup,
    type HealthStatus,
    type HealthTab,
    type ServerHealth,
    type StatusCounts,
} from "@/lib/serverHealth";
import type { TranslationKey } from "@/locales/en";

const STATUS_KEY: Record<HealthStatus, TranslationKey> = {
    ok: "health.status.ok",
    info: "health.status.info",
    warn: "health.status.warn",
    fail: "health.status.fail",
};

const STATUS_TONE: Record<HealthStatus, "success" | "neutral" | "warning" | "danger"> = { ok: "success", info: "neutral", warn: "warning", fail: "danger" };
const STATUS_TEXT: Record<HealthStatus, string> = { ok: "text-success", info: "text-muted-foreground", warn: "text-warning", fail: "text-destructive" };
const STATUS_DOT: Record<"ok" | "warn" | "fail", string> = { ok: "bg-success", warn: "bg-warning", fail: "bg-destructive" };
const STATUS_ICON = { ok: CircleCheck, info: Info, warn: CircleAlert, fail: CircleX } as const;

const GROUP_LABEL: Record<HealthGroup, TranslationKey> = {
    config: "health.group.config",
    storage: "health.group.storage",
    keys: "health.group.keys",
    services: "health.group.services",
    addresses: "health.group.addresses",
};
const GROUP_HINT: Record<HealthGroup, TranslationKey> = {
    config: "health.group.config.hint",
    storage: "health.group.storage.hint",
    keys: "health.group.keys.hint",
    services: "health.group.services.hint",
    addresses: "health.group.addresses.hint",
};
const GROUP_ICON: Record<HealthGroup, React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>> = {
    config: SlidersHorizontal,
    storage: Database,
    keys: KeyRound,
    services: Puzzle,
    addresses: Globe,
};

const tKey = (id: HealthCheckId, part: "title" | "what" | "fix") => `health.check.${id}.${part}` as TranslationKey;

/** 頁面至少這麼寬（rem）才把分頁放在左邊：15rem 的分頁欄 + 約 40rem 的內容。/ Page width (rem) for the left rail: 15rem of tabs + ~40rem of content. */
const RAIL_MIN_REM = 56;

/** 元素寬度 ≥ `rem` 個根字級（跟著顯示大小）；畫面出現前就量好，不會先閃一下。/ Element width ≥ `rem` root font sizes; measured before paint. */
function useWiderThan(ref: React.RefObject<HTMLElement | null>, rem: number): boolean {
    const [wider, setWider] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            setWider(el.clientWidth >= rem * root);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, rem]);
    return wider;
}

function StatusChip({ status }: { status: HealthStatus }) {
    const { t } = useI18n();
    const Icon = STATUS_ICON[status];
    return (
        <Chip tone={STATUS_TONE[status]} className="shrink-0">
            <Icon aria-hidden /> {t(STATUS_KEY[status])}
        </Chip>
    );
}

/**
 * 「2 項失敗 · 1 項警告」；全部通過 = 「全部正常」。`withOk` = 最後也列通過的（狀態卡的總數）。
 * "2 failures · 1 warning"; all passing = "All OK". `withOk` = the passing ones last too (the status card's totals).
 */
function useCountsLine() {
    const { t } = useI18n();
    return (c: StatusCounts, withOk = false): string => {
        const parts: string[] = [];
        if (c.fail) parts.push(t(c.fail === 1 ? "health.n.failOne" : "health.n.fail", { n: String(c.fail) }));
        if (c.warn) parts.push(t(c.warn === 1 ? "health.n.warnOne" : "health.n.warn", { n: String(c.warn) }));
        if (c.info) parts.push(t(c.info === 1 ? "health.n.infoOne" : "health.n.info", { n: String(c.info) }));
        if (c.acked) parts.push(t(c.acked === 1 ? "health.n.ackedOne" : "health.n.acked", { n: String(c.acked) }));
        if (withOk && c.ok) parts.push(t(c.ok === 1 ? "health.n.okOne" : "health.n.ok", { n: String(c.ok) }));
        if (parts.length === 0) return c.ok ? t("health.n.allOk") : t("health.n.none");
        return parts.join(" · ");
    };
}

/**
 * 側欄分頁的標籤：名稱 + 狀態點（灰 = 只有備註或確認過的）+ 要處理的數量。
 * A tab label: name + status dot (grey = only notes or acknowledged ones) + how many need action.
 */
function TabLabel({ label, status, issues }: { label: string; status: HealthStatus | null; issues: number }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1.5">
            {label}
            {status && (
                <span
                    className={cn("size-1.5 shrink-0 rounded-full", status === "info" ? "bg-muted-foreground/50" : STATUS_DOT[status])}
                    role="img"
                    aria-label={t(STATUS_KEY[status])}
                />
            )}
            {issues > 0 && (
                <Chip tone={status === "fail" ? "danger" : "warning"} mono className="px-1 leading-4">
                    {issues}
                </Chip>
            )}
        </span>
    );
}

export function ServerHealthView() {
    const { t, tn } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { health, failed, busy, reload, acknowledge, unacknowledge, loadAuditPlan, reseal } = useServerHealth();
    const { request: requestReauth, dialog: reauthDialog } = useReauth();
    const { showSuccess, showError } = useToast();
    // 正在確認的那張卡。/ The card being acknowledged.
    const [acking, setAcking] = useState<HealthCheck | null>(null);
    const undo = async (c: HealthCheck) => {
        if (await unacknowledge(c)) showSuccess(t("health.ack.undone"));
        else showError(t("health.ack.undoFailed"));
    };
    // 重新封存審計鏈的視窗。/ The audit-chain re-seal dialog.
    const [resealing, setResealing] = useState(false);
    const cardActions: CardActions = { onAck: setAcking, onUndo: (c) => void undo(c), onReseal: () => setResealing(true) };
    const bodyRef = useRef<HTMLDivElement>(null);
    const [info, setInfo] = useState(false);
    // 每按一次重新整理就加一，讓即時數據也重抓；檢查連審計鏈都現在驗。即時數字跟檢查同時抓（頁面層級），總覽不用等檢查。
    // Bumped on every Refresh so the live stats reload too; the checks verify the audit chain now. The live numbers are
    // fetched at page level alongside the checks, so the overview never waits for them.
    const [reloadKey, setReloadKey] = useState(0);
    const stats = useServerStats(reloadKey);
    const refresh = () => {
        setReloadKey((n) => n + 1);
        return reload(true);
    };
    // 分頁欄在左邊只在頁面本身夠寬時（看頁面寬度、以 rem 算，跟著顯示大小走）：側欄展開、字放大時，視窗 1024px
    // 還不夠放分頁欄加內容，內容會被擠到兩百多 px。不夠寬就是上面一排。
    // The tab rail sits on the left only when the page itself is wide enough (its own width, in rem, so it follows the
    // display size): with the sidebar open and larger text a 1024px window left the content a couple of hundred px.
    // Otherwise the tabs are a row on top.
    const gridRef = useRef<HTMLDivElement>(null);
    const wide = useWiderThan(gridRef, RAIL_MIN_REM);

    const rawTab = searchParams.get("tab");
    const tab = parseHealthTab(rawTab);
    const setTab = (next: HealthTab) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === "overview") params.delete("tab");
        else params.set("tab", next);
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    };

    // 舊連結 `#client-ip`（沒有 ?tab=）→ 訪客位址分頁，然後捲到檢查面板。/ Old `#client-ip` links → the addresses tab, then scroll to the panel.
    useEffect(() => {
        if (rawTab || initialHealthTab(rawTab, window.location.hash) !== "addresses") return;
        const params = new URLSearchParams(window.location.search);
        params.set("tab", "addresses");
        router.replace(`${pathname}?${params.toString()}#client-ip`, { scroll: false });
        // 只在第一次進頁面時看 hash。/ Only the first visit looks at the hash.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const statuses = health ? groupStatuses(health.checks) : null;
    const counts = health ? groupCounts(health.checks) : null;
    const issues = (g: HealthGroup) => (counts ? counts[g].fail + counts[g].warn : 0);
    const overviewStatus = health ? tileTone(worstStatus(health.checks), countStatuses(health.checks)) : null;
    const overviewIssues = health ? problems(health.checks).length : 0;

    const tabs: NavTab<HealthTab>[] = [
        { value: "overview", icon: <LayoutGrid />, label: <TabLabel label={t("health.tab.overview")} status={overviewStatus} issues={overviewIssues} />, hint: wide ? t("health.tab.overview.hint") : undefined },
        ...HEALTH_GROUPS.map((g) => {
            const Icon = GROUP_ICON[g];
            return { value: g, icon: <Icon />, label: <TabLabel label={t(GROUP_LABEL[g])} status={statuses && counts ? tileTone(statuses[g], counts[g]) : null} issues={issues(g)} />, hint: wide ? t(GROUP_HINT[g]) : undefined };
        }),
    ];

    const pick = (next: HealthTab) => {
        setTab(next);
        setInfo(false);
    };

    // 儲存空間的一列 → 那個分頁上的面板（換頁後捲過去）。/ A storage row → its panel on that tab (scrolled to after the switch).
    const [anchor, setAnchor] = useState<string | null>(null);
    const openPanel = (target: Extract<StorageTarget, { tab: string }>) => {
        setTab(target.tab);
        setAnchor(target.anchor);
    };
    useEffect(() => {
        if (!anchor || tab === "overview") return;
        const id = requestAnimationFrame(() => {
            document.getElementById(anchor)?.scrollIntoView({ block: "start" });
            setAnchor(null);
        });
        return () => cancelAnimationFrame(id);
    }, [anchor, tab]);

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<HeartPulse />}
                title={t("health.title")}
                titleAddon={<AdminChip />}
                description={t("health.description")}
                actions={
                    <>
                        <Button type="button" variant="outline" onClick={() => setInfo(true)}>
                            <Info size={16} aria-hidden /> {t("health.infoButton")}
                        </Button>
                        <RefreshButton onRefresh={refresh} busy={busy} failed={failed} ripple={bodyRef} label={t("common.refresh")} />
                    </>
                }
            />

            <div ref={gridRef} className={cn("grid", wide ? "grid-cols-[15rem_minmax(0,1fr)] items-start gap-6" : "gap-4")}>
                {/* 不夠寬是一列可橫捲的分頁，夠寬是黏在左側的一欄。/ A scrolling row when narrow, a sticky left rail when wide. */}
                <div className={cn("min-w-0", wide ? "sticky top-20" : "-mx-1 overflow-x-auto px-1 pb-0.5")}>
                    <NavTabs tabs={tabs} value={tab} onChange={setTab} aria-label={t("health.title")} className={wide ? "sm:flex-col" : "sm:min-w-max sm:flex-row [&_span]:whitespace-nowrap"} />
                </div>

                <div ref={bodyRef} className="min-w-0 space-y-6">
                    {tab === "overview" ? (
                        <Overview health={health} failed={failed} stats={stats} onPick={setTab} onOpen={openPanel} />
                    ) : failed && !health ? (
                        <Callout tone="danger">{t("health.failed")}</Callout>
                    ) : !health ? (
                        <p className="text-sm text-muted-foreground">{t("health.checking")}</p>
                    ) : (
                        <div className="space-y-4">
                            <GroupPanel health={health} group={tab} actions={cardActions} />
                        </div>
                    )}
                    {tab === "addresses" && <ClientIpCheckPanel />}
                    {tab === "services" && <CarriersPanel />}
                    {tab === "services" && <DatasetsPanel />}
                    {health && tab === "overview" && <p className="text-xs text-muted-foreground">{tn("health.cliNote", { cli: <code>docker compose exec backend telepy-server doctor</code> })}</p>}
                </div>
            </div>

            <ServerHealthInfoDialog open={info} onClose={() => setInfo(false)} health={health} onPick={pick} />
            <HealthAckDialog
                check={acking}
                title={acking ? checkTitle(t, acking) : ""}
                onClose={() => setAcking(null)}
                onSubmit={(note): Promise<AckOutcome> => (acking ? acknowledge(acking, note, requestReauth) : Promise.resolve({ kind: "cancelled" }))}
            />
            <AuditResealDialog open={resealing} onClose={() => setResealing(false)} load={loadAuditPlan} onSubmit={(fingerprint, note) => reseal(fingerprint, note, requestReauth)} />
            {reauthDialog}
        </div>
    );
}

/**
 * 總覽最上面的狀態卡：結論（最嚴重的一級）、各級數量、版本與運作時間，下面一排每組一格（點了到那個分頁），最下面一行
 * 是什麼時候檢查的（審計鏈沿用背景的驗證時另外說）。檢查還沒回來時是「正在檢查」與灰色格子，即時數字照樣先畫。
 * The status card on top of the overview: the verdict (worst level), counts, version and uptime, one cell per group
 * below (a click opens that tab) and when the checks ran (plus the audit chain's own time when the background
 * verification was reused). While the checks are still running it says so with grey cells; the live numbers draw
 * regardless.
 */
function StatusCard({ health, failed, server, onPick }: { health: ServerHealth | null; failed: boolean; server: NonNullable<ServerStatsState["stats"]>["server"] | null; onPick: (tab: HealthTab) => void }) {
    const { t, locale } = useI18n();
    const countsLine = useCountsLine();
    const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const uptime = server?.uptime_secs ?? null;

    let head: React.ReactNode;
    if (!health) {
        head = failed ? (
            <Callout tone="danger">{t("health.failed")}</Callout>
        ) : (
            <div className="flex items-start gap-3" aria-live="polite">
                <LoaderCircle size={20} className="mt-0.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
                <div className="min-w-0">
                    <p className="text-base text-foreground">{t("health.checking")}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{t("health.checkingHint")}</p>
                </div>
            </div>
        );
    } else {
        const worst = worstStatus(health.checks);
        const Icon = STATUS_ICON[worst];
        // 數字由頁面自己算，確認過的另外算（後端的數字不分）。/ Counted here so acknowledged ones are separate.
        const counts = countStatuses(health.checks);
        const acked = ackedSummary(health.checks);
        head = (
            <div className="flex items-start gap-3">
                <Icon size={20} className={cn("mt-0.5 shrink-0", STATUS_TEXT[worst])} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-base text-foreground">
                        {t(worst === "fail" ? "health.summary.fail" : worst === "warn" ? "health.summary.warn" : acked ? "health.summary.okAcked" : "health.summary.ok")}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{countsLine(counts, true)}</p>
                    {acked && (
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                            <CheckCheck size={14} className="shrink-0" aria-hidden />
                            {t(acked.count === 1 ? "health.ack.overviewOne" : "health.ack.overview", { n: String(acked.count) })}
                            <button type="button" onClick={() => onPick(acked.group)} className="inline-flex items-center gap-1 rounded-sm text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {t("health.todo.open", { group: t(GROUP_LABEL[acked.group]) })} <ArrowRight size={13} aria-hidden />
                            </button>
                        </p>
                    )}
                </div>
            </div>
        );
    }

    const statuses = health ? groupStatuses(health.checks) : null;
    const counts = health ? groupCounts(health.checks) : null;
    const reused = health ? auditReusedAt(health) : null;

    return (
        <section className="@container overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="flex flex-col gap-3 px-4 py-4 sm:px-5 @2xl:flex-row @2xl:items-start @2xl:justify-between">
                <div className="min-w-0 flex-1">{head}</div>
                {/* 這台伺服器：版本（發行版才有）與運作時間，來自即時數字。/ This server: version (release builds only) and uptime, from the live numbers. */}
                {server && (server.version || uptime !== null) && (
                    <dl className="flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-sm @2xl:justify-end @2xl:text-right">
                        {server.version && (
                            <div>
                                <dt className="text-xs text-muted-foreground">{t("health.stats.version")}</dt>
                                <dd className="font-mono text-foreground">{server.version}</dd>
                            </div>
                        )}
                        {uptime !== null && (
                            <div>
                                <dt className="text-xs text-muted-foreground">{t("health.uptime")}</dt>
                                <dd className="text-foreground" title={server.started_at ? t("health.stats.since", { date: new Date(server.started_at).toLocaleString(locale) }) : undefined}>
                                    {formatUptime(uptime, locale)}
                                </dd>
                            </div>
                        )}
                    </dl>
                )}
            </div>

            {/* 每組一格：窄的時候一列一組，寬的時候五格一排；中間用細線分開。/ One cell per group: rows when narrow, five across when wide; hairlines between. */}
            <ul className="grid grid-cols-1 gap-px border-t border-border bg-border @3xl:grid-cols-5" data-refresh-list>
                {HEALTH_GROUPS.map((g) => {
                    const Icon = GROUP_ICON[g];
                    const c = counts?.[g];
                    // 全是備註、只剩確認過的（或沒有檢查）= 灰點，不算「正常」。/ Only notes, acknowledged ones or nothing = a grey dot.
                    const tone: HealthStatus | null = statuses && c ? tileTone(statuses[g], c) : null;
                    return (
                        <li key={g} className="min-w-0 bg-card">
                            <button
                                type="button"
                                onClick={() => onPick(g)}
                                title={t(GROUP_HINT[g])}
                                className="flex h-full w-full min-w-0 items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 sm:px-5 @3xl:flex-col @3xl:items-start @3xl:gap-1 @3xl:px-4"
                            >
                                <span className="flex min-w-0 flex-1 items-center gap-2 @3xl:w-full @3xl:flex-none">
                                    <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                                    <span className="min-w-0 flex-1 text-sm text-foreground">{t(GROUP_LABEL[g])}</span>
                                </span>
                                {/* 狀態點跟著數量那一行，名稱才有整格的寬度。/ The dot sits with the counts so the name gets the whole width. */}
                                <span className="flex shrink-0 items-center gap-1.5 text-xs @3xl:min-w-0 @3xl:shrink">
                                    {c && tone ? (
                                        <>
                                            <span className={cn("size-2 shrink-0 rounded-full", tone === "info" ? "bg-muted-foreground/50" : STATUS_DOT[tone === "ok" ? "ok" : tone])} aria-hidden />
                                            <span className={STATUS_TEXT[tone]}>{countsLine(c)}</span>
                                        </>
                                    ) : (
                                        <span className="h-3 w-16 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" aria-hidden />
                                    )}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>

            {health?.ranAt && (
                <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-5">
                    {reused
                        ? t("health.ranAtReused", { time: new Date(health.ranAt).toLocaleString(locale), audit: time(reused) })
                        : t("health.ranAt", { time: new Date(health.ranAt).toLocaleString(locale) })}
                </p>
            )}
        </section>
    );
}

function checkTitle(t: ReturnType<typeof useI18n>["t"], c: HealthCheck) {
    return c.id ? t(tKey(c.id, "title")) : c.name;
}

function Overview({
    health,
    failed,
    stats,
    onPick,
    onOpen,
}: {
    health: ServerHealth | null;
    failed: boolean;
    stats: ServerStatsState;
    onPick: (tab: HealthTab) => void;
    onOpen: (target: Extract<StorageTarget, { tab: string }>) => void;
}) {
    const { t } = useI18n();
    const todo = health ? problems(health.checks) : [];

    return (
        <>
            <StatusCard health={health} failed={failed} server={stats.stats?.server ?? null} onPick={onPick} />

            {todo.length > 0 && (
                // 一列怎麼排看卡片自己的寬度（側欄 + 分頁欄在窄螢幕、大字時會把它擠得很窄）。
                // Rows lay out by the card's own width (the sidebar and tab rail squeeze it on narrow screens at large text sizes).
                <section className="@container overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                    <div className="px-4 pt-4 sm:px-5">
                        <SectionHeading title={t("health.todo.title")} description={t("health.todo.description")} />
                    </div>
                    <ol className="mt-3 divide-y divide-border border-t border-border" data-refresh-list>
                        {todo.map((c, i) => {
                            const g = groupOf(c);
                            return (
                                <li key={`${c.name}-${i}`} className="flex flex-col gap-2 px-4 py-3 sm:px-5 @lg:flex-row @lg:items-center @lg:gap-4">
                                    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                                        <StatusChip status={c.status} />
                                        <span className="min-w-0 flex-1 basis-40 text-sm text-foreground [overflow-wrap:anywhere]">{checkTitle(t, c)}</span>
                                    </div>
                                    <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 self-start whitespace-normal text-left @lg:self-auto" onClick={() => onPick(g)}>
                                        {t("health.todo.open", { group: t(GROUP_LABEL[g]) })} <ArrowRight size={14} aria-hidden />
                                    </Button>
                                </li>
                            );
                        })}
                    </ol>
                </section>
            )}

            <LiveNumbers state={stats} />
            <StoragePanel state={stats} onOpen={onOpen} />
            <ActivityPanel state={stats} />
        </>
    );
}

interface CardActions {
    onAck: (check: HealthCheck) => void;
    onUndo: (check: HealthCheck) => void;
    onReseal: () => void;
}

function GroupPanel({ health, group, actions }: { health: ServerHealth; group: HealthGroup; actions: CardActions }) {
    const { t } = useI18n();
    const checks = checksIn(health.checks, group);
    const Icon = GROUP_ICON[group];
    return (
        <>
            <SectionHeading icon={<Icon />} title={t(GROUP_LABEL[group])} description={t(`health.group.${group}.description` as TranslationKey)} />
            {checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(group === "addresses" ? "health.emptyAddresses" : "health.empty")}</p>
            ) : (
                <ol className="space-y-3" data-refresh-list>
                    {checks.map((c, i) => (
                        <CheckCard key={`${c.name}-${i}`} check={c} actions={actions} />
                    ))}
                </ol>
            )}
        </>
    );
}

/**
 * 一項檢查：翻譯過的名稱與說明、怎麼修（有問題時），加上後端原文。⚠ / ✗ 可以「確認…」；確認過的卡是中性的、
 * 細節收在「顯示細節」後面；之前確認過但結果變了的卡，最上面多一段警告。
 * One check: translated title and purpose, how to fix it, the backend's own text. Warnings / failures can be
 * acknowledged; an acknowledged card is neutral with its details folded away; a card whose earlier acknowledgement
 * no longer matches gets a warning on top.
 */
function CheckCard({ check, actions }: { check: HealthCheck; actions: CardActions }) {
    const { t, locale } = useI18n();
    const look = cardLook(check);
    const [open, setOpen] = useState(false);
    const fix = check.id && check.status !== "ok" ? <FixText id={check.id} /> : null;
    const when = (at: string) => {
        const d = new Date(at);
        return Number.isNaN(d.getTime()) ? at : d.toLocaleString(locale);
    };
    const details = (
        <>
            {fix && (
                <Callout tone={check.status === "fail" ? "danger" : check.status === "warn" ? "warning" : "info"} title={t(check.status === "info" ? "health.optional" : "health.fix")}>
                    {fix}
                </Callout>
            )}
            {/* 後端的說明照原文顯示（和 CLI 的 doctor 一樣），長路徑在框內換行。/ The backend's own text, as in the CLI; long paths wrap. */}
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <p className="text-xs text-muted-foreground">
                    {t("health.serverSaid")} <span className="font-mono">· {check.name}</span>
                </p>
                <p className="mt-0.5 font-mono text-xs whitespace-pre-wrap text-foreground/85 [overflow-wrap:anywhere]">{check.detail || "—"}</p>
            </div>
        </>
    );
    return (
        <li className="space-y-3 rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-card sm:px-5">
            {look === "stale" && check.staleAck && (
                <Callout tone="warning">
                    {t("health.ack.stale", { by: check.staleAck.by, time: when(check.staleAck.at), note: check.staleAck.note })}
                </Callout>
            )}
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                {look === "acked" ? (
                    <Chip className="shrink-0">
                        <CheckCheck aria-hidden /> {t("health.ack.chip", { status: t(STATUS_KEY[check.status]) })}
                    </Chip>
                ) : (
                    <StatusChip status={check.status} />
                )}
                <div className="min-w-0 flex-1 basis-60">
                    <p className={cn("text-base [overflow-wrap:anywhere]", look === "acked" ? "text-foreground/80" : "text-foreground")}>{checkTitle(t, check)}</p>
                    {check.id && <p className="mt-0.5 text-sm text-muted-foreground">{t(tKey(check.id, "what"))}</p>}
                    {/* 沿用背景驗證的結果時說是什麼時候驗的。/ When the background verification was reused, say when it ran. */}
                    {check.checkedAt && <p className="mt-0.5 text-xs text-muted-foreground">{t("health.verifiedAt", { time: when(check.checkedAt) })}</p>}
                </div>
                {(canReseal(check) || canAcknowledge(check)) && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                        {/* 審計鏈：知道原因就重新封存（真的修好），確認只是先不當警報。/ Audit log: re-seal fixes it, acknowledging only quiets it. */}
                        {canReseal(check) && (
                            <Button type="button" variant="outline" size="sm" onClick={actions.onReseal}>
                                <Stamp aria-hidden /> {t("health.reseal.button")}
                            </Button>
                        )}
                        {canAcknowledge(check) && (
                            <Button type="button" variant="outline" size="sm" onClick={() => actions.onAck(check)}>
                                {t("health.ack.button")}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {look === "acked" && check.ack ? (
                <>
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                        <p className="min-w-0 flex-1 text-foreground/85 [overflow-wrap:anywhere]">
                            <span className="text-muted-foreground">{t("health.ack.byLine", { by: check.ack.by, time: when(check.ack.at) })}</span>
                            {check.ack.note && <> — <span className="whitespace-pre-wrap">{check.ack.note}</span></>}
                        </p>
                        <Button type="button" variant="link" size="xs" className="h-auto px-0 text-foreground underline decoration-foreground/30" onClick={() => actions.onUndo(check)}>
                            {t("health.ack.undo")}
                        </Button>
                    </div>
                    <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
                        {t(open ? "health.ack.hideDetails" : "health.ack.showDetails")}
                    </button>
                    {open && details}
                </>
            ) : (
                details
            )}
        </li>
    );
}

/** 每項的修法；指令與設定名用 <code>，不翻譯。/ Each check's fix; commands and setting names in <code>, untranslated. */
function FixText({ id }: { id: HealthCheckId }) {
    const { t, tn } = useI18n();
    const c = (s: string) => <code className="[overflow-wrap:anywhere]">{s}</code>;
    const vars: Record<HealthCheckId, Record<string, React.ReactNode>> = {
        secret_key: { setting: c("SECRET_KEY"), env: c(".env") },
        public_url: { setting: c("PUBLIC_URL"), env: c(".env"), example: c("https://telepy.example.com") },
        internal_api_token: { setting: c("INTERNAL_API_TOKEN"), env: c(".env"), cmd: c("docker compose up -d") },
        data_dir: { path: c("/data"), host: c("./telepy-data") },
        log_dir: { path: c("/logs") },
        database: { cmd: c("docker compose exec backend telepy-server migrate"), df: c("df -h") },
        accounts: { cmd: c("docker compose exec backend telepy-server create-superuser --username <name> --password <password>") },
        tunnel_keys: { setting: c("SECRET_KEY") },
        service_key: { cmd: c("docker compose exec backend telepy-server keygen"), restart: c("docker compose restart backend") },
        shared_key: { setting: c("KEEP_SHARED_SERVICE_KEY"), env: c(".env") },
        gateway: { cmd: c("docker compose exec backend telepy-server keygen"), dir: c("ssh/ssh_host_keys") },
        ssh_host: { setting: c("SSH_SERVER_DOMAIN"), env: c(".env") },
        guacd: { cmd: c("docker compose up -d guacd"), net: c("telepy-desktop") },
        kasm: { cmd: c("docker compose up -d kasm-browser"), token: c("INTERNAL_API_TOKEN") },
        geoip: { cmd: c("docker compose exec backend telepy-server geoip"), panel: <a href="#datasets" className="underline underline-offset-2">{t("datasets.title")}</a> },
        oui: { cmd: c("docker compose exec backend telepy-server oui"), panel: <a href="#datasets" className="underline underline-offset-2">{t("datasets.title")}</a> },
        carriers: { cmd: c("docker compose exec backend telepy-server fetch-carriers"), dir: c("telepy-data/carriers"), panel: <a href="#carriers" className="underline underline-offset-2">{t("carriers.title")}</a> },
        client_addresses: {},
        audit_log: { file: c("audit-anchors.log"), mismatch: c("checkpoint_mismatch"), missing: c("checkpoint_missing") },
    };
    return <p>{tn(tKey(id, "fix"), vars[id])}</p>;
}
