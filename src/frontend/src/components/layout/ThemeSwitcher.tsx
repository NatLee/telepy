"use client";

/**
 * 主題切換器:sidebar 底部的三顆並排按鈕(系統/淺色/深色),點一下直接切換。
 * 收合時改為單顆 icon 按鈕(顯示目前主題),點開右側下拉選單選擇。
 * Theme switcher: three inline buttons (System/Light/Dark) — one click, no dropdown.
 * Collapsed sidebar renders a single icon button (showing the current theme) that
 * opens a right-side dropdown menu instead.
 */
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { isTheme, THEMES, type Theme } from "@/lib/userPrefs";
import { useThemePreference } from "@/hooks/useThemePreference";
import type { TranslationKey } from "@/locales/en";

const THEME_META: Record<Theme, { Icon: LucideIcon; labelKey: TranslationKey }> = {
    system: { Icon: Monitor, labelKey: "prefs.themeSystem" },
    light: { Icon: Sun, labelKey: "prefs.themeLight" },
    dark: { Icon: Moon, labelKey: "prefs.themeDark" },
};

export function ThemeSwitcher({ collapsed = false }: { collapsed?: boolean }) {
    const { t } = useI18n();
    const [theme, changeTheme] = useThemePreference();

    if (collapsed) {
        const { Icon } = THEME_META[theme];
        // label 帶當前值,螢幕閱讀器不用打開選單就知道現在是哪個主題。
        // Include the current value so assistive tech hears it without opening the menu.
        const triggerLabel = `${t("prefs.theme")}: ${t(THEME_META[theme].labelKey)}`;
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        title={triggerLabel}
                        aria-label={triggerLabel}
                        className="flex w-full items-center justify-center px-2 py-2 rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors data-[state=open]:bg-secondary/60 data-[state=open]:text-foreground"
                    >
                        {/* 18px:跟收合狀態的齒輪/登出等鄰居一致。/ 18px matches the collapsed gear/logout neighbors. */}
                        <Icon size={18} />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-40">
                    <DropdownMenuLabel>{t("prefs.theme")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => isTheme(v) && changeTheme(v)}>
                        {THEMES.map((value) => {
                            const { Icon: ItemIcon, labelKey } = THEME_META[value];
                            return (
                                <DropdownMenuRadioItem key={value} value={value}>
                                    <ItemIcon size={15} />
                                    {t(labelKey)}
                                </DropdownMenuRadioItem>
                            );
                        })}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <div role="group" aria-label={t("prefs.theme")} className="grid grid-cols-3 gap-1">
            {THEMES.map((value) => {
                const { Icon, labelKey } = THEME_META[value];
                const isActive = theme === value;
                const label = t(labelKey);
                return (
                    <button
                        key={value}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={isActive}
                        onClick={() => changeTheme(value)}
                        className={`flex items-center justify-center h-8 rounded-md text-xs font-semibold transition-colors ${isActive
                            ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                            }`}
                    >
                        <Icon size={15} />
                    </button>
                );
            })}
        </div>
    );
}
