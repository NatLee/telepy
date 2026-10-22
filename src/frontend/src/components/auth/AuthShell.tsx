"use client";

/**
 * 登入 / 首次設定頁共用外框：左側品牌面板（lg 以上才顯示，永遠是深色）+ 右側表單，右上角語言與主題切換。
 * Shared frame for the sign-in and first-run pages: an always-dark brand panel on the left (lg+), the form
 * on the right, language and theme switchers top-right.
 */
import React from "react";
import { BrandMark } from "@/components/layout/BrandMark";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/layout/ThemeSwitcher";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function AuthShell({ aside, children }: { aside: React.ReactNode; children: React.ReactNode }) {
    const { t } = useI18n();

    return (
        <div className="relative min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            {/* `dark` class：面板內一律用深色 token，跟目前主題無關。/ The panel always uses the dark tokens. */}
            <aside className="dark auth-panel relative hidden lg:flex flex-col justify-between gap-12 overflow-hidden border-r border-border p-10 xl:p-14 text-foreground">
                <BrandMark className="relative" />
                <div className="relative max-w-lg">{aside}</div>
                <p className="relative text-xs text-muted-foreground">{t("auth.footer")}</p>
            </aside>

            <main className="relative flex min-h-screen flex-col">
                <div className="app-backdrop lg:hidden" aria-hidden />
                <header className="relative flex items-center justify-between gap-3 p-4 sm:p-6">
                    <span className="lg:invisible">
                        <BrandMark collapsed className="sm:hidden" />
                        <BrandMark className="hidden sm:flex" />
                    </span>
                    {/* 未登入也能切語言與主題（cookie / localStorage；登入後由 UserSettingsSync 同步到帳號）。
                        Language and theme work before sign-in and sync to the account afterwards. */}
                    <div className="flex items-center gap-1 rounded-xl border border-border bg-card/80 p-1 shadow-card backdrop-blur">
                        <div className="w-[8.5rem]">
                            <LanguageSwitcher />
                        </div>
                        <span className="h-5 w-px bg-border max-[359px]:hidden" aria-hidden />
                        <div className="w-[6.5rem] max-[359px]:hidden">
                            <ThemeSwitcher />
                        </div>
                    </div>
                </header>

                <div className="relative flex flex-1 items-center justify-center px-4 pb-16 pt-4 sm:px-6">
                    <div className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-500">{children}</div>
                </div>
            </main>
        </div>
    );
}

/** 頁首：可選的小標籤 + 標題 + 說明。/ Page heading: optional eyebrow badge, title and description. */
export function AuthHeading({ badge, title, description }: { badge?: React.ReactNode; title: string; description: string }) {
    return (
        <div className="mb-8">
            {badge}
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
    );
}

/** 「或」分隔線。/ "or" divider between sign-in methods. */
export function AuthDivider({ label, className }: { label: string; className?: string }) {
    return (
        <div className={cn("my-6 flex items-center gap-3 text-xs text-muted-foreground", className)} role="separator">
            <span className="h-px flex-1 bg-border" />
            <span className="shrink-0">{label}</span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

/** 按鈕裡的轉圈。/ In-button spinner. */
export function AuthSpinner() {
    return <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />;
}
