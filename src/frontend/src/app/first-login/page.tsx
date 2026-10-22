"use client";

/**
 * 首次設定頁：伺服器還沒有任何帳號時建立第一位管理員（帳密或 Google）。
 * First-run page: create the first administrator (credentials or Google) while the server has no accounts.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, Check, Circle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthDivider, AuthHeading, AuthShell, AuthSpinner } from "@/components/auth/AuthShell";
import { SetupSteps } from "@/components/auth/AuthPanels";
import { GoogleSignIn } from "@/components/auth/GoogleSignIn";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { MIN_PASSWORD_LENGTH, useFirstLogin } from "@/hooks/useFirstLogin";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

const STRENGTH: Record<1 | 2 | 3, { label: TranslationKey; bar: string; text: string }> = {
    1: { label: "firstLogin.strengthWeak", bar: "bg-destructive", text: "text-destructive" },
    2: { label: "firstLogin.strengthModerate", bar: "bg-warning", text: "text-warning" },
    3: { label: "firstLogin.strengthStrong", bar: "bg-success", text: "text-success" },
};

/** 密碼規則的一列：未輸入是灰圈、通過是勾。/ One password rule: grey circle until typed, then a check. */
function Rule({ ok, touched, children }: { ok: boolean; touched: boolean; children: React.ReactNode }) {
    return (
        <li className={cn("flex items-center gap-2 transition-colors", ok ? "text-success" : touched ? "text-foreground" : "text-muted-foreground")}>
            {ok ? <Check size={14} strokeWidth={2.5} /> : <Circle size={14} className="text-muted-foreground/60" />}
            {children}
        </li>
    );
}

export default function FirstLoginPage() {
    const { t } = useI18n();
    const { state, actions } = useFirstLogin();
    const {
        username, setUsername,
        password, setPassword,
        confirmPassword, setConfirmPassword,
        isSubmitting,
        strength,
        rules,
        passwordsMatch,
        canSubmit,
        googleClientId
    } = state;
    const { handleSubmit } = actions;
    const mismatch = confirmPassword.length > 0 && !passwordsMatch;

    return (
        <AuthShell aside={<SetupSteps />}>
            <AuthHeading
                badge={
                    <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                        <Sparkles size={12} />
                        {t("firstLogin.badge")}
                    </span>
                }
                title={t("firstLogin.title")}
                description={t("firstLogin.subtitle")}
            />

            <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                    <Label htmlFor="setup-username">{t("login.username")}</Label>
                    <Input
                        id="setup-username"
                        type="text"
                        required
                        autoFocus
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="h-11"
                        placeholder={t("firstLogin.usernamePlaceholder")}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="setup-password">{t("login.password")}</Label>
                    <PasswordInput
                        id="setup-password"
                        required
                        autoComplete="new-password"
                        aria-describedby="setup-password-rules"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="h-11"
                        placeholder={t("firstLogin.passwordPlaceholder")}
                    />
                    {/* 三格強度條 + 標籤。/ Three-segment strength meter with its label. */}
                    <div className="flex items-center gap-3 pt-1" aria-live="polite">
                        <div className="grid flex-1 grid-cols-3 gap-1.5">
                            {[1, 2, 3].map((level) => (
                                <span
                                    key={level}
                                    className={cn(
                                        "h-1 rounded-full transition-colors duration-300",
                                        strength >= level ? STRENGTH[strength as 1 | 2 | 3].bar : "bg-muted"
                                    )}
                                />
                            ))}
                        </div>
                        <span className={cn("w-16 text-right text-xs font-medium", strength ? STRENGTH[strength as 1 | 2 | 3].text : "text-muted-foreground")}>
                            {strength ? t(STRENGTH[strength as 1 | 2 | 3].label) : ""}
                        </span>
                    </div>
                    <ul id="setup-password-rules" className="space-y-1 text-xs">
                        <Rule ok={rules.length} touched={password.length > 0}>
                            {t("firstLogin.ruleLength", { n: MIN_PASSWORD_LENGTH })}
                        </Rule>
                        <Rule ok={rules.notUsername} touched={password.length > 0}>
                            {t("firstLogin.ruleNotUsername")}
                        </Rule>
                    </ul>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="setup-confirm">{t("firstLogin.confirmPassword")}</Label>
                    <PasswordInput
                        id="setup-confirm"
                        required
                        autoComplete="new-password"
                        aria-invalid={mismatch || undefined}
                        aria-describedby="setup-confirm-hint"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="h-11"
                        placeholder={t("firstLogin.confirmPasswordPlaceholder")}
                    />
                    <p id="setup-confirm-hint" className="min-h-4 text-xs font-medium" aria-live="polite">
                        {mismatch && (
                            <span className="inline-flex items-center gap-1.5 text-destructive">
                                <X size={14} strokeWidth={2.5} />
                                {t("firstLogin.passwordsDoNotMatch")}
                            </span>
                        )}
                        {passwordsMatch && (
                            <span className="inline-flex items-center gap-1.5 text-success">
                                <Check size={14} strokeWidth={2.5} />
                                {t("firstLogin.passwordsMatch")}
                            </span>
                        )}
                    </p>
                </div>

                <Button type="submit" disabled={!canSubmit} className="h-11 w-full font-semibold" size="lg">
                    {isSubmitting ? (
                        <>
                            <AuthSpinner />
                            {t("firstLogin.creating")}
                        </>
                    ) : (
                        <>
                            {t("firstLogin.createAccount")}
                            <ArrowRight size={16} />
                        </>
                    )}
                </Button>
            </form>

            {googleClientId && (
                <>
                    <AuthDivider label={t("auth.or")} />
                    <GoogleSignIn clientId={googleClientId} text="continue_with" />
                    <p className="mt-3 text-center text-xs text-muted-foreground">{t("firstLogin.googleHint")}</p>
                </>
            )}

            <p className="mt-8 text-center text-sm text-muted-foreground">
                <Link href="/login" className="font-medium transition-colors hover:text-primary">
                    {t("firstLogin.alreadyHaveAccount")}
                </Link>
            </p>
        </AuthShell>
    );
}
