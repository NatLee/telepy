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
import { ArrowRight, Bot, Globe, Monitor, Moon, Plug, ShieldCheck, SlidersHorizontal, Sun, Terminal as TerminalIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
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

    const tabs: { value: PrefsTab; label: string; icon: React.ReactNode }[] = [
        { value: "general", label: t("prefs.tabGeneral"), icon: <SlidersHorizontal size={15} /> },
        { value: "security", label: t("prefs.tabSecurity"), icon: <ShieldCheck size={15} /> },
        { value: "apps", label: t("prefs.tabApps"), icon: <Bot size={15} /> },
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

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("prefs.title")}
            icon={<SlidersHorizontal />}
            size="lg"
            footer={
                <Button type="button" variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            {/* 分頁:內容一多(帳號安全、AI app)就不再全部堆成一長串。
                Tabs keep the modal short as account security and AI apps join the plain preferences. */}
            <Segmented kind="tabs" fullWidth options={tabs} value={tab} onChange={setTab} className="mb-6" />

            {tab === "general" && (
                <div className="space-y-6">
                    {/* 帳號 / Account */}
                    <section className="flex items-center gap-3.5 rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-border/80" aria-label={t("settings.accountTitle")}>
                        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-gradient text-lg text-white uppercase" aria-hidden>
                            {user?.username?.slice(0, 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-foreground">{user?.username}</p>
                            {user?.email && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${user?.is_superuser ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                            {user?.is_superuser ? t("settings.roleAdmin") : t("settings.roleUser")}
                        </span>
                    </section>

                    {/* 語言 / Language */}
                    <PrefSection icon={<Globe size={15} />} title={t("settings.languageTitle")} description={t("settings.languageDescription")}>
                        {/* 固定 2×2:四欄在這個寬度(max-w-lg)仍放不太下 CJK 標籤。
                            Fixed 2×2 — four columns still can't reliably fit CJK labels at max-w-lg. */}
                        <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
                            {languageOptions.map((option) => {
                                const isActive = language === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={isActive}
                                        onClick={() => setLanguage(option.value)}
                                        className={`rounded-lg px-3 py-1.5 text-sm transition-[color,background-color,box-shadow] ${isActive ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground"}`}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                    </PrefSection>

                    {/* 主題 / Theme */}
                    <PrefSection icon={<Sun size={15} />} title={t("prefs.theme")} description={t("prefs.themeDescription")}>
                        <Segmented fullWidth options={themeOptions} value={theme} onChange={changeTheme} aria-label={t("prefs.theme")} />
                    </PrefSection>

                    {/* 終端機字型 / Terminal font size */}
                    <PrefSection icon={<TerminalIcon size={15} />} title={t("prefs.terminalFontSize")} description={t("prefs.terminalFontSizeDescription")}>
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={TERMINAL_FONT_SIZE_MIN}
                                max={TERMINAL_FONT_SIZE_MAX}
                                value={fontSize}
                                onChange={(e) => changeFontSize(parseInt(e.target.value, 10))}
                                className="flex-1 accent-primary"
                                aria-label={t("prefs.terminalFontSize")}
                            />
                            <span className="w-14 rounded-lg bg-muted py-1 text-center font-mono text-sm tabular-nums">
                                {fontSize}px
                            </span>
                        </div>
                    </PrefSection>
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
                        className="group flex items-center gap-3 rounded-xl bg-surface px-4 py-3 text-sm ring-1 ring-inset ring-border/80 transition-colors hover:bg-primary/5 hover:ring-primary/40"
                    >
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                            <Plug size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-foreground">{t("prefs.mcpSetupTitle")}</span>
                            <span className="block text-xs text-muted-foreground">{t("prefs.mcpSetupDescription")}</span>
                        </span>
                        <ArrowRight size={15} className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                </div>
            )}
        </Modal>
    );
}

/** 一個偏好區塊:小圖示標題、說明、控制項。/ One preference block: icon heading, description, control. */
function PrefSection({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="flex items-center gap-2 text-sm text-foreground">
                <span className="text-primary">{icon}</span>
                {title}
            </h3>
            <p className="mt-1 mb-2.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
            {children}
        </section>
    );
}
