"use client";

/**
 * 登入表單：帳密、passkey 與 Google 登入；帳號有兩步驟驗證時接著顯示第二步（passkey / 驗證器代碼 / 復原碼）。
 * 一般登入頁（/login）與 MCP 應用程式的 OAuth 登入頁（/oauth/login）共用；外框、標題與上方的說明由頁面決定。
 * Sign-in form: credentials, passkey and Google sign-in, then the two-factor step when the account has one.
 * Shared by the normal sign-in page and the OAuth sign-in page; the page supplies the frame, title and intro.
 */
import React from "react";
import { ArrowLeft, ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthDivider, AuthHeading, AuthSpinner } from "@/components/auth/AuthShell";
import { GoogleSignIn } from "@/components/auth/GoogleSignIn";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { useLoginPage } from "@/hooks/useLoginPage";
import { useI18n } from "@/lib/i18n";
import { passkeySupported } from "@/lib/webauthn";
import { cn } from "@/lib/utils";

export interface LoginFormProps {
    title: string;
    description: string;
    /** 標題上方（兩個步驟都顯示），例如要求連接的應用程式。/ Shown above the heading in both steps. */
    intro?: React.ReactNode;
    googleText?: "signin_with" | "continue_with";
}

type LoginPage = ReturnType<typeof useLoginPage>;

export function LoginForm(props: LoginFormProps) {
    const { state, actions } = useLoginPage();
    return <LoginFormView {...props} state={state} actions={actions} />;
}

const noop = () => {};

/**
 * 網站設定的預覽：同一個表單，但不登入、不導向（`useLoginPage` 會把已登入的人送走），Google 按鈕是畫出來的樣子。
 * The settings preview: the same form without signing in or redirecting (useLoginPage sends signed-in people away);
 * the Google button is drawn instead of loaded.
 */
export function LoginFormPreview(props: LoginFormProps) {
    const state: LoginPage["state"] = {
        username: "",
        setUsername: noop,
        password: "",
        setPassword: noop,
        isSubmitting: false,
        googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
        passkeyAvailable: passkeySupported(),
        mfa: null,
        mfaMethod: "totp",
        setMfaMethod: noop,
        mfaCode: "",
        setMfaCode: noop,
    };
    const actions: LoginPage["actions"] = {
        handleSubmit: async (e: React.FormEvent) => e.preventDefault(),
        signInWithPasskey: async () => {},
        submitMfaCode: async (e: React.FormEvent) => e.preventDefault(),
        verifyWithPasskey: async () => {},
        cancelMfa: noop,
    };
    return <LoginFormView {...props} state={state} actions={actions} preview />;
}

/** Google 按鈕的樣子（預覽用，不載入 Google 的程式）。/ What the Google button looks like (preview only). */
function GoogleButtonPreview({ text }: { text?: "signin_with" | "continue_with" }) {
    const { t } = useI18n();
    return (
        <span className="flex h-10 w-full items-center justify-center gap-2.5 rounded-md border border-input bg-card text-sm text-foreground">
            <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden>
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.2C12.4 13.7 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
                <path fill="#FBBC05" d="M10.5 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.2z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
            </svg>
            {t(text === "continue_with" ? "signinLook.googleContinue" : "signinLook.googleSignIn")}
        </span>
    );
}

