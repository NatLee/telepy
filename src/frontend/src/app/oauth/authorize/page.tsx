"use client";

/**
 * OAuth 2.1 同意頁（authorization_endpoint）：MCP 應用程式與 `telepy login` 把使用者導來這裡。樣子由網站設定決定
 * （網站設定 → 登入 → 授權頁）：一般 = 跟 OAuth 登入頁（/oauth/login）同一個外框與流程面板（登入 → 決定 → 回到 app）；
 * 低調 = 只寫 Telepy 的低調外框。兩種樣子的內容一樣：哪個應用程式、要導回哪裡（redirect host，因為動態註冊是開放的，
 * 名稱可被冒用）、目前登入的帳號（不是你？換帳號）、先前的連線、要哪些權限、可用哪些隧道；決定後導回客戶端並停在結果畫面
 * （CLI 的話，終端機會把瀏覽器再送到 /oauth/done）。
 * OAuth 2.1 consent page. Its look comes from Site settings → Sign-in → approval page: standard = the OAuth sign-in's
 * frame and flow panel (sign in → decide → back to the app); discreet = the plain "Telepy" frame. Both show the same
 * content: the app and its redirect host (names are attacker-controlled under open registration), the signed-in
 * account with "Not you?", earlier connections, permissions and tunnels; after the decision the browser goes back to
 * the client and the page stays on a result view (for the CLI, the terminal sends the browser on to /oauth/done).
 */
import React, { Suspense } from "react";
import { SignInPending } from "@/components/auth/DiscreetShell";
import { EnrollmentGate } from "@/components/auth/EnrollmentGate";
import { OAuthProblem, type ConnectStep } from "@/components/oauth/ConnectFlow";
import { ConsentSkeleton, DecisionView } from "@/components/oauth/ConsentSections";
import { ConsentForm, ConsentFrame } from "@/components/oauth/ConsentScreen";
import { useOAuthConsent } from "@/hooks/useOAuthConsent";
import { useSignInLook } from "@/hooks/useSignInLook";
import { useAuth } from "@/lib/auth";
import { cliHost } from "@/lib/cliClient";
import { useI18n } from "@/lib/i18n";

function ConsentInner() {
    const { t } = useI18n();
    const { isAuthenticated, isLoading } = useAuth();
    const look = useSignInLook();
    const { state, actions, reauthDialog } = useOAuthConsent();
    const { info, error, loading, decision, enrollMissing } = state;

    // 還沒登入（正要被送去 /oauth/login）或還不知道樣子：只畫空外框，不先閃過連接流程（低調樣子也不會露出）。
    // Signed out (about to go to /oauth/login) or the look unknown yet: only the empty frame, so nothing flashes by.
    if (isLoading || !isAuthenticated || !look) return <SignInPending />;

    // 管理員要求兩步驟而帳號還沒設好：先設定，完成後回到這個請求。/ Required two-step setup first, then back here.
    if (enrollMissing) return <EnrollmentGate missing={enrollMissing} onDone={actions.enrollmentDone} />;

    const style = look.consentStyle;
    const appName = info?.client.client_name ?? "";
    // `telepy` CLI（`telepy login`）在要求：同一套 OAuth，但不是 AI app。/ The CLI asking: the same OAuth, but not an AI app.
    const isCli = (info?.cli ? info.cli.host : cliHost(appName)) !== null;
    const step: ConnectStep = decision ? 2 : 1;
    const frame = (children: React.ReactNode) => (
        <ConsentFrame style={style} message={look.message} step={step} appName={appName}>
            {children}
        </ConsentFrame>
    );

    if (loading) return frame(<ConsentSkeleton />);

    if (error || !info) {
        return frame(<OAuthProblem description={error?.error_description ?? t("oauth.loadFailed")} code={error?.error} redirectTo={error?.redirect_to} />);
    }

    if (decision) return frame(<DecisionView approved={decision.approved} app={appName} onReopen={actions.reopen} cli={isCli} />);

    return frame(
        <>
            <ConsentForm state={{ ...state, info }} actions={actions} surface={style === "standard" ? "background" : "card"} />
            {reauthDialog}
        </>
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
