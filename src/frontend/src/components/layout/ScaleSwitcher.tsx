"use client";

/**
 * 顯示大小切換器:sidebar 底部的三顆並排按鈕(小 / 中 / 大),點一下直接切換;細調在偏好設定 modal。
 * 收合時改為單顆 icon 按鈕,點開右側下拉選單選擇。
 * Display-size switcher: three inline buttons (small / medium / large) in the sidebar footer; the fine
 * slider lives in the preferences modal. The collapsed sidebar renders one icon button with a dropdown.
 */
import { ALargeSmall } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { UI_SCALE_PRESET_ORDER, UI_SCALE_PRESETS, uiScalePreset, type UiScalePreset } from "@/lib/userPrefs";
import { useUiScale } from "@/hooks/useUiScale";
import type { TranslationKey } from "@/locales/en";

const LABEL: Record<UiScalePreset, TranslationKey> = {
    small: "prefs.uiScaleSmall",
    medium: "prefs.uiScaleMedium",
    large: "prefs.uiScaleLarge",
};

/** 三個字級的「A」:不用翻譯也看得懂。/ Three sizes of "A": readable without translation. */
const GLYPH_CLASS: Record<UiScalePreset, string> = {
    small: "text-[0.6875rem]",
    medium: "text-[0.875rem]",
    large: "text-[1.0625rem]",
};

export function ScaleSwitcher({ collapsed = false, className = "" }: { collapsed?: boolean; className?: string }) {
    const { t } = useI18n();
    const [scale, changeScale] = useUiScale();
    const current = uiScalePreset(scale);
    const currentName = current ? t(LABEL[current]) : t("prefs.uiScaleCustom", { percent: scale });

    if (collapsed) {
        const triggerLabel = `${t("prefs.uiScale")}: ${currentName}`;
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        title={triggerLabel}
                        aria-label={triggerLabel}
                        className="flex w-full items-center justify-center px-2 py-2 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
                    >
                        <ALargeSmall size={18} />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-44">
                    <DropdownMenuLabel>{t("prefs.uiScale")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={current ?? ""} onValueChange={(v) => v in UI_SCALE_PRESETS && changeScale(UI_SCALE_PRESETS[v as UiScalePreset])}>
                        {UI_SCALE_PRESET_ORDER.map((preset) => (
                            <DropdownMenuRadioItem key={preset} value={preset}>
                                {t(LABEL[preset])}
                                <span className="ml-auto font-mono text-xs text-muted-foreground">{UI_SCALE_PRESETS[preset]}%</span>
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <div role="group" aria-label={t("prefs.uiScale")} className={`grid grid-cols-3 gap-0.5 rounded-lg bg-muted/80 p-0.5 ${className}`}>
            {UI_SCALE_PRESET_ORDER.map((preset) => {
                const isActive = current === preset;
                const label = `${t(LABEL[preset])} (${UI_SCALE_PRESETS[preset]}%)`;
                return (
                    <button
                        key={preset}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={isActive}
                        onClick={() => changeScale(UI_SCALE_PRESETS[preset])}
                        className={`flex h-7 items-center justify-center rounded-md leading-none transition-[color,background-color,box-shadow] ${isActive ? "bg-card text-primary shadow-card" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        <span className={GLYPH_CLASS[preset]} aria-hidden>A</span>
                    </button>
                );
            })}
        </div>
    );
}