export function LoginFormView({
    title,
    description,
    intro,
    googleText,
    state,
    actions,
    preview = false,
}: LoginFormProps & { state: LoginPage["state"]; actions: LoginPage["actions"]; preview?: boolean }) {
    const { username, setUsername, password, setPassword, isSubmitting, googleClientId, passkeyAvailable, mfa, mfaMethod, setMfaMethod, mfaCode, setMfaCode } = state;
    const { handleSubmit, signInWithPasskey, submitMfaCode, verifyWithPasskey, cancelMfa } = actions;
    const { t } = useI18n();

    return (
        <>
            {mfa ? (
                <div>
                    {intro}
                    <AuthHeading
                        badge={
                            <span className="mb-4 grid size-11 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
                                <ShieldCheck size={22} />
                            </span>
                        }
                        title={t("login.mfaTitle")}
                        description={t("login.mfaSubtitle")}
                    />
                    <div className="flex flex-col gap-5">
                        {mfa.methods.includes("passkey") && passkeySupported() && (
                            <>
                                <Button type="button" className="h-11 w-full font-semibold" size="lg" disabled={isSubmitting} onClick={verifyWithPasskey}>
                                    <KeyRound size={18} />
                                    {t("login.mfaUsePasskey")}
                                </Button>
                                {mfa.methods.some((m) => m !== "passkey") && <AuthDivider label={t("auth.or")} className="my-0" />}
                            </>
                        )}
                        {mfa.methods.some((m) => m !== "passkey") && (
                            <form onSubmit={submitMfaCode} className="space-y-4">
                                <div role="group" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                                    {(["totp", "recovery_code"] as const)
                                        .filter((m) => mfa.methods.includes(m))
                                        .map((m) => (
                                            <button
                                                key={m}
                                                type="button"
                                                aria-pressed={mfaMethod === m}
                                                onClick={() => {
                                                    setMfaMethod(m);
                                                    setMfaCode("");
                                                }}
                                                className={cn(
                                                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                                                    mfaMethod === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                {m === "totp" ? t("login.mfaUseTotp") : t("login.mfaUseRecovery")}
                                            </button>
                                        ))}
                                </div>
                                <Input
                                    autoFocus={!mfa.methods.includes("passkey")}
                                    aria-label={mfaMethod === "totp" ? t("login.mfaUseTotp") : t("login.mfaUseRecovery")}
                                    value={mfaCode}
                                    onChange={(e) => setMfaCode(e.target.value)}
                                    inputMode={mfaMethod === "totp" ? "numeric" : "text"}
                                    autoComplete="one-time-code"
                                    placeholder={mfaMethod === "totp" ? t("login.mfaCodePlaceholder") : "xxxx-xxxx-xxxx"}
                                    className="h-12 font-mono text-center text-lg tracking-[0.3em] md:text-lg placeholder:font-sans placeholder:text-sm placeholder:tracking-normal"
                                />
                                <Button
                                    type="submit"
                                    variant={mfa.methods.includes("passkey") ? "outline" : "default"}
                                    className="h-11 w-full font-semibold"
                                    size="lg"
                                    disabled={isSubmitting || !mfaCode.trim()}
                                >
                                    {isSubmitting && <AuthSpinner />}
                                    {t("login.mfaVerify")}
                                </Button>
                            </form>
                        )}
                        <button
                            type="button"
                            onClick={cancelMfa}
                            className="inline-flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                            <ArrowLeft size={14} />
                            {t("login.mfaBack")}
                        </button>
                    </div>
                </div>
            ) : (
                <div>
                    {intro}
                    <AuthHeading title={title} description={description} />
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div className="space-y-2">
                            <Label htmlFor="login-username">{t("login.username")}</Label>
                            <Input
                                id="login-username"
                                type="text"
                                required
                                autoFocus={!preview}
                                autoComplete={preview ? "off" : "username webauthn"}
                                autoCapitalize="none"
                                spellCheck={false}
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="h-11"
                                placeholder={t("login.usernamePlaceholder")}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="login-password">{t("login.password")}</Label>
                            <PasswordInput
                                id="login-password"
                                required
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="h-11"
                                placeholder="••••••••"
                            />
                        </div>

                        <Button type="submit" disabled={isSubmitting} className="h-11 w-full font-semibold" size="lg">
                            {isSubmitting ? (
                                <>
                                    <AuthSpinner />
                                    {t("login.signingIn")}
                                </>
                            ) : (
                                <>
                                    {t("login.signIn")}
                                    <ArrowRight size={16} />
                                </>
                            )}
                        </Button>
                        {passkeyAvailable && (
                            <Button type="button" variant="outline" className="h-11 w-full" size="lg" disabled={isSubmitting} onClick={signInWithPasskey}>
                                <KeyRound size={16} />
                                {t("login.passkeySignIn")}
                            </Button>
                        )}
                    </form>
                </div>
            )}

            {/* 第二步時只隱藏，避免回來時 GSI 按鈕重畫閃一下。/ Only hidden during the second step, so the GSI button doesn't redraw. */}
            {googleClientId && (
                <div className={mfa ? "hidden" : undefined}>
                    <AuthDivider label={t("login.orContinueWith")} />
                    {preview ? <GoogleButtonPreview text={googleText} /> : <GoogleSignIn clientId={googleClientId} text={googleText} />}
                </div>
            )}
        </>
    );
}
