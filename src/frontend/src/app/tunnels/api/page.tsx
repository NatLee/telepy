"use client";

/**
 * API 頁（每個可以建立 API token 的人）：總覽（三條進 Telepy 的路怎麼比、基底網址、CLI 文件與完整參考），以及三個分頁——
 * 你的 token（建立 / 撤銷 / 每把的呼叫摘要，從偏好設定搬過來）、token 能打哪些端點（伺服器的白名單）、活動（自己的呼叫紀錄）。
 * 分頁在 `?tab=`，活動的 token 篩選在 `?token=`，所以 token 那一列能直接連過去。全站的紀錄在管理區。
 * The API page (everyone who may create API tokens): the overview (the three ways into Telepy compared, the base
 * URL, the CLI guide and the full reference) and three tabs — your tokens (moved from Preferences), what a token can
 * call (the server's allow-list) and the activity (your own call log). The tab lives in `?tab=` and the activity's
 * token filter in `?token=`, so a token row links straight to its calls. Everyone's calls are in the admin section.
 */
import React, { Suspense, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AdminViewLink } from "@/components/layout/AdminViews";
import { Segmented } from "@/components/ui/segmented";
import { ApiTokens } from "@/components/tokens/ApiTokens";
import { ApiOverview } from "@/components/api/ApiOverview";
import { ApiCatalogue } from "@/components/api/ApiCatalogue";
import { ApiCallsView } from "@/components/api/ApiCallsView";
import { useApiCatalogue } from "@/hooks/useApiCatalogue";
import { useApiTokens } from "@/hooks/useApiTokens";
import { useI18n } from "@/lib/i18n";
import type { ApiToken } from "@/lib/apiTokens";

const TABS = ["tokens", "endpoints", "activity"] as const;
type Tab = (typeof TABS)[number];

function ApiPageInner() {
    const { t } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const raw = params.get("tab");
    const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "tokens";
    const { catalogue, baseUrl } = useApiCatalogue();
    // 活動的 token 篩選要清單；換到活動分頁時重抓（可能剛建了一把）。/ The activity filter needs the list; refetched on the tab.
    const { tokens, reload } = useApiTokens();

    const go = useCallback(
        (next: Tab, extra?: Record<string, string>) => {
            const qs = new URLSearchParams();
            if (next !== "tokens") qs.set("tab", next);
            for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
            const s = qs.toString();
            router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
            if (next === "activity") void reload();
        },
        [router, pathname, reload]
    );
    const showCalls = useCallback((tok: ApiToken) => go("activity", { token: String(tok.id) }), [go]);

    const labels: Record<Tab, string> = { tokens: t("apiPage.tab.tokens"), endpoints: t("apiPage.tab.endpoints"), activity: t("apiPage.tab.activity") };

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader icon={<Braces />} title={t("apiPage.title")} description={t("apiPage.subtitle")} />
            <AdminViewLink href="/tunnels/admin/api-activity" label={t("nav.adminApiActivity")} note={t("apiPage.adminNote")} />
            <ApiOverview baseUrl={baseUrl} />
            {/* 手機上三個分頁平分寬度、字可以換行，不會被捲到看不見。/ On phones the tabs share the width and wrap. */}
            <Segmented kind="tabs" fullWidth className="sm:inline-grid sm:w-auto" aria-label={t("apiPage.title")} value={tab} onChange={(v) => go(v)} options={TABS.map((x) => ({ value: x, label: labels[x] }))} />
            {tab === "tokens" && (
                <section aria-label={labels.tokens} className="space-y-3">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("tokens.description")}</p>
                    <ApiTokens hideHeading onShowCalls={showCalls} />
                </section>
            )}
            {tab === "endpoints" && (
                <section aria-label={labels.endpoints} className="space-y-3">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("apiPage.endpointsIntro")}</p>
                    <ApiCatalogue routes={catalogue?.routes ?? null} baseUrl={baseUrl} />
                </section>
            )}
            {tab === "activity" && (
                <section aria-label={labels.activity}>
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("apiPage.activityIntro")}</p>
                    <ApiCallsView scope="mine" tokens={tokens} />
                </section>
            )}
        </div>
    );
}

export default function ApiPage() {
    // useSearchParams（`?tab=` / `?token=`）需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <ApiPageInner />
        </Suspense>
    );
}
