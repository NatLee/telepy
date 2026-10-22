"use client";

/**
 * OAuth 2.1 同意頁（authorization_endpoint）：MCP / AI 客戶端把使用者導來這裡；顯示是哪個應用程式、
 * 要導回哪裡（redirect host，因為動態註冊是開放的，名稱可被冒用）、要哪些權限、可用哪些隧道，
 * 核可後導回客戶端。沒登入會先去登入頁再回來。
 * OAuth 2.1 consent page: shows the app, its redirect host (names are attacker-controlled under open
 * registration), the requested permissions and the tunnels it may use; approving sends the browser back.
 */
import React, { Suspense } from "react";
import { Bot, Check, ExternalLink, Server, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { useOAuthConsent } from "@/hooks/useOAuthConsent";

// scope 名稱固定（後端 SCOPES），標籤走字典。/ Scope names are fixed by the backend; labels are translated.
const SCOPE_LABELS: Record<string, { label: TranslationKey; description: TranslationKey }> = {
    "tunnels:read": { label: "oauth.scope.tunnelsRead", description: "oauth.scope.tunnelsReadDescription" },
    "ssh:exec": { label: "oauth.scope.sshExec", description: "oauth.scope.sshExecDescription" },
    "ssh:files": { label: "oauth.scope.sshFiles", description: "oauth.scope.sshFilesDescription" },
    "network:scan": { label: "oauth.scope.networkScan", description: "oauth.scope.networkScanDescription" },
};

function ConsentInner() {
    const { t, tn } = useI18n();
    const { state, actions, reauthDialog } = useOAuthConsent();
    const { info, error, loading, submitting, selectedScopes, tunnelIds, effectiveTunnelIds, canApprove, stepUpError } = state;

    const shell = (children: React.ReactNode) => (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <div className="w-full max-w-lg bg-card text-card-foreground rounded-2xl shadow-2xl p-8 border border-border animate-in fade-in slide-in-from-bottom-8 duration-500">
                <div className="text-center mb-6">
                    <div className="inline-flex items-center justify-center w-14 h-14 bg-primary rounded-xl mb-3 shadow-lg shadow-primary/30">
                        <Bot size={28} className="text-primary-foreground" />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight">{t("oauth.title")}</h1>
                </div>
                {children}
            </div>
        </div>
    );

    if (loading) {
        return shell(
            <div className="flex flex-col items-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4" />
                <p className="text-muted-foreground text-sm">{t("oauth.loading")}</p>
            </div>
        );
    }

    if (error || !info) {
        return shell(
            <div className="space-y-4">
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 flex items-start gap-3">
                    <ShieldAlert size={20} className="text-destructive mt-0.5 shrink-0" />
                    <div className="text-sm">
                        <p className="font-semibold text-destructive">{t("oauth.errorTitle")}</p>
                        <p className="text-muted-foreground mt-1 break-words">{error?.error_description ?? t("oauth.loadFailed")}</p>
                        {error?.error && <p className="text-xs text-muted-foreground mt-1 font-mono">{error.error}</p>}
                    </div>
                </div>
                {error?.redirect_to ? (
                    <Button className="w-full" onClick={() => window.location.assign(error.redirect_to!)}>
                        <ExternalLink size={16} className="mr-2" /> {t("oauth.returnToApp")}
                    </Button>
                ) : (
                    <p className="text-xs text-center text-muted-foreground">{t("oauth.noReturn")}</p>
                )}
            </div>
        );
    }

    return shell(
        <div className="space-y-6">
            <p className="text-sm text-center text-muted-foreground">
                {tn("oauth.intro", { app: <strong className="text-foreground">{info.client.client_name}</strong>, user: <strong className="text-foreground">{info.user.username}</strong> })}
            </p>

            {/* 導回目標（防冒名）/ Redirect target, shown prominently */}
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
                <p className="text-xs text-muted-foreground">{t("oauth.redirectHostLabel")}</p>
                <p className="font-mono font-semibold break-all">{info.redirect_host}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("oauth.redirectHostHint")}</p>
            </div>

            {/* 權限 / Permissions */}
            <section>
                <h2 className="text-sm font-semibold flex items-center gap-2 mb-2">
                    <ShieldCheck size={15} className="text-primary" /> {t("oauth.permissions")}
                </h2>
                <ul className="space-y-2">
                    {info.scopes.map((s) => {
                        const labels = SCOPE_LABELS[s.name];
                        const checked = selectedScopes.includes(s.name);
                        return (
                            <li key={s.name}>
                                <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${checked ? "border-primary bg-primary/5" : "border-border"}`}>
                                    <input type="checkbox" className="mt-1 accent-primary" checked={checked} onChange={() => actions.toggleScope(s.name)} />
                                    <span className="text-sm">
                                        <span className="font-medium">{labels ? t(labels.label) : s.name}</span>
                                        <span className="block text-xs text-muted-foreground">{labels ? t(labels.description) : s.description}</span>
                                    </span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
                {selectedScopes.length === 0 && <p className="text-xs text-destructive mt-2">{t("oauth.needOneScope")}</p>}
            </section>

            {/* 隧道 / Tunnels */}
            <section>
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                        <Server size={15} className="text-primary" /> {t("oauth.tunnels")}
                    </h2>
                    {tunnelIds !== null && (
                        <button type="button" className="text-xs text-primary hover:underline" onClick={actions.selectAllTunnels}>
                            {t("oauth.allTunnels")}
                        </button>
                    )}
                </div>
                {info.tunnels.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("oauth.noTunnels")}</p>
                ) : (
                    <>
                        <p className="text-xs text-muted-foreground mb-2">{tunnelIds === null ? t("oauth.tunnelsAllHint") : t("oauth.tunnelsSomeHint", { count: effectiveTunnelIds.length })}</p>
                        <ul className="max-h-44 overflow-auto rounded-lg border border-border divide-y divide-border">
                            {info.tunnels.map((tun) => {
                                const checked = effectiveTunnelIds.includes(tun.id);
                                return (
                                    <li key={tun.id}>
                                        <label className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
                                            <input type="checkbox" className="accent-primary" checked={checked} onChange={() => actions.toggleTunnel(tun.id)} />
                                            <span className="flex-1 truncate">{tun.name}</span>
                                            {tun.permission && <span className="text-xs text-muted-foreground">{tun.permission}</span>}
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
                {tunnelIds !== null && tunnelIds.length === 0 && <p className="text-xs text-destructive mt-2">{t("oauth.needOneTunnel")}</p>}
            </section>

            <p className="text-xs text-muted-foreground">{t("oauth.sessionNote")}</p>
            {info.reauth?.required && <p className="text-xs text-muted-foreground">{t("oauth.reauthHint")}</p>}
            {stepUpError && <p className="text-sm text-destructive">{stepUpError}</p>}

            <div className="flex gap-3">
                <Button variant="outline" className="flex-1" disabled={submitting} onClick={actions.deny}>
                    {t("oauth.deny")}
                </Button>
                <Button className="flex-1 font-bold" disabled={!canApprove} onClick={actions.approve}>
                    {submitting ? <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> : (<><Check size={16} className="mr-2" /> {t("oauth.approve")}</>)}
                </Button>
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
