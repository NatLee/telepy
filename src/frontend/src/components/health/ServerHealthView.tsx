"use client";

/**
 * 管理區「伺服器狀態」頁：`telepy-server doctor` 的檢查分成左側分頁（總覽 + 設定 / 資料與審計 / 金鑰與閘道 / 相依服務 /
 * 訪客位址），分頁記在 `?tab=`。總覽 = 總結、要處理的項目、每組一格；每組 = 每項檢查一張卡（翻譯過的名稱、在檢查什麼、
 * 怎麼修，加上後端原文）。「訪客位址」分頁最後接「Telepy 怎麼看你的位址」。每次重新整理都重跑（含審計鏈驗證），不輪詢。
 * The admin "Server health" page: the `telepy-server doctor` checks in left side tabs (an overview + configuration /
 * data & audit / keys & gateway / companion services / visitor addresses), the tab kept in `?tab=`. The overview =
 * the summary, what needs action and one tile per group; each group = one card per check (translated title, what it
 * checks, how to fix it, plus the backend's own text). The addresses tab ends with "How Telepy sees your address".
 * Every refresh reruns the checks (the audit chain included), so the page never polls.
 */
import React, { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CircleAlert, CircleCheck, CircleX, Database, Globe, HeartPulse, Info, KeyRound, LayoutGrid, Puzzle, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AdminChip } from "@/components/layout/AdminViews";
import { ClientIpCheckPanel } from "@/components/auth/ClientIpCheck";
import { ServerHealthInfoDialog } from "@/components/health/ServerHealthInfoDialog";
import { ServerStats } from "@/components/health/ServerStats";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useServerHealth } from "@/hooks/useServerHealth";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
    HEALTH_GROUPS,
    checksIn,
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

function StatusChip({ status }: { status: HealthStatus }) {
    const { t } = useI18n();
    const Icon = STATUS_ICON[status];
    return (
        <Chip tone={STATUS_TONE[status]} className="shrink-0">
            <Icon aria-hidden /> {t(STATUS_KEY[status])}
        </Chip>
    );
}

/** 「2 項失敗 · 1 項警告」；全部通過 = 「全部正常」。/ "2 failures · 1 warning"; all passing = "All OK". */
function useCountsLine() {
    const { t } = useI18n();
    return (c: StatusCounts): string => {
        const parts: string[] = [];
        if (c.fail) parts.push(t(c.fail === 1 ? "health.n.failOne" : "health.n.fail", { n: String(c.fail) }));
        if (c.warn) parts.push(t(c.warn === 1 ? "health.n.warnOne" : "health.n.warn", { n: String(c.warn) }));
        if (c.info) parts.push(t(c.info === 1 ? "health.n.infoOne" : "health.n.info", { n: String(c.info) }));
        if (parts.length === 0) return c.ok ? t("health.n.allOk") : t("health.n.none");
        return parts.join(" · ");
    };
}

