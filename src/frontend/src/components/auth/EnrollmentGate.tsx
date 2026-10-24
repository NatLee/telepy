"use client";

/**
 * 管理員要求兩步驟（站台設定 mfa_require_totp / mfa_require_passkey）而帳號還沒設好時，取代整個 app 的設定畫面。
 * 後端同時擋住其他 API（403 mfa_enrollment_required），這裡只是讓使用者有路可走：說明 + 既有的 SecuritySettings + 登出。
 * 設好之後 SecuritySettings 會重抓 profile；不立刻放行，而是顯示「完成」與繼續按鈕，免得第一個因素的復原碼對話框被一起卸載。
 * Full-page "set up two-step sign-in" screen shown instead of the app while the admin's required factors are
 * missing. The backend refuses every other API meanwhile; this screen reuses SecuritySettings and offers sign-out.
 * Once enrolled it waits for "Continue" so the one-time recovery codes dialog is not unmounted underneath the user.
 */
import React, { useState } from "react";
import { ArrowRight, LogOut } from "lucide-react";
import { BrandMark } from "@/components/layout/BrandMark";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { PageHeader } from "@/components/layout/PageHeader";
import { SecuritySettings } from "@/components/layout/SecuritySettings";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import type { RequiredFactor } from "@/types/auth";

/** 要求的因素 → 說明文字的 key。/ Required factors → the explanation key. */
export function requirementKey(missing: RequiredFactor[]) {
    const totp = missing.includes("totp");
    const passkey = missing.includes("passkey");
    if (totp && passkey) return "security.enrollNeedBoth" as const;
    return passkey ? ("security.enrollNeedPasskey" as const) : ("security.enrollNeedTotp" as const);
}

export function EnrollmentGate({ missing, onDone }: { missing: RequiredFactor[]; onDone: () => void }) {
    const { t } = useI18n();
    const { logout } = useAuth();
    const done = missing.length === 0;
    // 第一次看到的要求（設好一項後仍要知道當初要求了什麼）。/ What was required when the gate first appeared.
    const [required] = useState<RequiredFactor[]>(missing);

    return (
        <div className="min-h-screen bg-background font-sans">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
                <BrandMark />
                <div className="flex items-center gap-2">
                    <div className="hidden w-[8.5rem] sm:block">
                        <LanguageSwitcher />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => logout()}>
                        <LogOut size={15} aria-hidden />
                        {t("nav.logout")}
                    </Button>
                </div>
            </header>

            <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8 sm:px-6">
                <PageHeader title={t("security.enrollTitle")} description={t("security.enrollDescription")} />

                {done ? (
                    <Callout tone="tip">
                        <p>{t("security.enrollDone")}</p>
                        <Button className="mt-3" size="sm" onClick={onDone}>
                            {t("security.enrollContinue")}
                            <ArrowRight size={15} aria-hidden />
                        </Button>
                    </Callout>
                ) : (
                    <Callout tone="warning">
                        <p>{t(requirementKey(missing))}</p>
                        {required.length > 1 && missing.length === 1 && <p className="mt-1 text-muted-foreground">{t("security.enrollOneLeft")}</p>}
                        {missing.includes("passkey") && <p className="mt-1 text-muted-foreground">{t("security.enrollPasskeyHint")}</p>}
                    </Callout>
                )}

                <div className="rounded-xl border border-border bg-card p-4 shadow-card sm:p-5">
                    <SecuritySettings />
                </div>

                <p className="text-xs text-muted-foreground">{t("security.enrollContactAdmin")}</p>
            </main>
        </div>
    );
}
