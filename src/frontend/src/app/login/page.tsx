"use client";

/**
 * 登入頁：帳密、passkey 與 Google 登入；帳號有兩步驟驗證時接著顯示第二步（passkey / 驗證器代碼 / 復原碼）。
 * Login page: credentials, passkey and Google sign-in, then the two-factor step when the account has one.
 */
import React from "react";
import Script from "next/script";
import { User, Lock, KeyRound, ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLoginPage } from "@/hooks/useLoginPage";
import { useI18n } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { passkeySupported } from "@/lib/webauthn";

export default function LoginPage() {
    const { state, actions } = useLoginPage();
    const { username, setUsername, password, setPassword, isSubmitting, googleClientId, passkeyAvailable, mfa, mfaMethod, setMfaMethod, mfaCode, setMfaCode } = state;
    const { handleSubmit, signInWithPasskey, submitMfaCode, verifyWithPasskey, cancelMfa } = actions;
    const { t } = useI18n();
    const spinner = <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>;

    return (
        <>
            <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
            {/* 未登入也能切語言(cookie 生效;登入後由 UserSettingsSync 同步到帳號)。
                Language is switchable pre-login; it syncs to the account after signing in. */}
            <div className="fixed top-4 right-4 z-10 w-44">
                <LanguageSwitcher />
            </div>
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <div className="w-full max-w-md bg-card text-card-foreground rounded-2xl shadow-2xl p-8 border border-border animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center justify-center w-16 h-16 bg-primary rounded-xl mb-4 shadow-lg shadow-primary/30">
                            <User size={32} className="text-primary-foreground" />
                        </div>
                        <h1 className="text-3xl font-bold tracking-tight">Telepy</h1>
                        <p className="text-muted-foreground mt-2">{t("login.subtitle")}</p>
                    </div>

                    {mfa ? (
                        <div className="space-y-5">
                            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
                                <ShieldCheck size={20} className="text-primary mt-0.5 shrink-0" />
                                <div>
                                    <p className="font-semibold text-sm">{t("login.mfaTitle")}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">{t("login.mfaSubtitle")}</p>
                                </div>
                            </div>
                            {mfa.methods.includes("passkey") && passkeySupported() && (
                                <Button type="button" className="w-full font-bold" size="lg" disabled={isSubmitting} onClick={verifyWithPasskey}>
                                    <KeyRound size={18} className="mr-2" />
                                    {t("login.mfaUsePasskey")}
                                </Button>
                            )}
                            <form onSubmit={submitMfaCode} className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
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
                                                className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${mfaMethod === m ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                                            >
                                                {m === "totp" ? t("login.mfaUseTotp") : t("login.mfaUseRecovery")}
                                            </button>
                                        ))}
                                </div>
                                <Input
                                    autoFocus={!mfa.methods.includes("passkey")}
                                    value={mfaCode}
                                    onChange={(e) => setMfaCode(e.target.value)}
                                    inputMode={mfaMethod === "totp" ? "numeric" : "text"}
                                    autoComplete="one-time-code"
                                    placeholder={mfaMethod === "totp" ? t("login.mfaCodePlaceholder") : "xxxx-xxxx-xxxx"}
                                    className="font-mono text-center tracking-widest"
                                />
                                <Button type="submit" variant={mfa.methods.includes("passkey") ? "outline" : "default"} className="w-full font-bold" disabled={isSubmitting || !mfaCode.trim()}>
                                    {isSubmitting ? spinner : t("login.mfaVerify")}
                                </Button>
                            </form>
                            <button type="button" onClick={cancelMfa} className="w-full inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                                <ArrowLeft size={14} />
                                {t("login.mfaBack")}
                            </button>
                        </div>
                    ) : (
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                {t("login.username")}
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <User size={18} className="text-muted-foreground" />
                                </div>
                                <Input
                                    type="text"
                                    required
                                    autoComplete="username webauthn"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="pl-10"
                                    placeholder={t("login.usernamePlaceholder")}
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                {t("login.password")}
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock size={18} className="text-muted-foreground" />
                                </div>
                                <Input
                                    type="password"
                                    required
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="pl-10"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <Button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full font-bold"
                            size="lg"
                        >
                            {isSubmitting ? spinner : t("login.signIn")}
                        </Button>
                        {passkeyAvailable && (
                            <Button type="button" variant="outline" className="w-full" size="lg" disabled={isSubmitting} onClick={signInWithPasskey}>
                                <KeyRound size={18} className="mr-2" />
                                {t("login.passkeySignIn")}
                            </Button>
                        )}
                    </form>
                    )}

                    {/* 第二步時只隱藏（GSI 把按鈕渲染進這個 DOM，卸載後回來就不見了）。
                        Only hidden during the second step: GSI renders its button into this DOM once. */}
                    {googleClientId && (
                        <div className={mfa ? "hidden" : "mt-6"}>
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border" />
                                </div>
                                <div className="relative flex justify-center text-sm">
                                    <span className="px-2 bg-card text-muted-foreground">{t("login.orContinueWith")}</span>
                                </div>
                            </div>
                            <div className="mt-6 flex justify-center">
                                <div
                                    id="g_id_onload"
                                    data-client_id={googleClientId}
                                    data-context="signin"
                                    data-ux_mode="popup"
                                    data-callback="getTokenUsingGoogleCredential"
                                    data-auto_prompt="false"
                                ></div>
                                <div
                                    className="g_id_signin"
                                    data-type="standard"
                                    data-size="large"
                                    data-theme="outline"
                                    data-text="sign_in_with"
                                    data-shape="rectangular"
                                    data-logo_alignment="left"
                                ></div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
