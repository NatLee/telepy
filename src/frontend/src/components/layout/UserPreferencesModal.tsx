"use client";

/**
 * 偏好設定 modal:由 sidebar 左下角的齒輪按鈕開啟,分頁:
 * - 一般:帳號資訊、介面語言、主題(系統/淺色/深色)、終端機字型大小。
 *   變更即時套用並寫入本機(cookie/localStorage),已登入時同步到後端 UserSettings(跨裝置)。
 * - 安全性:登入安全性(passkey / 驗證器 App / 復原碼)。
 * - 已連接的應用程式:授權過的 MCP / AI 客戶端(OAuth grants),可撤銷;另有連到 MCP 頁的設定入口。
 * User preferences modal, opened from the sidebar footer gear button. Tabs:
 * - General: account, language, theme, terminal font size. Changes apply instantly, persist
 *   locally, and sync to the backend UserSettings for cross-device use.
 * - Security: sign-in security (passkeys, authenticator app, recovery codes).
 * - Connected apps: authorized MCP / AI clients with revoke, plus a pointer to the MCP page.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Check, Globe, Monitor, Moon, Plug, ShieldCheck, SlidersHorizontal, Sun, Terminal as TerminalIcon, User as UserIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference } from "@/lib/i18n";
import {
    applyTerminalFontSize,
    persistUserSetting,
    readTerminalFontSize,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    type Theme,
} from "@/lib/userPrefs";
import { useThemePreference } from "@/hooks/useThemePreference";
import { ConnectedApps } from "./ConnectedApps";
import { SecuritySettings } from "./SecuritySettings";

type PrefsTab = "general" | "security" | "apps";

export function UserPreferencesModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { user } = useAuth();
    const { t, language, setLanguage } = useI18n();
    // THEME_EVENT 同步:sidebar 的 ThemeSwitcher 改了主題,這裡的選取狀態也會跟著動(反之亦然)。
    // Synced over THEME_EVENT so this modal and the sidebar ThemeSwitcher never disagree.
    const [theme, changeTheme] = useThemePreference();
    const [fontSize, setFontSizeState] = useState<number>(() => readTerminalFontSize());
    const [tab, setTab] = useState<PrefsTab>("general");

    const tabs: { id: PrefsTab; label: string; icon: React.ReactNode }[] = [
        { id: "general", label: t("prefs.tabGeneral"), icon: <SlidersHorizontal size={15} /> },
        { id: "security", label: t("prefs.tabSecurity"), icon: <ShieldCheck size={15} /> },
        { id: "apps", label: t("prefs.tabApps"), icon: <Bot size={15} /> },
    ];

    const languageOptions: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
        { value: "system", label: t("prefs.themeSystem"), icon: <Monitor size={14} /> },
        { value: "light", label: t("prefs.themeLight"), icon: <Sun size={14} /> },
        { value: "dark", label: t("prefs.themeDark"), icon: <Moon size={14} /> },
    ];

    const changeFontSize = (next: number) => {
        setFontSizeState(next);
        applyTerminalFontSize(next);
        persistUserSetting({ terminal_font_size: next });
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
            size="lg"
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
            {/* 分頁:內容一多(帳號安全、AI app)就不再全部堆成一長串。
                Tabs keep the modal short as account security and AI apps join the plain preferences. */}
            <div className="-mt-1 mb-5 border-b border-border flex gap-1 overflow-x-auto" role="tablist">
                {tabs.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => setTab(item.id)}
                        className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === item.id
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                            }`}
                    >
                        {item.icon}
                        {item.label}
                    </button>
                ))}
            </div>

            {tab === "general" && (
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
                        {/* 固定 2×2:四欄在這個寬度(max-w-lg)仍放不太下 CJK 標籤(會換行跑版)。
                            Fixed 2×2 — four columns still can't reliably fit CJK labels at max-w-lg. */}
                        <div className="grid grid-cols-2 gap-2">
                            {languageOptions.map((option) => {
                                const isActive = language === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={isActive}
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
                                    aria-pressed={theme === option.value}
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
                                className="flex-1 accent-primary"
                            />
                            <span className="w-14 text-center text-sm font-mono border border-border rounded-md py-1 bg-background">
                                {fontSize}px
                            </span>
                        </div>
                    </section>
                </div>
            )}

            {/* 登入安全性 / Sign-in security (passkeys, authenticator app, recovery codes) */}
            {tab === "security" && <SecuritySettings />}

            {tab === "apps" && (
                <div className="space-y-6">
                    {/* 已連接的應用程式 / Connected apps (MCP / AI clients) */}
                    <ConnectedApps />

                    {/* 新增 AI 工具的設定步驟在 MCP 頁。/ Setting up a new AI tool happens on the MCP page. */}
                    <Link
                        href="/tunnels/mcp"
                        prefetch={false}
                        onClick={onClose}
                        className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm hover:border-primary/50 hover:bg-primary/5 transition-colors"
                    >
                        <Plug size={16} className="text-primary shrink-0" />
                        <span className="flex-1 min-w-0">
                            <span className="block font-medium text-foreground">{t("prefs.mcpSetupTitle")}</span>
                            <span className="block text-xs text-muted-foreground">{t("prefs.mcpSetupDescription")}</span>
                        </span>
                        <ArrowRight size={15} className="text-muted-foreground shrink-0" />
                    </Link>
                </div>
            )}
        </Modal>
    );
}
