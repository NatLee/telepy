"use client";

/**
 * 偏好設定 modal:由 sidebar 左下角的齒輪按鈕開啟。版面是「左側欄 + 內容」:桌面上左欄是帳號與分頁,
 * 手機上分頁變成內容上方的一列;對話框高度固定,切換分頁時大小不變(內容多的分頁自己捲動)。
 * - 一般:帳號資訊、介面語言、主題(系統/淺色/深色)、顯示大小(小/中/大 + 細調滑桿)、終端機字型大小。
 *   變更即時套用並寫入本機(cookie/localStorage),已登入時同步到後端 UserSettings(跨裝置)。
 * - 安全性:登入安全性(passkey / 驗證器 App / 復原碼)。
 * - 已連接的應用程式:授權過的 MCP / AI 客戶端(OAuth grants),可撤銷;另有連到 MCP 頁的設定入口。
 * User preferences modal, opened from the sidebar footer gear button. A rail + content layout: on
 * desktop the rail holds the account and the tabs, on phones the tabs become a row above the content;
 * the dialog has a fixed height, so switching tabs never resizes it (long tabs scroll). Tabs:
 * - General: account, language, theme, display size (S/M/L + fine slider), terminal font size.
 *   Changes apply instantly, persist locally, and sync to the backend UserSettings for cross-device use.
 * - Security: sign-in security (passkeys, authenticator app, recovery codes).
 * - Connected apps: authorized MCP / AI clients with revoke, plus a pointer to the MCP page.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ALargeSmall, ArrowRight, Bot, Globe, Monitor, Moon, Plug, ShieldCheck, SlidersHorizontal, Sun, Terminal as TerminalIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { NavTabs } from "@/components/ui/nav-tabs";
import { Segmented } from "@/components/ui/segmented";
import { Section } from "@/components/ui/section";
import { useAuth } from "@/lib/auth";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference } from "@/lib/i18n";
import {
    applyTerminalFontSize,
    persistUserSetting,
    readTerminalFontSize,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    UI_SCALE_MAX,
    UI_SCALE_MIN,
    UI_SCALE_PRESET_ORDER,
    UI_SCALE_PRESETS,
    UI_SCALE_STEP,
    uiScalePreset,
    type Theme,
    type UiScalePreset,
} from "@/lib/userPrefs";
import { useThemePreference } from "@/hooks/useThemePreference";
import { useUiScale } from "@/hooks/useUiScale";
import type { TranslationKey } from "@/locales/en";
import { ConnectedApps } from "./ConnectedApps";
import { SecuritySettings } from "./SecuritySettings";
import { SignInHistory } from "./SignInHistory";

type PrefsTab = "general" | "security" | "apps";

const SCALE_LABEL: Record<UiScalePreset, TranslationKey> = {
    small: "prefs.uiScaleSmall",
    medium: "prefs.uiScaleMedium",
    large: "prefs.uiScaleLarge",
};

export function UserPreferencesModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { user } = useAuth();
    const { t, language, setLanguage } = useI18n();
    // THEME_EVENT / UI_SCALE_EVENT 同步:sidebar 的切換器改了,這裡的選取狀態也會跟著動(反之亦然)。
    // Synced over THEME_EVENT / UI_SCALE_EVENT so this modal and the sidebar switchers never disagree.
    const [theme, changeTheme] = useThemePreference();
    const [scale, changeScale] = useUiScale();
    const [fontSize, setFontSizeState] = useState<number>(() => readTerminalFontSize());
    const [tab, setTab] = useState<PrefsTab>("general");

    const tabs = [
        { value: "general" as const, label: t("prefs.tabGeneral"), hint: t("prefs.tabGeneralHint"), icon: <SlidersHorizontal /> },
        { value: "security" as const, label: t("prefs.tabSecurity"), hint: t("prefs.tabSecurityHint"), icon: <ShieldCheck /> },
        { value: "apps" as const, label: t("prefs.tabApps"), hint: t("prefs.tabAppsHint"), icon: <Bot /> },
    ];

    const initial = user?.username?.slice(0, 1);
    const role = (
        <span className={`shrink-0 rounded-sm px-1.5 py-px text-xs ${user?.is_superuser ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            {user?.is_superuser ? t("settings.roleAdmin") : t("settings.roleUser")}
        </span>
    );

    const languageOptions: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
        { value: "system", label: t("prefs.themeSystem"), icon: <Monitor size={14} /> },
        { value: "light", label: t("prefs.themeLight"), icon: <Sun size={14} /> },
        { value: "dark", label: t("prefs.themeDark"), icon: <Moon size={14} /> },
    ];

    // 預設值之外的百分比(滑桿細調過)沒有對應的分段,軌道上就不亮任何一格。
    // A percentage set by the slider that matches no preset leaves every segment unselected.
    const scalePreset = uiScalePreset(scale);
    const scaleOptions: { value: UiScalePreset | "custom"; label: string }[] = UI_SCALE_PRESET_ORDER.map((p) => ({
        value: p,
        label: `${t(SCALE_LABEL[p])} · ${UI_SCALE_PRESETS[p]}%`,
    }));

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
            size="3xl"
            fixedHeight
            nav={
                <div className="space-y-4">
                    {/* 帳號(桌面在側欄上方;手機放在「一般」分頁裡)。/ Account: top of the rail on desktop, in General on phones. */}
                    <div className="hidden items-center gap-2.5 px-1.5 sm:flex" aria-label={t("settings.accountTitle")}>
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background uppercase" aria-hidden>
                            {initial}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">{user?.username}</span>
                            {role}
                        </span>
                    </div>
                    <NavTabs tabs={tabs} value={tab} onChange={setTab} aria-label={t("prefs.title")} />
                </div>
            }
        >
            {tab === "general" && (
                <div className="space-y-6">
                    {/* 帳號:只在手機上(桌面在側欄)。/ Account: phones only (the rail shows it on desktop). */}
                    <section className="flex items-center gap-3.5 rounded-xl border border-border bg-surface p-3.5 sm:hidden" aria-label={t("settings.accountTitle")}>
                        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-foreground text-lg text-background uppercase" aria-hidden>
                            {initial}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-foreground">{user?.username}</p>
                            {user?.email && <p className="truncate text-sm text-muted-foreground">{user.email}</p>}
                        </div>
                        {role}
                    </section>

                    {/* 語言 / Language */}
                    <Section icon={<Globe />} title={t("settings.languageTitle")} description={t("settings.languageDescription")}>
                        {/* 固定 2×2:四欄仍放不太下 CJK 標籤。/ Fixed 2×2 — four columns can't reliably fit CJK labels. */}
                        <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="group" aria-label={t("settings.languageTitle")}>
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
                    </Section>

                    {/* 主題 / Theme */}
                    <Section icon={<Sun />} title={t("prefs.theme")} description={t("prefs.themeDescription")}>
                        <Segmented fullWidth options={themeOptions} value={theme} onChange={changeTheme} aria-label={t("prefs.theme")} />
                    </Section>

                    {/* 顯示大小 / Display size: S / M / L presets + fine slider */}
                    <Section icon={<ALargeSmall />} title={t("prefs.uiScale")} description={t("prefs.uiScaleDescription")}>
                        <Segmented
                            fullWidth
                            options={scaleOptions}
                            value={scalePreset ?? "custom"}
                            onChange={(v) => v !== "custom" && changeScale(UI_SCALE_PRESETS[v])}
                            aria-label={t("prefs.uiScale")}
                        />
                        <div className="flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 ring-1 ring-inset ring-border/80">
                            <span className="shrink-0 text-xs text-muted-foreground">{t("prefs.uiScaleFine")}</span>
                            <input
                                type="range"
                                min={UI_SCALE_MIN}
                                max={UI_SCALE_MAX}
                                step={UI_SCALE_STEP}
                                value={scale}
                                onChange={(e) => changeScale(parseInt(e.target.value, 10))}
                                className="min-w-0 flex-1 accent-primary"
                                aria-label={t("prefs.uiScaleFine")}
                                aria-valuetext={`${scale}%`}
                            />
                            <span className="w-14 shrink-0 rounded-lg bg-muted py-1 text-center font-mono text-sm tabular-nums">{scale}%</span>
                        </div>
                    </Section>

                    {/* 終端機字型 / Terminal font size */}
                    <Section icon={<TerminalIcon />} title={t("prefs.terminalFontSize")} description={t("prefs.terminalFontSizeDescription")}>
                        <div className="flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 ring-1 ring-inset ring-border/80">
                            <input
                                type="range"
                                min={TERMINAL_FONT_SIZE_MIN}
                                max={TERMINAL_FONT_SIZE_MAX}
                                value={fontSize}
                                onChange={(e) => changeFontSize(parseInt(e.target.value, 10))}
                                className="min-w-0 flex-1 accent-primary"
                                aria-label={t("prefs.terminalFontSize")}
                            />
                            <span className="w-14 shrink-0 rounded-lg bg-muted py-1 text-center font-mono text-sm tabular-nums">{fontSize}px</span>
                        </div>
                    </Section>
                </div>
            )}

            {/* 登入安全性 + 最近的登入 / Sign-in security (passkeys, authenticator app, recovery codes) + recent sign-ins */}
            {tab === "security" && (
                <div className="space-y-6">
                    <SecuritySettings />
                    <SignInHistory endpoint="/api/auth/sign-ins" description={t("security.signInsDescription")} />
                </div>
            )}

            {tab === "apps" && (
                <div className="space-y-6">
                    {/* 已連接的應用程式 / Connected apps (MCP / AI clients) */}
                    <ConnectedApps />

                    {/* 新增 AI 工具的設定步驟在 MCP 頁。/ Setting up a new AI tool happens on the MCP page. */}
                    <Link
                        href="/tunnels/mcp"
                        prefetch={false}
                        onClick={onClose}
                        className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-foreground/25 hover:bg-muted/50"
                    >
                        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground/70">
                            <Plug size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm text-foreground">{t("prefs.mcpSetupTitle")}</span>
                            <span className="block text-xs text-muted-foreground">{t("prefs.mcpSetupDescription")}</span>
                        </span>
                        <ArrowRight size={15} className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                </div>
            )}
        </Modal>
    );
}
