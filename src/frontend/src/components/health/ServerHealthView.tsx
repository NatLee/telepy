"use client";

/**
 * 管理區「伺服器狀態」頁：`telepy-server doctor` 的每一項檢查（✗ 在前、✓ 在後）、總結一行、什麼時候跑的，下面接
 * 「Telepy 怎麼看你的位址」（從網站設定搬來：它是診斷，不是設定，而且「內部位址」小標的連結要有個管理區的落點）。
 * 每次重新整理都重跑（含審計鏈驗證），所以不輪詢。
 * The admin "Server health" page: every `telepy-server doctor` check (failures first, passes last), a summary line,
 * when it ran, then "How Telepy sees your address" (moved here from Site settings: it is a diagnostic, not a setting,
 * and the "Internal address" chip's link needs a home in the admin section). Every refresh reruns the checks (the
 * audit chain included), so the page never polls.
 */
import React, { useRef } from "react";
import { CircleAlert, CircleCheck, CircleX, HeartPulse, Info } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AdminChip } from "@/components/layout/AdminViews";
import { ClientIpCheckPanel } from "@/components/auth/ClientIpCheck";
import { Callout } from "@/components/ui/callout";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Chip } from "@/components/ui/section";
import { useServerHealth } from "@/hooks/useServerHealth";
import { useI18n } from "@/lib/i18n";
import { sortChecks, worstStatus, type HealthStatus } from "@/lib/serverHealth";
import type { TranslationKey } from "@/locales/en";

const STATUS_KEY: Record<HealthStatus, TranslationKey> = {
    ok: "health.status.ok",
    info: "health.status.info",
    warn: "health.status.warn",
    fail: "health.status.fail",
};

const STATUS_TONE: Record<HealthStatus, "success" | "neutral" | "warning" | "danger"> = { ok: "success", info: "neutral", warn: "warning", fail: "danger" };

function StatusChip({ status }: { status: HealthStatus }) {
    const { t } = useI18n();
    const Icon = status === "ok" ? CircleCheck : status === "fail" ? CircleX : status === "warn" ? CircleAlert : Info;
    return (
        <Chip tone={STATUS_TONE[status]} className="mt-px shrink-0">
            <Icon aria-hidden /> {t(STATUS_KEY[status])}
        </Chip>
    );
}

export function ServerHealthView() {
    const { t, tn, locale } = useI18n();
    const { health, failed, busy, reload } = useServerHealth();
    const listRef = useRef<HTMLDivElement>(null);
    const worst = health ? worstStatus(health.checks) : null;
    const code = (s: string) => <code>{s}</code>;

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<HeartPulse />}
                title={t("health.title")}
                titleAddon={<AdminChip />}
                description={t("health.description")}
                actions={<RefreshButton onRefresh={reload} busy={busy} failed={failed} ripple={listRef} label={t("common.refresh")} />}
            />

            <div ref={listRef} className="space-y-4">
                {failed && !health ? (
                    <Callout tone="danger">{t("health.failed")}</Callout>
                ) : !health ? (
                    <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                ) : (
                    <>
                        <Callout tone={worst === "fail" ? "danger" : worst === "warn" ? "warning" : "info"} title={t(worst === "fail" ? "health.summary.fail" : worst === "warn" ? "health.summary.warn" : "health.summary.ok")}>
                            <p>{t("health.counts", { ok: String(health.ok), info: String(health.info), warnings: String(health.warnings), failures: String(health.failures) })}</p>
                            {health.ranAt && <p className="mt-1 text-xs text-muted-foreground">{t("health.ranAt", { time: new Date(health.ranAt).toLocaleString(locale) })}</p>}
                        </Callout>

                        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                            <ol className="divide-y divide-border" data-refresh-list>
                                {sortChecks(health.checks).map((c) => (
                                    <li key={c.name} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-6">
                                        {/* 名稱換行、不截斷（"kasm-browser (remote browser)" 之類的長名）。/ Names wrap, never cut. */}
                                        <div className="flex items-start gap-2 sm:w-72 sm:shrink-0">
                                            <StatusChip status={c.status} />
                                            <span className="min-w-0 text-sm break-words text-foreground [overflow-wrap:anywhere]">{c.name}</span>
                                        </div>
                                        {/* 後端的說明照原文顯示（和 CLI 的 doctor 一樣）。/ The detail is the backend's own text, as in the CLI. */}
                                        <p className="min-w-0 text-sm break-words text-muted-foreground [overflow-wrap:anywhere]">{c.detail}</p>
                                    </li>
                                ))}
                            </ol>
                        </section>

                        <p className="text-xs text-muted-foreground">{tn("health.cliNote", { cli: code("./telepy.sh doctor") })}</p>
                    </>
                )}

                <ClientIpCheckPanel />
            </div>
        </div>
    );
}
