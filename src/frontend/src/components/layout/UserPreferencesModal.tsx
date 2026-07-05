"use client";

/**
 * 偏好設定 modal:由 sidebar 左下角的齒輪按鈕開啟。
 * 內容:帳號資訊、介面語言、主題(系統/淺色/深色)、終端機字型大小。
 * 變更即時套用並寫入本機(cookie/localStorage),已登入時同步到後端 UserSettings(跨裝置)。
 * User preferences modal, opened from the sidebar footer gear button. Changes apply
 * instantly, persist locally, and sync to the backend UserSettings for cross-device use.
 */
import React, { useState } from "react";
import { Check, Globe, Monitor, Moon, Sun, Terminal as TerminalIcon, User as UserIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference } from "@/lib/i18n";
import {
    applyTerminalFontSize,
    applyTheme,
    readStoredTheme,
    readTerminalFontSize,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    type Theme,
} from "@/lib/userPrefs";

/** 已登入時把單一偏好同步到後端;失敗不擋本機切換(下次登入會再同步)。
 *  Fire-and-forget backend sync; a failure never blocks the local change. */
function persistPreference(patch: Record<string, unknown>) {
    if (typeof localStorage !== "undefined" && localStorage.getItem("accessToken")) {
        apiFetch("/api/user/settings", {
            method: "POST",
            body: JSON.stringify(patch),
        }).catch(() => { });
    }
}

export function UserPreferencesModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { user } = useAuth();
    const { t, language, setLanguage } = useI18n();
    const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
    const [fontSize, setFontSizeState] = useState<number>(() => readTerminalFontSize());

    const languageOptions: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
        { value: "system", label: t("prefs.themeSystem"), icon: <Monitor size={14} /> },
        { value: "light", label: t("prefs.themeLight"), icon: <Sun size={14} /> },
        { value: "dark", label: t("prefs.themeDark"), icon: <Moon size={14} /> },
    ];

    const changeTheme = (next: Theme) => {
        setThemeState(next);
        applyTheme(next);
        persistPreference({ theme: next });
    };

    const changeFontSize = (next: number) => {
        setFontSizeState(next);
        applyTerminalFontSize(next);
        persistPreference({ terminal_font_size: next });
    };

    const optionButton = (isActive: boolean) =>
        `flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${isActive
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
        }`;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("prefs.title")}
            footer={
                <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors"
                >
                    {t("common.close")}
                </button>
            }
        >
            <div className="space-y-6">
                {/* 帳號 / Account */}
                <section>
                    <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
                        <UserIcon size={15} className="text-primary" />
                        {t("settings.accountTitle")}
                    </h3>
                    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm flex flex-wrap gap-x-8 gap-y-1">
                        <span className="font-medium text-foreground truncate">{user?.username}</span>
                        {user?.email && <span className="text-muted-foreground truncate">{user.email}</span>}
                        <span className="text-muted-foreground">
                            {user?.is_superuser ? t("settings.roleAdmin") : t("settings.roleUser")}
                        </span>
                    </div>
                </section>

                {/* 語言 / Language */}
                <section>
                    <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
                        <Globe size={15} className="text-primary" />
                        {t("settings.languageTitle")}
                    </h3>
                    <p className="text-xs text-muted-foreground mb-2">{t("settings.languageDescription")}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {languageOptions.map((option) => {
                            const isActive = language === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setLanguage(option.value)}
                                    className={optionButton(isActive)}
                                >
                                    {isActive && <Check size={13} />}
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </section>

                {/* 主題 / Theme */}
                <section>
                    <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
                        <Sun size={15} className="text-primary" />
                        {t("prefs.theme")}
                    </h3>
                    <p className="text-xs text-muted-foreground mb-2">{t("prefs.themeDescription")}</p>
                    <div className="grid grid-cols-3 gap-2">
                        {themeOptions.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => changeTheme(option.value)}
                                className={optionButton(theme === option.value)}
                            >
                                {option.icon}
                                {option.label}
                            </button>
                        ))}
                    </div>
                </section>

                {/* 終端機字型 / Terminal font size */}
                <section>
                    <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
                        <TerminalIcon size={15} className="text-primary" />
                        {t("prefs.terminalFontSize")}
                    </h3>
                    <p className="text-xs text-muted-foreground mb-2">{t("prefs.terminalFontSizeDescription")}</p>
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={TERMINAL_FONT_SIZE_MIN}
                            max={TERMINAL_FONT_SIZE_MAX}
                            value={fontSize}
                            onChange={(e) => changeFontSize(parseInt(e.target.value, 10))}
                            className="flex-1 accent-[var(--primary)]"
                        />
                        <span className="w-14 text-center text-sm font-mono border border-border rounded-md py-1 bg-background">
                            {fontSize}px
                        </span>
                    </div>
                </section>
            </div>
        </Modal>
    );
}
