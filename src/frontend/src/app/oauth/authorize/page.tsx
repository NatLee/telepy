"use client";

/**
 * OAuth 2.1 同意頁（authorization_endpoint）：MCP 應用程式把使用者導來這裡。跟 OAuth 登入頁（/oauth/login）同一個
 * 外框與流程面板（登入 → 決定 → 回到 app），看起來跟一般登入頁不同。顯示是哪個應用程式、要導回哪裡（redirect host，
 * 因為動態註冊是開放的，名稱可被冒用）、目前登入的帳號（不是你？換帳號）、先前的連線、要哪些權限、可用哪些隧道；
 * 決定後導回客戶端並停在結果畫面。
 * OAuth 2.1 consent page. Same frame and flow panel as the OAuth sign-in (sign in → decide → back to the app),
 * unlike the normal sign-in. Shows the app and its redirect host (names are attacker-controlled under open
 * registration), the signed-in account with "Not you?", earlier connections, permissions and tunnels; after the
 * decision the browser goes back to the client and the page stays on a result view.
 */
import React, { Suspense } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { cliHost } from "@/lib/cliClient";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignInPending } from "@/components/auth/DiscreetShell";
import { EnrollmentGate } from "@/components/auth/EnrollmentGate";
import { AppTile, ConnectAppAside, ConnectProgress, OAuthProblem, ReturnsTo, type ConnectStep } from "@/components/oauth/ConnectFlow";
import { AccountRow, ConsentSkeleton, DecisionView, ExistingConnection, ScopeChoices, TunnelChoice } from "@/components/oauth/ConsentSections";
import { Button } from "@/components/ui/button";
import { useOAuthConsent } from "@/hooks/useOAuthConsent";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

