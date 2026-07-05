"use client";

/**
 * 語言切換器:sidebar 底部的四顆並排按鈕(自動/EN/繁/日),點一下直接切換、不用下拉。
 * 「自動」用地球 icon,其餘用語言縮寫;完整名稱放在 title tooltip。收合時排成 2×2。
 * Language switcher: four inline buttons (Auto/EN/繁/日) — one click, no dropdown.
 * "Auto" is a globe icon; the rest are short glyphs with full names in tooltips.
 * Collapsed sidebar lays them out as a 2×2 grid.
 */
import React from "react";
import { Globe } from "lucide-react";
import { useI18n, LOCALE_NATIVE_NAMES, type LanguagePreference } from "@/lib/i18n";

const OPTIONS: { value: LanguagePreference; glyph: React.ReactNode; nameKey?: true }[] = [
    { value: "auto", glyph: <Globe size={15} />, nameKey: true },
    { value: "en", glyph: "EN" },
    { value: "zh-TW", glyph: "繁" },
    { value: "ja", glyph: "日" },
];

export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
    const { language, t, setLanguage } = useI18n();

    return (
        <div
            role="group"
            aria-label={t("language.label")}
            // 收合時 sidebar 內容區只剩 ~32px 寬,2×2 會重疊 → 直排一欄。
            // Collapsed sidebar leaves ~32px of content width; 2×2 overlaps → single column.
            className={`grid gap-1 ${collapsed ? "grid-cols-1" : "grid-cols-4"}`}
        >
            {OPTIONS.map((option) => {
                const isActive = language === option.value;
                const name = option.value === "auto" ? t("language.auto") : LOCALE_NATIVE_NAMES[option.value];
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
