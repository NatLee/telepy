"use client";

/**
 * 授權（同意）頁的畫面，依網站設定的樣子（網站設定 → 登入 → 授權頁）畫外框：一般 = 「連接一個 app」的流程面板 +
 * 步驟條；低調 = 只寫 Telepy 的低調外框，卡片寬一點。內容（誰在要求、導回哪裡、帳號、先前的連線、權限、隧道、
 * 決定列）兩種樣子都一樣——同意要看清楚。真的頁面與網站設定的預覽共用這組元件（預覽給範例資料、不做事的動作）。
 * The approval (consent) page for each look (Site settings → Sign-in → approval page): standard = the
 * "connect an app" flow panel and step strip; discreet = the plain "Telepy" frame with a wider card. The content (who
 * is asking, where it returns, the account, earlier connections, scopes, tunnels, the decision bar) is the same in
 * both — consent must stay readable. The real page and the settings preview share these components (the preview
 * passes sample data and inert actions).
 */
import React from "react";
import { Check, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { DiscreetShell } from "@/components/auth/DiscreetShell";
import { AppTile, ConnectAppAside, ConnectProgress, ReturnsTo, type ConnectStep } from "@/components/oauth/ConnectFlow";
import { AccountRow, ExistingConnection, ScopeChoices, TunnelChoice } from "@/components/oauth/ConsentSections";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cliHost } from "@/lib/cliClient";
import type { ConsentInfo, ConsentTunnel } from "@/hooks/useOAuthConsent";
import { useI18n } from "@/lib/i18n";
import type { SignInStyle } from "@/lib/signinLook";
import { cn } from "@/lib/utils";

/** 授權頁的外框。`pin` = 設定頁預覽正在看的那句。/ The approval page's frame; `pin` = the line the settings preview shows. */
export function ConsentFrame({
    style,
    message,
    pin,
    step,
    appName,
    children,
}: {
    style: SignInStyle;
    message: string;
    pin?: number | null;
    step: ConnectStep;
    appName?: string | null;
    children: React.ReactNode;
}) {
    if (style === "discreet") {
        return (
            <DiscreetShell message={message} pin={pin} wide>
                {children}
            </DiscreetShell>
        );
    }
    return (
        <AuthShell wide aside={<ConnectAppAside step={step} appName={appName || null} />}>
            <ConnectProgress step={step} appName={appName || null} />
            {children}
        </AuthShell>
    );
}

export interface ConsentFormState {
    info: ConsentInfo;
    selectedScopes: string[];
    tunnelMode: "all" | "some";
    tunnelIds: number[];
    tunnelQuery: string;
    allTunnels: ConsentTunnel[];
    shownTunnels: ConsentTunnel[];
    replace: boolean;
    submitting: boolean;
    canApprove: boolean;
    stepUpError: string | null;
}

export interface ConsentFormActions {
    switchAccount: () => void;
    setReplace: (v: boolean) => void;
    toggleScope: (name: string) => void;
    setTunnelMode: (m: "all" | "some") => void;
    toggleTunnel: (id: number) => void;
    setTunnelQuery: (q: string) => void;
    setShownTunnels: (on: boolean) => void;
    approve: () => void;
    deny: () => void;
}

/**
 * 同意的內容與決定列。`surface` = 外框的底色（低調卡片是 card），黏在底部的決定列要蓋住捲過去的內容。
 * The consent content and decision bar. `surface` = the frame's background (the discreet card is `card`), so the
 * sticky decision bar covers what scrolls under it.
 */
export function ConsentForm({ state, actions, surface = "background" }: { state: ConsentFormState; actions: ConsentFormActions; surface?: "background" | "card" }) {
    const { t } = useI18n();
    const { info, selectedScopes, tunnelMode, tunnelIds, tunnelQuery, allTunnels, shownTunnels, replace, submitting, canApprove, stepUpError } = state;
    const appName = info.client.client_name;
    // `telepy` CLI（`telepy login`）在要求：同一套 OAuth，但不是 AI app——標題、說明、取代與上限都講 CLI。
    // The CLI asking: the same OAuth, but not an AI app, so the title, notes, replace and limit speak of the CLI.
    const host = info.cli ? info.cli.host : cliHost(appName);
    const isCli = host !== null;
    // CLI 登入的上限：這次核可後會有幾個（取代的不算），超過就說最久沒用的那個會登出。
    // The CLI limit: how many sign-ins there will be after this approval (replaced ones gone); over it, the oldest goes.
    const existingCount = info.existing?.length ?? 0;
    const cliAfter = info.cli ? info.cli.signed_in + 1 - (replace ? existingCount : 0) : 0;
    const cliOver = !!info.cli && cliAfter > info.cli.limit;
    const tunnelSummary = tunnelMode === "all" ? t("oauth.summaryAllTunnels") : t("oauth.summarySomeTunnels", { count: tunnelIds.length });
    return (
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
                {cliOver && info.cli && <p className="text-warning">{t("oauth.cli.limitFull", { limit: info.cli.limit })}</p>}
                {info.reauth?.required && (
                    <p className="flex items-start gap-1.5">
                        <ShieldCheck size={14} className="mt-px shrink-0" aria-hidden />
                        {t("oauth.reauthHint")}
                    </p>
                )}
            </div>

            {/* 決定列黏在視窗底部：清單再長，按鈕與摘要都看得到。/ The decision bar sticks to the bottom of the viewport. */}
            <div className={cn("sticky bottom-0 z-10 mt-6 border-t border-border pt-3 pb-4", surface === "card" ? "bg-card" : "bg-background")}>
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
        </div>
    );
}