/** 側欄分頁的標籤：名稱 + 狀態點 + 要處理的數量。/ A tab label: name + status dot + how many need action. */
function TabLabel({ label, status, issues }: { label: string; status: "ok" | "warn" | "fail" | null; issues: number }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1.5">
            {label}
            {status && (
                <span
                    className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
                    role="img"
                    aria-label={t(status === "ok" ? "health.status.ok" : status === "warn" ? "health.status.warn" : "health.status.fail")}
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
    const { health, failed, busy, reload } = useServerHealth();
    const bodyRef = useRef<HTMLDivElement>(null);
    const [info, setInfo] = useState(false);
    // 每按一次重新整理就加一，讓即時數據也重抓。/ Bumped on every Refresh so the live stats reload too.
    const [reloadKey, setReloadKey] = useState(0);
    const refresh = () => {
        setReloadKey((n) => n + 1);
        return reload();
    };
    const wide = useMediaQuery("(min-width: 1024px)") === true;

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
    const overviewStatus = health ? worstStatus(health.checks) : null;
    const overviewIssues = health ? health.checks.filter((c) => c.status === "fail" || c.status === "warn").length : 0;

    const tabs: NavTab<HealthTab>[] = [
        { value: "overview", icon: <LayoutGrid />, label: <TabLabel label={t("health.tab.overview")} status={overviewStatus} issues={overviewIssues} />, hint: wide ? t("health.tab.overview.hint") : undefined },
        ...HEALTH_GROUPS.map((g) => {
            const Icon = GROUP_ICON[g];
            return { value: g, icon: <Icon />, label: <TabLabel label={t(GROUP_LABEL[g])} status={statuses?.[g] ?? null} issues={issues(g)} />, hint: wide ? t(GROUP_HINT[g]) : undefined };
        }),
    ];

    const pick = (next: HealthTab) => {
        setTab(next);
        setInfo(false);
    };

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

            <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-6">
                {/* 手機到平板是一列可橫捲的分頁，從 lg 起是黏在左側的一欄。/ A scrolling row below lg, a sticky left rail from lg. */}
                <div className="-mx-1 min-w-0 overflow-x-auto px-1 pb-0.5 lg:sticky lg:top-20 lg:m-0 lg:overflow-visible lg:p-0">
                    <NavTabs tabs={tabs} value={tab} onChange={setTab} aria-label={t("health.title")} className="sm:flex-row lg:flex-col" />
                </div>

                <div ref={bodyRef} className="min-w-0 space-y-4">
                    {failed && !health ? (
                        <Callout tone="danger">{t("health.failed")}</Callout>
                    ) : !health ? (
                        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                    ) : tab === "overview" ? (
                        <Overview health={health} onPick={setTab} reloadKey={reloadKey} />
                    ) : (
                        <GroupPanel health={health} group={tab} />
                    )}
                    {tab === "addresses" && <ClientIpCheckPanel />}
                    {health && tab === "overview" && <p className="text-xs text-muted-foreground">{tn("health.cliNote", { cli: <code>./telepy.sh doctor</code> })}</p>}
                </div>
            </div>

            <ServerHealthInfoDialog open={info} onClose={() => setInfo(false)} health={health} onPick={pick} />
        </div>
    );
}

/** 總結一行：最嚴重的一級、各級數量、什麼時候跑的。/ The summary: worst level, counts, when it ran. */
function Summary({ health }: { health: ServerHealth }) {
    const { t, locale } = useI18n();
    const worst = worstStatus(health.checks);
    const Icon = STATUS_ICON[worst];
    return (
        <section
            className={cn(
                "flex items-start gap-3 rounded-xl px-4 py-3.5 ring-1 ring-inset sm:px-5",
                worst === "fail" ? "bg-destructive/8 ring-destructive/20" : worst === "warn" ? "bg-warning/10 ring-warning/30" : "bg-success/8 ring-success/25",
            )}
        >
            <Icon size={20} className={cn("mt-0.5 shrink-0", STATUS_TEXT[worst])} aria-hidden />
            <div className="min-w-0 flex-1">
                <p className="text-base text-foreground">{t(worst === "fail" ? "health.summary.fail" : worst === "warn" ? "health.summary.warn" : "health.summary.ok")}</p>
                <p className="mt-0.5 text-sm text-foreground/85">
                    {t("health.counts", { ok: String(health.ok), info: String(health.info), warnings: String(health.warnings), failures: String(health.failures) })}
                </p>
                {health.ranAt && <p className="mt-1 text-xs text-muted-foreground">{t("health.ranAt", { time: new Date(health.ranAt).toLocaleString(locale) })}</p>}
            </div>
        </section>
    );
}

function checkTitle(t: ReturnType<typeof useI18n>["t"], c: HealthCheck) {
    return c.id ? t(tKey(c.id, "title")) : c.name;
}

function Overview({ health, onPick, reloadKey }: { health: ServerHealth; onPick: (tab: HealthTab) => void; reloadKey: number }) {
    const { t } = useI18n();
    const countsLine = useCountsLine();
    const todo = problems(health.checks);
    const statuses = groupStatuses(health.checks);
    const counts = groupCounts(health.checks);

    return (
        <>
            <Summary health={health} />

            <ServerStats reloadKey={reloadKey} />

            {todo.length > 0 && (
                <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                    <div className="px-4 pt-4 sm:px-6">
                        <SectionHeading title={t("health.todo.title")} description={t("health.todo.description")} />
                    </div>
                    <ol className="mt-3 divide-y divide-border border-t border-border" data-refresh-list>
                        {todo.map((c, i) => {
                            const g = groupOf(c);
                            return (
                                <li key={`${c.name}-${i}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
                                    <div className="flex min-w-0 flex-1 items-start gap-2">
                                        <StatusChip status={c.status} />
                                        <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{checkTitle(t, c)}</span>
                                    </div>
                                    <Button type="button" variant="ghost" size="sm" className="self-start sm:self-auto" onClick={() => onPick(g)}>
                                        {t("health.todo.open", { group: t(GROUP_LABEL[g]) })} <ArrowRight size={14} aria-hidden />
                                    </Button>
                                </li>
                            );
                        })}
                    </ol>
                </section>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-refresh-list>
                {HEALTH_GROUPS.map((g) => {
                    const Icon = GROUP_ICON[g];
                    const s = statuses[g];
                    const c = counts[g];
                    // 全是備註（或沒有檢查）= 灰點，不算「正常」。/ Only notes (or nothing) = a grey dot, not "OK".
                    const tone: HealthStatus = s === "ok" ? (c.ok === 0 ? "info" : "ok") : s;
                    return (
                        <button
                            key={g}
                            type="button"
                            onClick={() => onPick(g)}
                            className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/80 bg-card p-4 text-left text-card-foreground shadow-card transition-colors hover:border-border hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                            <span className="flex items-center gap-2">
                                <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                                <span className="min-w-0 flex-1 text-sm text-foreground">{t(GROUP_LABEL[g])}</span>
                                <span className={cn("size-2 shrink-0 rounded-full", tone === "info" ? "bg-muted-foreground/50" : STATUS_DOT[tone === "ok" ? "ok" : tone])} aria-hidden />
                            </span>
                            <span className="text-xs leading-snug text-muted-foreground">{t(GROUP_HINT[g])}</span>
                            <span className={cn("text-sm", STATUS_TEXT[tone])}>{countsLine(c)}</span>
                        </button>
                    );
                })}
            </div>
        </>
    );
}

function GroupPanel({ health, group }: { health: ServerHealth; group: HealthGroup }) {
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
                        <CheckCard key={`${c.name}-${i}`} check={c} />
                    ))}
                </ol>
            )}
        </>
    );
}

/** 一項檢查：翻譯過的名稱與說明、怎麼修（有問題時），加上後端原文。/ One check: translated title and purpose, how to fix it, the backend's own text. */
function CheckCard({ check }: { check: HealthCheck }) {
    const { t } = useI18n();
    const fix = check.id && check.status !== "ok" ? <FixText id={check.id} /> : null;
    return (
        <li className="space-y-3 rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-card sm:px-5">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                <StatusChip status={check.status} />
                <div className="min-w-0 flex-1">
                    <p className="text-base text-foreground [overflow-wrap:anywhere]">{check.id ? t(tKey(check.id, "title")) : check.name}</p>
                    {check.id && <p className="mt-0.5 text-sm text-muted-foreground">{t(tKey(check.id, "what"))}</p>}
                </div>
            </div>
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
        </li>
    );
}

/** 每項的修法；指令與設定名用 <code>，不翻譯。/ Each check's fix; commands and setting names in <code>, untranslated. */
function FixText({ id }: { id: HealthCheckId }) {
    const { tn } = useI18n();
    const c = (s: string) => <code className="[overflow-wrap:anywhere]">{s}</code>;
    const vars: Record<HealthCheckId, Record<string, React.ReactNode>> = {
        secret_key: { setting: c("SECRET_KEY"), env: c(".env") },
        public_url: { setting: c("PUBLIC_URL"), env: c(".env"), example: c("https://telepy.example.com") },
        internal_api_token: { setting: c("INTERNAL_API_TOKEN"), env: c(".env"), cmd: c("docker compose up -d") },
        data_dir: { path: c("/data"), host: c("./telepy-data") },
        log_dir: { path: c("/logs") },
        database: { cmd: c("./telepy.sh migration"), df: c("df -h") },
        accounts: { cmd: c("./telepy.sh create-superuser") },
        tunnel_keys: { setting: c("SECRET_KEY") },
        service_key: { cmd: c("./telepy.sh keygen"), restart: c("docker compose restart backend") },
        shared_key: { setting: c("KEEP_SHARED_SERVICE_KEY"), env: c(".env") },
        gateway: { cmd: c("./telepy.sh keygen"), dir: c("ssh/ssh_host_keys") },
        guacd: { cmd: c("docker compose up -d guacd"), net: c("telepy-desktop") },
        kasm: { cmd: c("docker compose up -d kasm-browser"), token: c("INTERNAL_API_TOKEN") },
        geoip: { cmd: c("./telepy.sh geoip") },
        oui: { cmd: c("./telepy.sh oui") },
        client_addresses: {},
        audit_log: { file: c("audit-anchors.log") },
    };
    return <p>{tn(tKey(id, "fix"), vars[id])}</p>;
}
