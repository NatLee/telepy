"use client";

/**
 * OAuth 登入頁：MCP 應用程式（Claude、Cursor…）要求連接、使用者還沒登入時，同意頁把人送來這裡。一般樣子跟登入頁
 * 刻意不同：左側是「連接一個 app」的流程而不是產品介紹，表單上方是要求連接的 app、會導回哪裡、要哪些權限，
 * 下方可以取消回到 app。網站設定可以把它換成低調樣子（只寫 Telepy，留下 app 名稱與導回位址，權限到同意頁才列）。
 * 要求的是 `telepy` CLI（`telepy login`）時用 CLI 那個設定、文字改講終端機；兩個設定不一樣時，先等預覽說出是誰在要求才畫。
 * 登入後回到同意頁（?next=）。
 * OAuth sign-in page: where the consent page sends a signed-out user when an MCP app asks to connect. The standard
 * look is deliberately unlike the normal sign-in (connection flow aside, the requesting app with its return host
 * and scopes, a cancel back to the app); Site settings can switch it to the discreet look (only "Telepy", keeping
 * the app name and return host; scopes wait for the consent page). When the `telepy` CLI is asking (`telepy login`)
 * the CLI setting applies and the wording speaks of the terminal; when the two settings differ, the page waits for
 * the preview to say who is asking before it paints. Returns to ?next=.
 */
import React, { Suspense, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { DiscreetShell, SignInPending } from "@/components/auth/DiscreetShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { OAuthSignInScreen } from "@/components/auth/SignInScreens";
import { ConnectAppAside, OAuthProblem } from "@/components/oauth/ConnectFlow";
import { useOAuthPreview } from "@/hooks/useOAuthPreview";
import { useSignInLook } from "@/hooks/useSignInLook";
import { useI18n } from "@/lib/i18n";
import { authorizeQuery, loginPathFor } from "@/lib/oauthFlow";
import { needsClient, pageForClient, styleOf } from "@/lib/signinLook";

function OAuthLogin() {
    const { t } = useI18n();
    const router = useRouter();
    const look = useSignInLook();
    const next = useSearchParams().get("next");
    const query = useMemo(() => authorizeQuery(next), [next]);
    const { preview, error, loading } = useOAuthPreview(query);

    // 不是要回同意頁 → 一般登入頁。/ Not heading to the consent page → the normal sign-in.
    useEffect(() => {
        if (query === null) router.replace(loginPathFor(next));
    }, [query, next, router]);

    if (!look) return <SignInPending />;
    // 誰在要求還不知道、而 CLI 與應用程式的樣子不同：先畫空外框，不要先閃錯的樣子。/ Don't flash the wrong look.
    if (loading && needsClient(look)) return <SignInPending />;
    const style = styleOf(look, pageForClient(preview?.client.client_name));

    if (error) {
        const problem = (
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
        );
        return style === "discreet" ? (
            <DiscreetShell message={look.message}>{problem}</DiscreetShell>
        ) : (
            <AuthShell wide aside={<ConnectAppAside step={0} />}>
                {problem}
            </AuthShell>
        );
    }

    return (
        <OAuthSignInScreen
            style={style}
            message={look.message}
            Form={LoginForm}
            app={{ name: preview?.client.client_name, host: preview?.redirect_host, scopes: preview?.scopes.map((s) => s.name), loading }}
            onCancel={preview ? () => window.location.assign(preview.cancel_to) : undefined}
        />
    );
}

/**
 * 查詢參數在 Suspense 裡讀；外面先畫空的外框（兩種樣子共用，靜態 HTML 不帶任何介紹）。
 * The query is read inside Suspense; the fallback is the empty frame shared by both looks (no copy in the static HTML).
 */
export default function OAuthLoginPage() {
    return (
        <Suspense fallback={<SignInPending />}>
            <OAuthLogin />
        </Suspense>
    );
}
