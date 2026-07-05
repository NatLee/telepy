"use client";

/**
 * 語言切換器:sidebar 底部與設定頁共用。選項固定以「原生名稱」顯示(English / 繁體中文 / 日本語),
 * 「自動」則跟隨介面語言翻譯。切換即時生效並寫入 cookie;已登入時同步到帳號(跨裝置)。
 * Language switcher shared by the sidebar footer and the settings page. Options always show
 * their native names; "Auto" is translated. Changes apply instantly, persist to the cookie,
 * and sync to the account when logged in.
 */
import React from "react";
import { Check, Languages } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference } from "@/lib/i18n";

export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
    const { language, locale, t, setLanguage } = useI18n();

    const currentLabel = language === "auto" ? t("language.auto") : LOCALE_NATIVE_NAMES[locale];
    const options: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={t("language.label")}
                    className={`flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors ${collapsed ? "justify-center" : ""}`}
                >
                    <Languages size={18} className="shrink-0" />
                    {!collapsed && <span className="truncate">{currentLabel}</span>}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
                {options.map((option) => {
                    const isActive = language === option.value;
                    return (
                        <DropdownMenuItem
                            key={option.value}
                            onClick={() => setLanguage(option.value)}
                            className="flex items-center justify-between"
                        >
                            <span>{option.label}</span>
                            {isActive && <Check size={16} className="text-primary" />}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
