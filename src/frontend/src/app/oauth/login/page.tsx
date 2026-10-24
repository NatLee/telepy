"use client";

/**
 * OAuth 登入頁：MCP 應用程式（Claude、Cursor…）要求連接、使用者還沒登入時，同意頁把人送來這裡。跟一般登入頁
 * 刻意不同：左側是「連接一個 app」的流程而不是產品介紹，表單上方是要求連接的 app、會導回哪裡、要哪些權限，
 * 下方可以取消回到 app。登入後回到同意頁（?next=）。
 * OAuth sign-in page: where the consent page sends a signed-out user when an MCP app asks to connect.
 * Deliberately unlike the normal sign-in: the side panel shows the connection flow, the form is topped by the
 * requesting app (name, return host, scopes) and ends with a cancel back to the app. Returns to ?next=.
 */
import React, { Suspense, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { AppRequestCard, ConnectAppAside, ConnectProgress, OAuthProblem } from "@/components/oauth/ConnectFlow";
import { useOAuthPreview } from "@/hooks/useOAuthPreview";
import { useI18n } from "@/lib/i18n";
import { authorizeQuery, loginPathFor } from "@/lib/oauthFlow";

function OAuthLogin() {
    const { t, tn } = useI18n();
    const router = useRouter();
    const next = useSearchParams().get("next");
    const query = useMemo(() => authorizeQuery(next), [next]);
    const { preview, error, loading } = useOAuthPreview(query);

    // 不是要回同意頁 → 一般登入頁。/ Not heading to the consent page → the normal sign-in.
    useEffect(() => {
        if (query === null) router.replace(loginPathFor(next));
    }, [query, next, router]);

    const appName = preview?.client.client_name;

    if (error) {
        return (
            <AuthShell wide aside={<ConnectAppAside step={0} />}>
                <OAuthProblem
                    description={error.error_description ?? t("oauth.loadFailed")}
                    code={error.error}
                    redirectTo={error.redirect_to}
                    footer={
                        <p className="text-center text-sm">
                            <Link href="/login" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                                {t("oauth.useNormalSignIn")}
                            </Link>
                        </p>
                    }
                />
            </AuthShell>
        );
    }

    return (
        <AuthShell aside={<ConnectAppAside step={0} appName={appName} />}>
            <LoginForm
                title={t("oauth.signInTitle")}
                description={t("oauth.signInSubtitle", { app: appName ?? t("oauth.theApp") })}
                googleText="continue_with"
                intro={
                    <>
                        <ConnectProgress step={0} />
                        <AppRequestCard loading={loading} name={appName} host={preview?.redirect_host} scopes={preview?.scopes.map((s) => s.name)} />
                    </>
                }
            />
            {preview && (
                <button
                    type="button"
                    onClick={() => window.location.assign(preview.cancel_to)}
                    className="mt-8 inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                    <CornerDownLeft size={14} aria-hidden />
                    {tn("oauth.cancelReturn", { host: <span className="font-mono">{preview.redirect_host}</span> })}
                </button>
            )}
        </AuthShell>
    );
}

/** 靜態外框先畫出來（OAuth 的樣子），查詢參數在 Suspense 裡讀。/ The OAuth frame renders first; the query is read inside Suspense. */
export default function OAuthLoginPage() {
    return (
        <Suspense fallback={<OAuthLoginFallback />}>
            <OAuthLogin />
        </Suspense>
    );
}

function OAuthLoginFallback() {
    const { t } = useI18n();
    return (
        <AuthShell aside={<ConnectAppAside step={0} />}>
            <ConnectProgress step={0} />
            <AppRequestCard loading />
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t("oauth.signInTitle")}</h1>
        </AuthShell>
    );
}