function ConsentInner() {
    const { t } = useI18n();
    const { isAuthenticated, isLoading } = useAuth();
    const { state, actions, reauthDialog } = useOAuthConsent();
    const { info, error, loading, submitting, selectedScopes, tunnelMode, tunnelIds, tunnelQuery, allTunnels, shownTunnels, replace, decision, enrollMissing, canApprove, stepUpError } = state;

    // 還沒登入（正要被送去 /oauth/login）：只畫空外框，不先閃過連接流程（低調登入頁也不會露出）。
    // Signed out (about to go to /oauth/login): only the empty frame, so the connection flow never flashes by.
    if (isLoading || !isAuthenticated) return <SignInPending />;

    // 管理員要求兩步驟而帳號還沒設好：先設定，完成後回到這個請求。/ Required two-step setup first, then back here.
    if (enrollMissing) return <EnrollmentGate missing={enrollMissing} onDone={actions.enrollmentDone} />;

    const appName = info?.client.client_name ?? "";
    // `telepy` CLI（`telepy login`）在要求：同一套 OAuth，但不是 AI app——標題、說明、取代與上限都講 CLI。
    // The CLI asking: the same OAuth, but not an AI app, so the title, notes, replace and limit speak of the CLI.
    const host = info?.cli ? info.cli.host : cliHost(appName);
    const isCli = host !== null;
    const step: ConnectStep = decision ? 2 : 1;
    const frame = (children: React.ReactNode) => (
        <AuthShell wide aside={<ConnectAppAside step={step} appName={appName || null} />}>
            <ConnectProgress step={step} appName={appName || null} />
            {children}
        </AuthShell>
    );

    if (loading) return frame(<ConsentSkeleton />);

    if (error || !info) {
        return frame(<OAuthProblem description={error?.error_description ?? t("oauth.loadFailed")} code={error?.error} redirectTo={error?.redirect_to} />);
    }

    if (decision) return frame(<DecisionView approved={decision.approved} app={appName} onReopen={actions.reopen} cli={isCli} />);

    // CLI 登入的上限：這次核可後會有幾個（取代的不算），超過就說最久沒用的那個會登出。
    // The CLI limit: how many sign-ins there will be after this approval (replaced ones gone); over it, the oldest goes.
    const existingCount = info.existing?.length ?? 0;
    const cliAfter = info.cli ? info.cli.signed_in + 1 - (replace ? existingCount : 0) : 0;
    const cliOver = !!info.cli && cliAfter > info.cli.limit;
    const tunnelSummary = tunnelMode === "all" ? t("oauth.summaryAllTunnels") : t("oauth.summarySomeTunnels", { count: tunnelIds.length });

    return frame(
        <div>
            {/* 誰在要求、會導回哪裡（防冒名）。/ Who is asking and where it returns (anti-impersonation). */}
            <header className="flex items-start gap-3">
                <AppTile appName={appName} />
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight break-words text-foreground">{isCli ? "telepy CLI" : appName}</h1>
                    <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{isCli ? t("oauth.cli.wantsAccess", { host: host || t("oauth.cli.thisComputer") }) : t("oauth.wantsAccess")}</p>
                </div>
            </header>
            {isCli && (
                <Callout tone="info" title={t("oauth.cli.notAppTitle")} className="mt-4">
                    {t("oauth.cli.notAppBody")}
                </Callout>
            )}
            <div className="mt-3 space-y-1">
                <ReturnsTo host={info.redirect_host} />
                <p className="text-xs leading-relaxed text-muted-foreground">{t("oauth.redirectHostHint")}</p>
            </div>

            <div className="mt-6">
                <AccountRow username={info.user.username} onSwitch={actions.switchAccount} disabled={submitting} />
            </div>

            {info.existing && info.existing.length > 0 && (
                <div className="mt-4">
                    <ExistingConnection app={appName} existing={info.existing} replace={replace} onReplace={actions.setReplace} cliHost={isCli ? host : null} />
                </div>
            )}

            <div className="mt-8 space-y-8">
                <ScopeChoices scopes={info.scopes} selected={selectedScopes} onToggle={actions.toggleScope} hint={isCli ? t("oauth.cli.permissionsHint") : undefined} />
                <TunnelChoice
                    hint={isCli ? t("oauth.cli.tunnelsHint") : undefined}
                    emptyText={isCli ? t("oauth.cli.noTunnels") : undefined}
                    all={allTunnels}
                    shown={shownTunnels}
                    mode={tunnelMode}
                    selected={tunnelIds}
                    query={tunnelQuery}
                    onMode={actions.setTunnelMode}
                    onToggle={actions.toggleTunnel}
                    onQuery={actions.setTunnelQuery}
                    onShown={actions.setShownTunnels}
                />
            </div>

            <div className="mt-8 space-y-2 text-xs leading-relaxed text-muted-foreground">
                {isCli ? (
                    <p>{info.cli ? t("oauth.cli.limitNote", { count: info.cli.signed_in, limit: info.cli.limit }) : t("oauth.cli.sessionNote")}</p>
                ) : (
                    <p>{t("oauth.sessionNote")}</p>
                )}
                {cliOver && <p className="text-warning">{t("oauth.cli.limitFull", { limit: info.cli!.limit })}</p>}
                {info.reauth?.required && (
                    <p className="flex items-start gap-1.5">
                        <ShieldCheck size={14} className="mt-px shrink-0" aria-hidden />
                        {t("oauth.reauthHint")}
                    </p>
                )}
            </div>

            {/* 決定列黏在視窗底部：清單再長，按鈕與摘要都看得到。/ The decision bar sticks to the bottom of the viewport. */}
            <div className="sticky bottom-0 z-10 mt-6 border-t border-border bg-background pt-3 pb-4">
                {stepUpError && <p className="mb-2 text-sm text-destructive">{stepUpError}</p>}
                <p className="mb-2 text-xs text-muted-foreground">{t("oauth.summary", { scopes: selectedScopes.length, total: info.scopes.length, tunnels: tunnelSummary })}</p>
                <div className="flex gap-3">
                    <Button variant="outline" className="h-11 flex-1" disabled={submitting} onClick={actions.deny}>
                        {t("oauth.deny")}
                    </Button>
                    <Button className="h-11 flex-[2] font-semibold" disabled={!canApprove} onClick={actions.approve}>
                        {submitting ? (
                            <span className="size-5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" aria-hidden />
                        ) : (
                            <>
                                <Check size={16} aria-hidden /> {t("oauth.approve")}
                            </>
                        )}
                    </Button>
                </div>
            </div>
            {reauthDialog}
        </div>
    );
}

export default function OAuthAuthorizePage() {
    // useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <ConsentInner />
        </Suspense>
    );
}
