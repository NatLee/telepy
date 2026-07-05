"use client";

/**
 * 語言切換器:sidebar 底部的四顆並排按鈕(自動/EN/繁/日),點一下直接切換、不用下拉。
 * 「自動」用地球 icon,其餘用語言縮寫;完整名稱放在 title tooltip。
 * 收合時改為單顆按鈕(顯示目前語言的縮寫),點開右側下拉選單選擇。
 * Language switcher: four inline buttons (Auto/EN/繁/日) — one click, no dropdown.
 * "Auto" is a globe icon; the rest are short glyphs with full names in tooltips.
 * Collapsed sidebar renders a single button (showing the current glyph) that opens
 * a right-side dropdown menu instead.
 */
import React from "react";
import { Globe } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n, isLanguagePreference, LOCALE_NATIVE_NAMES, type LanguagePreference } from "@/lib/i18n";

const OPTIONS: { value: LanguagePreference; glyph: React.ReactNode; nameKey?: true }[] = [
    { value: "auto", glyph: <Globe size={15} />, nameKey: true },
    { value: "en", glyph: "EN" },
    { value: "zh-TW", glyph: "繁" },
    { value: "ja", glyph: "日" },
];

export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
    const { language, t, setLanguage } = useI18n();

    const optionName = (value: LanguagePreference) =>
        value === "auto" ? t("language.auto") : LOCALE_NATIVE_NAMES[value];

    if (collapsed) {
        const current = OPTIONS.find((option) => option.value === language) ?? OPTIONS[0];
        // label 帶當前值,螢幕閱讀器不用打開選單就知道現在選哪個語言。
        // Include the current value so assistive tech hears it without opening the menu.
        const triggerLabel = `${t("language.label")}: ${optionName(current.value)}`;
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        title={triggerLabel}
                        aria-label={triggerLabel}
                        className="flex w-full items-center justify-center px-2 py-2 rounded-md text-sm font-semibold text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors data-[state=open]:bg-secondary/60 data-[state=open]:text-foreground"
                    >
                        {/* 18px / text-sm:跟收合狀態的齒輪/登出等鄰居一致。
                            18px icon / text-sm glyph to match the collapsed gear/logout neighbors. */}
                        {current.value === "auto"
                            ? <Globe size={18} />
                            : <span className="leading-[18px]">{current.glyph}</span>}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-40">
                    <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        value={language}
                        onValueChange={(v) => isLanguagePreference(v) && setLanguage(v)}
                    >
                        {OPTIONS.map((option) => (
                            <DropdownMenuRadioItem key={option.value} value={option.value}>
                                {optionName(option.value)}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <div
            role="group"
            aria-label={t("language.label")}
            className="grid gap-1 grid-cols-4"
        >
            {OPTIONS.map((option) => {
                const isActive = language === option.value;
                const name = optionName(option.value);
                return (
                    <button
                        key={option.value}
                        type="button"
                        title={name}
                        aria-label={name}
                        aria-pressed={isActive}
                        onClick={() => setLanguage(option.value)}
                        className={`flex items-center justify-center h-8 rounded-md text-xs font-semibold transition-colors ${isActive
                                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                            }`}
                    >
                        {option.glyph}
                    </button>
                );
            })}
        </div>
    );
}
