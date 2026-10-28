"use client";

/**
 * API 頁（可以建 API token 或用 `telepy login` 瀏覽器登入的人）：基底網址（頁首的動作列放資訊按鈕〔幾條進 Telepy 的路怎麼比〕、
 * CLI 頁與完整參考），以及四個分頁——你的 token（建立 / 撤銷 / 每把的呼叫摘要）、CLI 登入（每次 `telepy login` 一個，跟 MCP
 * app 一樣走 OAuth，但列在這裡而不是 MCP app 裡）、token 能打哪些端點（伺服器的白名單，CLI 登入也一樣）、活動（自己的呼叫紀錄）。
 * 分頁在 `?tab=`，活動的篩選在 `?token=` / `?grant=`，所以每一列都能直接連到它的紀錄。全站的紀錄在管理區。
 * The API page (everyone who may create API tokens or sign the CLI in with the browser): the base URL (header actions:
 * the info button for the ways into Telepy, the CLI guide and the full reference) and four tabs — your tokens, CLI
 * sign-ins (one per `telepy login`; OAuth like an MCP app, but listed here, not among MCP apps), what a token can call
 * (the server's allow-list, the same for CLI sign-ins) and the activity (your own call log). The tab lives in `?tab=`
 * and the activity's filter in `?token=` / `?grant=`, so each row links straight to its calls. Everyone's calls are in
 * the admin section.
 */
import React, { Suspense, useCallback, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Braces, ExternalLink, Info, TerminalSquare } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AdminViewLink } from "@/components/layout/AdminViews";
import { Segmented } from "@/components/ui/segmented";
import { ApiTokens } from "@/components/tokens/ApiTokens";
import { CliSignIns } from "@/components/tokens/CliSignIns";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { ApiOverview, API_BASE } from "@/components/api/ApiOverview";
import { WaysInDialog } from "@/components/api/WaysInDialog";
import { ApiCatalogue } from "@/components/api/ApiCatalogue";
import { ApiCallsView } from "@/components/api/ApiCallsView";
import { useApiCatalogue } from "@/hooks/useApiCatalogue";
import { useApiTokens } from "@/hooks/useApiTokens";
import { useOAuthGrants } from "@/hooks/useOAuthGrants";
import { useAuth } from "@/lib/auth";
import { hasFeature } from "@/lib/features";
import { useI18n } from "@/lib/i18n";
import type { ApiToken } from "@/lib/apiTokens";
import type { OAuthGrant } from "@/types/oauth";

const TABS = ["tokens", "cli", "endpoints", "activity"] as const;
type Tab = (typeof TABS)[number];

function ApiPageInner() {
    const { t } = useI18n();
    const { user } = useAuth();
    const [howOpen, setHowOpen] = useState(false);
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    // 「你的 token」要 API token 這個功能；只開了瀏覽器登入（MCP app）的人從 CLI 登入開始。
    // "Your tokens" needs the API tokens feature; someone with only browser sign-in (MCP apps) starts on CLI sign-ins.
    const tokensOn = hasFeature(user, "api.tokens");
    const tabs = TABS.filter((x) => x !== "tokens" || tokensOn);
    const first: Tab = tokensOn ? "tokens" : "cli";
    const raw = params.get("tab");
    const tab: Tab = (tabs as readonly string[]).includes(raw ?? "") ? (raw as Tab) : first;
    const { catalogue, baseUrl } = useApiCatalogue();
    // 活動的篩選要 token 與 CLI 登入的清單；換到活動分頁時重抓（可能剛建了一把 / 剛登入）。
    // The activity filter needs the tokens and CLI sign-ins; refetched on the tab (one may have just been added).
    const { tokens, reload } = useApiTokens();
    const { cli: cliSignIns, reload: reloadGrants } = useOAuthGrants();

    const go = useCallback(
        (next: Tab, extra?: Record<string, string>) => {
            const qs = new URLSearchParams();
            if (next !== first) qs.set("tab", next);
            for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
            const s = qs.toString();
            router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
            if (next === "activity") {
                void reload();
                void reloadGrants();
            }
        },
        [router, pathname, reload, reloadGrants, first]
    );
    const showCalls = useCallback((tok: ApiToken) => go("activity", { token: String(tok.id) }), [go]);
    const showSignInCalls = useCallback((g: OAuthGrant) => go("activity", { grant: String(g.id) }), [go]);

    const labels: Record<Tab, string> = { tokens: t("apiPage.tab.tokens"), cli: t("apiPage.tab.cli"), endpoints: t("apiPage.tab.endpoints"), activity: t("apiPage.tab.activity") };

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                // 三顆按鈕很寬，到 xl 才與說明並排，否則說明會被擠成一直條。/ Three wide buttons: side by side with the description only from xl.
                className="sm:flex-col sm:items-start sm:justify-start xl:flex-row xl:items-end xl:justify-between"
                icon={<Braces />}
                title={t("apiPage.title")}
                description={t("apiPage.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setHowOpen(true)}>
                            <Info size={16} /> {t("apiPage.how.show")}
                        </Button>
                        <Button variant="outline" asChild>
                            <Link href="/tunnels/cli">
                                <TerminalSquare size={16} /> {t("apiPage.cliDoc")}
                            </Link>
                        </Button>
                        {hasFeature(user, "api.docs") && (
                            <Button variant="outline" asChild>
                                <a href={`${API_BASE}/api/__hidden_swagger`} target="_blank" rel="noopener noreferrer">
                                    <BookOpen size={16} /> {t("apiPage.fullReference")}
                                    <ExternalLink size={12} className="opacity-60" aria-hidden />
                                </a>
                            </Button>
                        )}
                    </>
                }
            />
            <WaysInDialog isOpen={howOpen} onClose={() => setHowOpen(false)} />
            <AdminViewLink href="/tunnels/admin/api-activity" label={t("nav.adminApiActivity")} note={t("apiPage.adminNote")} />
            <ApiOverview baseUrl={baseUrl} />
            {/* 手機上四個分頁排成 2 × 2、字可以換行，不會被捲到看不見。/ On phones the tabs sit 2 × 2 and wrap. */}
            <Segmented
                kind="tabs"
                fullWidth
                className={tabs.length > 3 ? "max-sm:grid-flow-row max-sm:grid-cols-2 sm:inline-grid sm:w-auto" : "sm:inline-grid sm:w-auto"}
                aria-label={t("apiPage.title")}
                value={tab}
                onChange={(v) => go(v)}
                options={tabs.map((x) => ({ value: x, label: labels[x] }))}
            />
            {tab === "tokens" && (
                <section aria-label={labels.tokens} className="space-y-3">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("tokens.description")}</p>
                    <ApiTokens hideHeading onShowCalls={showCalls} />
                </section>
            )}
            {tab === "cli" && (
                <section aria-label={labels.cli} className="space-y-3">
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("cliSignIns.description")}</p>
                    {/* 為什麼看起來跟連接 MCP app 一樣：同一套 OAuth，但它是 Telepy 自己的命令列。/ Why it looks like connecting an MCP app. */}
                    <Callout tone="info" title={t("cliSignIns.whyTitle")}>
                        {t("cliSignIns.whyBody")}
                    </Callout>
                    <CliSignIns hideHeading onShowCalls={showSignInCalls} />
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
                    <ApiCallsView scope="mine" tokens={tokensOn ? tokens : []} signIns={cliSignIns} />
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
