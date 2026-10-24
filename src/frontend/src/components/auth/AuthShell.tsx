"use client";

/**
 * 登入 / 首次設定頁共用外框：左側品牌面板（lg 以上才顯示，永遠是深色）+ 右側表單，右上角語言與主題切換。
 * 兩欄放在一個置中、限寬的區塊裡，深色底再往左延伸到視窗邊緣：寬螢幕上品牌面板的文字和表單仍然相鄰，
 * 而不是各自貼在螢幕兩側。
 * Shared frame for the sign-in and first-run pages: an always-dark brand panel on the left (lg+), the form
 * on the right, language and theme switchers top-right. The two columns live in one centred, capped block and
 * the dark surface bleeds to the viewport's left edge, so on a wide screen the panel copy and the form stay
 * next to each other instead of sitting at opposite edges.
 */
import React from "react";
import { BrandMark } from "@/components/layout/BrandMark";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/layout/ThemeSwitcher";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function AuthShell({ aside, wide = false, children }: { aside: React.ReactNode; /** 內容較多的頁面（OAuth 同意頁）用寬一點的欄。/ A wider column for content-heavy pages. */ wide?: boolean; children: React.ReactNode }) {
    const { t } = useI18n();

    return (
        <div className="relative min-h-screen overflow-x-clip bg-background">
            <div className="mx-auto min-h-screen max-w-7xl lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
                {/* `dark` class：面板內一律用深色 token，跟目前主題無關。`before` 把同一個底色鋪到區塊左邊的空位
                    （外層 overflow-x-clip 擋住往左的溢出）。/ The panel always uses the dark tokens; `before` paints the
                    same surface over the space left of the block (the outer overflow-x-clip hides the leftward overflow). */}
                <aside className="dark auth-panel relative hidden lg:flex flex-col justify-between gap-12 border-r border-border p-10 xl:p-14 text-foreground before:absolute before:inset-y-0 before:right-full before:w-screen before:bg-(--sidebar)">
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
                        <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
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
                        <div className={cn("w-full animate-fade-in-up", wide ? "max-w-lg" : "max-w-sm")}>{children}</div>
                    </div>
                </main>
            </div>
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
