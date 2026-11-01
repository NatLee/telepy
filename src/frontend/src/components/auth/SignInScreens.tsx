"use client";

/**
 * 兩個登入頁的組成，依網站設定的樣子（一般 / 低調 / Tapi）畫外框。表單由呼叫端給：真的頁面用 LoginForm（會登入），
 * 網站設定的預覽用 LoginFormPreview（不登入、不導向）——所以預覽就是訪客看到的同一組元件。
 * How the two sign-in pages are put together for each look (standard / discreet / Tapi). The caller supplies the form:
 * the real pages pass LoginForm (signs in), the settings preview passes LoginFormPreview (inert), so the preview
 * is built from exactly the components a visitor gets.
 */
import React from "react";
import { AppWindow, CornerDownLeft, SquareTerminal } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHighlights } from "@/components/auth/AuthPanels";
import { DiscreetShell } from "@/components/auth/DiscreetShell";
import { TapiShell } from "@/components/auth/TapiShell";
import type { LoginFormProps } from "@/components/auth/LoginForm";
import { AppRequestCard, ConnectAppAside, ConnectProgress, ReturnsTo } from "@/components/oauth/ConnectFlow";
import { useI18n } from "@/lib/i18n";
import { cliHost } from "@/lib/cliClient";
import type { SignInStyle } from "@/lib/signinLook";

type FormComponent = React.ComponentType<LoginFormProps>;

/** 一般登入頁（/login）。`pin` = 設定頁預覽正在看的那句。/ The sign-in page; `pin` = the line the settings preview shows. */
export function SignInScreen({ style, message, Form, pin }: { style: SignInStyle; message: string; Form: FormComponent; pin?: number | null }) {
    const { t } = useI18n();
    if (style === "discreet") {
        return (
            <DiscreetShell message={message} pin={pin}>
                <Form title={t("discreet.signIn")} description={t("discreet.signInBody")} />
            </DiscreetShell>
        );
    }
    if (style === "tapi") {
        return (
            <TapiShell message={message} pin={pin}>
                <Form title={t("login.title")} description={t("tapiLook.signInBody")} />
            </TapiShell>
        );
    }
    return (
        <AuthShell aside={<AuthHighlights />}>
            <Form title={t("login.title")} description={t("login.subtitle")} />
        </AuthShell>
    );
}

export interface OAuthAppInfo {
    name?: string | null;
    host?: string;
    scopes?: string[];
    loading: boolean;
}

/** 「取消並回到 <host>」（CLI：回到終端機）。/ "Cancel and go back to <host>" (the CLI: to the terminal). */
function CancelToApp({ host, cli, onCancel }: { host: string; cli: boolean; onCancel: () => void }) {
    const { t, tn } = useI18n();
    return (
        <button
            type="button"
            onClick={onCancel}
            className="mt-8 inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
            <CornerDownLeft size={14} aria-hidden />
            {cli ? t("oauth.cli.cancel") : tn("oauth.cancelReturn", { host: <span className="font-mono">{host}</span> })}
        </button>
    );
}

/**
 * 低調樣子的 OAuth 說明：只寫要繼續到哪個應用程式、登入後回到哪裡（安全上要看得到），不列權限——權限在登入後的同意頁列出。
 * The discreet OAuth note: only which app is waiting and where it returns (that must stay visible); the scopes are
 * listed on the consent page after signing in.
 */
function DiscreetAppNote({ app }: { app: OAuthAppInfo }) {
    const { t } = useI18n();
    const Icon = cliHost(app.name) !== null ? SquareTerminal : AppWindow;
    return (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden>
                <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
                {app.loading ? (
                    <>
                        <span className="block h-4 w-36 animate-pulse rounded-sm bg-muted" />
                        <span className="mt-2 block h-3.5 w-28 animate-pulse rounded-sm bg-muted" />
                    </>
                ) : (
                    <>
                        <p className="text-sm text-foreground break-words">{t("discreet.oauthContinue", { app: app.name || t("oauth.theApp") })}</p>
                        {app.host && (
                            <div className="mt-1">
                                <ReturnsTo host={app.host} />
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/** MCP 應用程式的 OAuth 登入頁（/oauth/login）。/ The OAuth sign-in page. */
export function OAuthSignInScreen({
    style,
    message,
    Form,
    app,
    onCancel,
    pin,
}: {
    style: SignInStyle;
    message: string;
    Form: FormComponent;
    app: OAuthAppInfo;
    /** 有導回網址時才有「取消」。/ Only when the backend gave a cancel URL. */
    onCancel?: () => void;
    /** 設定頁預覽正在看的那句。/ The line the settings preview shows. */
    pin?: number | null;
}) {
    const { t } = useI18n();
    const host = cliHost(app.name);
    const cli = host !== null;
    const cancel = onCancel && app.host ? <CancelToApp host={app.host} cli={cli} onCancel={onCancel} /> : null;
    if (style === "discreet") {
        return (
            <DiscreetShell message={message} pin={pin}>
                <Form title={t("discreet.oauthTitle")} description={t("discreet.oauthBody")} googleText="continue_with" intro={<DiscreetAppNote app={app} />} />
                {cancel}
            </DiscreetShell>
        );
    }
    // Tapi 版不是低調：卡片上照樣列出應用程式、回到哪裡與權限。/ The Tapi look isn't discreet: the card lists the app, its return host and scopes.
    if (style === "tapi") {
        return (
            <TapiShell message={message} pin={pin}>
                <Form
                    title={t(cli ? "oauth.cli.signInTitle" : "oauth.signInTitle")}
                    description={cli ? t("oauth.cli.signInSubtitle", { host: host || t("oauth.cli.thisComputer") }) : t("oauth.signInSubtitle", { app: app.name ?? t("oauth.theApp") })}
                    googleText="continue_with"
                    intro={<AppRequestCard loading={app.loading} name={app.name ?? undefined} host={app.host} scopes={app.scopes} />}
                />
                {cancel}
            </TapiShell>
        );
    }
    return (
        <AuthShell aside={<ConnectAppAside step={0} appName={app.name} />}>
            <Form
                title={t(cli ? "oauth.cli.signInTitle" : "oauth.signInTitle")}
                description={cli ? t("oauth.cli.signInSubtitle", { host: host || t("oauth.cli.thisComputer") }) : t("oauth.signInSubtitle", { app: app.name ?? t("oauth.theApp") })}
                googleText="continue_with"
                intro={
                    <>
                        <ConnectProgress step={0} appName={app.name} />
                        <AppRequestCard loading={app.loading} name={app.name ?? undefined} host={app.host} scopes={app.scopes} />
                    </>
                }
            />
            {cancel}
        </AuthShell>
    );
}
