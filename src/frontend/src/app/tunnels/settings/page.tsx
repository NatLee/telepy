"use client";

/**
 * 設定頁(管理員專用),分頁並以 ?tab= 記在網址(MCP 頁可直接連到 AI 分頁):
 * - 帳號與註冊 / 遠端瀏覽器 / AI 存取(MCP):站台設定依 key 前綴分到各分頁。label 與說明優先用前端字典
 *   (siteSettings.<key>.label/.description,隨介面語言切換),找不到才退回後端 meta。
 *   以秒為單位的設定在輸入框下顯示換算後的時間。AI 分頁另外顯示 MCP 端點網址。
 * - 使用者:使用者列表 + 「管理」modal,可調整帳號狀態/角色與個人設定(語言)。
 * 個人偏好(語言/主題/終端機字型/已連接的應用程式)在 sidebar 左下角的齒輪 modal,不在這裡。
 * Settings page (admin-only), tabbed with the tab kept in ?tab= (the MCP page deep-links to
 * the AI tab): site settings split by key prefix into Account & registration / Remote browser /
 * AI access (labels from the frontend dictionaries, backend-meta fallback; second-based values
 * show a readable duration; the AI tab also shows the MCP endpoint), and Users (list + manage
 * modal). Personal preferences live in the sidebar gear modal instead.
 */
import React, { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference } from "@/lib/i18n";
import { Settings, Info, ShieldAlert, ShieldCheck, Users as UsersIcon, Shield, UserPlus, Globe, Bot, Plug, Activity, ArrowRight } from "lucide-react";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { useSettingsPage, SettingMeta } from "@/hooks/useSettingsPage";
import { useMcpServerUrl } from "@/hooks/useMcpPage";
import { useUserManagement, ManagedUser, ManagedUserPatch } from "@/hooks/useUserManagement";
import type { Translate } from "@/lib/i18n";
import { en } from "@/locales/en";
import type { TranslationKey } from "@/locales/en";

function titleize(key: string) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 站台設定/使用者 modal 共用的開關。/ Shared toggle switch for site settings and the user modal. */
function ToggleSwitch({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            onClick={() => !disabled && onToggle()}
            disabled={disabled}
            className={`${checked ? "bg-primary" : "bg-muted"} relative inline-flex h-6 w-11 shrink-0 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`}
            role="switch"
            aria-checked={checked}
        >
            <span aria-hidden="true" className={`${checked ? "translate-x-5" : "translate-x-0"} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary-foreground shadow ring-0 transition duration-200 ease-in-out`} />
        </button>
    );
}

/** 以秒為單位的站台設定(逾時 / 存活時間)。/ Site settings measured in seconds. */
const SECONDS_KEY = /_(timeout|lifetime)$/;

/** 秒數 → 「10 分鐘」「2 小時」這種好讀的長度(Intl 依語系翻單位)。/ Seconds → a readable, localized duration. */
function formatDuration(seconds: number, locale: string): string {
    const [value, unit] =
        seconds >= 3600 ? [seconds / 3600, "hour"] : seconds >= 60 ? [seconds / 60, "minute"] : [seconds, "second"];
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(value);
}

/** 站台設定依 key 前綴分到各分頁。/ Site settings are split into tabs by key prefix. */
type SiteTabId = "general" | "browser" | "ai";
type TabId = SiteTabId | "users";

const SITE_TAB_KEYS: Record<SiteTabId, (key: string) => boolean> = {
    general: (k) => !k.startsWith("remote_browser") && !k.startsWith("ai_"),
    browser: (k) => k.startsWith("remote_browser"),
    ai: (k) => k.startsWith("ai_"),
};

const TAB_IDS: TabId[] = ["general", "browser", "ai", "users"];

export default function SettingsPage() {
    // useSearchParams 需要 Suspense 邊界,否則靜態產生會整頁退回 client render。
    // useSearchParams needs a Suspense boundary or static generation bails out for the whole page.
    return (
        <Suspense fallback={null}>
            <SettingsPageContent />
        </Suspense>
    );
}

function SettingsPageContent() {
    const { user } = useAuth();
    const { t } = useI18n();
    const isAdmin = !!user?.is_superuser;

    if (!isAdmin) {
        // 非管理員(直接輸入網址進來):提示個人偏好的新位置。
        // Non-admins (deep link): point at the preferences modal's new home.
        return (
            <div className="animate-fade-in-up">
                <div className="bg-warning/10 border-l-4 border-warning p-4 rounded-r-md flex items-start">
                    <ShieldAlert className="text-warning mr-3 shrink-0 mt-0.5" size={20} />
                    {/* text-warning-foreground 是給實心 bg-warning 用的(近黑),在半透明底上會消失 → 用可讀的琥珀色。
                        text-warning-foreground (near-black) is for solid bg-warning; on this tint it vanishes → readable amber. */}
                    <p className="text-sm text-amber-800 dark:text-amber-200">{t("settings.adminOnly")}</p>
                </div>
            </div>
        );
    }

    return <AdminSettings />;
}

function AdminSettings() {
    const { t } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    // 站台設定只載入一次,各分頁共用。/ Load site settings once and share them across the tabs.
    const settings = useSettingsPage();

    const requested = searchParams.get("tab") as TabId | null;
    const tab: TabId = requested && TAB_IDS.includes(requested) ? requested : "general";
    const setTab = (next: TabId) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === "general") params.delete("tab");
        else params.set("tab", next);
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    };

    const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
        { id: "general", label: t("settings.groupAccount"), icon: <UserPlus size={16} /> },
        { id: "browser", label: t("settings.groupRemoteBrowser"), icon: <Globe size={16} /> },
        { id: "ai", label: t("settings.groupAi"), icon: <Bot size={16} /> },
        { id: "users", label: t("settings.tabUsers"), icon: <UsersIcon size={16} /> },
    ];

    return (
        <div className="animate-fade-in-up space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                    <Settings className="text-primary animate-float" />
                    {t("settings.title")}
                    <WebSocketStatusBadge />
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
            </div>

            <div className="border-b border-border flex gap-1 overflow-x-auto" role="tablist">
                {tabs.map((item) => (
                    <button
                        key={item.id}
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => setTab(item.id)}
                        className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === item.id
                                ? "border-primary text-primary"
                                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                            }`}
                    >
                        {item.icon}
                        {item.label}
                    </button>
                ))}
            </div>

            {tab === "users" ? <UsersTab /> : <SiteSettingsTab tab={tab} settings={settings} />}
        </div>
    );
}

/* ── 站台設定 / Site settings (admin) ───────────────────────────── */

const SITE_TAB_BANNERS: Record<SiteTabId, TranslationKey> = {
    general: "settings.generalBanner",
    browser: "settings.browserBanner",
    ai: "settings.aiBanner",
};

function SiteSettingsTab({ tab, settings }: { tab: SiteTabId; settings: ReturnType<typeof useSettingsPage> }) {
    const { t, locale } = useI18n();
    const { state, actions } = settings;
    const { settingsObj, meta, loading } = state;
    const { handleToggle, handleUpdate } = actions;
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const entries = Object.entries(settingsObj).filter(([k]) => SITE_TAB_KEYS[tab](k));

    // 站台設定的 label/說明優先用前端字典(隨介面語言),沒有對應 key 再退回後端 meta。
    // Prefer the frontend dictionary (localized); fall back to backend meta for unknown keys.
    const tOpt = (key: string): string | null =>
        key in en ? t(key as TranslationKey) : null;
    const labelOf = (key: string, m?: SettingMeta) =>
        tOpt(`siteSettings.${key}.label`) ?? m?.label ?? titleize(key);
    const descriptionOf = (key: string, m?: SettingMeta) =>
        tOpt(`siteSettings.${key}.description`) ?? m?.description ?? "";

    // 依 meta.type(找不到就用值的型別)決定編輯器與存檔驗證。
    const typeOf = (key: string, value: unknown): SettingMeta["type"] =>
        meta[key]?.type ?? (typeof value === "boolean" ? "boolean" : typeof value === "number" ? "integer" : "string");

    const commit = (key: string, kind: SettingMeta["type"], value: unknown) => {
        const raw = editValues[key] ?? String(value ?? "");
        if (kind === "integer") {
            const num = parseInt(raw, 10);
            if (isNaN(num) || num < 0) return;   // 允許 0(例如 max_sessions=0 代表不限制)
            handleUpdate(key, num);
        } else {
            const s = raw.trim();
            if (!s) return;
            handleUpdate(key, s);
        }
    };

    return (
        <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>{t(SITE_TAB_BANNERS[tab])}</span>
            </div>

            {tab === "ai" && <McpEndpointPanel />}

            {loading ? (
                <div className="bg-card shadow sm:rounded-lg border border-border p-8 text-center text-muted-foreground">
                    <div className="flex justify-center mb-2">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                    {t("settings.loading")}
                </div>
            ) : entries.length === 0 ? (
                <div className="bg-card shadow sm:rounded-lg border border-border p-8 text-center text-muted-foreground">
                    {t("settings.empty")}
                </div>
            ) : (
                <div className="bg-card text-card-foreground shadow overflow-hidden sm:rounded-lg border border-border">
                    <ul className="divide-y divide-border">
                        {entries.map(([key, value]) => {
                            const kind = typeOf(key, value);
                            const m = meta[key];
                            const description = descriptionOf(key, m);
                            const current = editValues[key] ?? String(value ?? "");
                            const seconds = kind === "integer" && SECONDS_KEY.test(key) ? parseInt(current, 10) : NaN;
                            return (
                                <li key={key} className="p-4 sm:p-6 hover:bg-muted/50 transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-medium text-foreground">
                                                {labelOf(key, m)}
                                            </h4>
                                            {description && (
                                                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                                                    {description}
                                                </p>
                                            )}
                                            <p className="mt-1.5 text-[11px] text-muted-foreground/70 font-mono bg-muted inline-block px-1 rounded border border-border">
                                                {key}
                                            </p>
                                        </div>
                                        <div className="shrink-0 pt-0.5">
                                            {kind === "boolean" ? (
                                                <ToggleSwitch checked={!!value} onToggle={() => handleToggle(key, value)} />
                                            ) : (
                                                <>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type={kind === "integer" ? "number" : "text"}
                                                            className={`${kind === "integer" ? "w-24" : "w-56"} text-sm border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring`}
                                                            value={current}
                                                            onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
                                                            onKeyDown={(e) => { if (e.key === "Enter") commit(key, kind, value); }}
                                                            min={kind === "integer" ? 0 : undefined}
                                                        />
                                                        <button
                                                            type="button"
                                                            className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                                                            onClick={() => commit(key, kind, value)}
                                                        >
                                                            {t("common.save")}
                                                        </button>
                                                    </div>
                                                    {seconds >= 60 && (
                                                        <p className="mt-1 text-xs text-muted-foreground">≈ {formatDuration(seconds, locale)}</p>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </div>
    );
}

/** AI 分頁:MCP 端點網址(由 PUBLIC_URL 決定)與相關頁面。/ AI tab: the MCP endpoint and related pages. */
function McpEndpointPanel() {
    const { t, tn } = useI18n();
    const serverUrl = useMcpServerUrl();
    const linkClass =
        "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:border-primary/50 hover:text-primary transition-colors";

    return (
        <section className="bg-card text-card-foreground shadow sm:rounded-lg border border-border p-4 sm:p-6">
            <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
                <Plug size={15} className="text-primary" />
                {t("settings.mcpEndpoint")}
            </h4>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/30 pl-3 pr-1 py-1">
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{serverUrl ?? "…"}</span>
                {serverUrl && <CopyButton value={serverUrl} />}
            </div>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {tn("settings.mcpEndpointHint", { env: <code className="px-1 rounded bg-muted font-mono text-[0.85em]">PUBLIC_URL</code> })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/tunnels/mcp" prefetch={false} className={linkClass}>
                    <Plug size={13} /> {t("nav.mcp")} <ArrowRight size={12} className="opacity-60" />
                </Link>
                <Link href="/tunnels/activity" prefetch={false} className={linkClass}>
                    <Activity size={13} /> {t("nav.activity")} <ArrowRight size={12} className="opacity-60" />
                </Link>
            </div>
        </section>
    );
}

/* ── 使用者管理 / User management (admin) ───────────────────────── */

function UsersTab() {
    const { user: currentUser } = useAuth();
    const { t, locale } = useI18n();
    const { users, loading, updateUser, resetMfa } = useUserManagement(true);
    const [editing, setEditing] = useState<ManagedUser | null>(null);

    // modal 內容跟著列表資料走,更新後即時反映。/ Keep the modal in sync with the list data.
    const editingUser = editing ? users.find((u) => u.id === editing.id) ?? editing : null;

    const formatDate = (iso: string | null) =>
        iso ? new Date(iso).toLocaleString(locale) : t("settings.neverLoggedIn");

    return (
        <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>{t("settings.usersBanner")}</span>
            </div>

            <div className="bg-card text-card-foreground shadow overflow-hidden sm:rounded-lg border border-border">
                {loading ? (
                    <div className="p-8 text-center text-muted-foreground">
                        <div className="flex justify-center mb-2">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        </div>
                        {t("settings.usersLoading")}
                    </div>
                ) : users.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">{t("settings.usersEmpty")}</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-border text-sm">
                            <thead className="bg-muted/50">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("settings.thUsername")}</th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden sm:table-cell">{t("settings.thEmail")}</th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("settings.thRole")}</th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("settings.thStatus")}</th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">{t("settings.thLastLogin")}</th>
                                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t("settings.thActions")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {users.map((u) => (
                                    <tr key={u.id} className="hover:bg-muted/50 transition-colors">
                                        <td className="px-4 py-3 font-medium text-foreground">
                                            {u.username}
                                            {u.id === currentUser?.id && (
                                                <span className="ml-2 text-xs text-muted-foreground">({t("settings.you")})</span>
                                            )}
                                            {u.mfa_enabled && (
                                                <span className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/10 text-green-600 dark:text-green-400" title={t("security.adminOn")}>
                                                    <ShieldCheck size={10} />
                                                    {t("security.badge")}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{u.email || "—"}</td>
                                        <td className="px-4 py-3">
                                            {u.is_superuser ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                                                    <Shield size={12} />
                                                    {t("settings.roleAdmin")}
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                                                    {t("settings.roleUser")}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${u.is_active
                                                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                                    : "bg-destructive/10 text-destructive"
                                                }`}>
                                                {u.is_active ? t("settings.statusActive") : t("settings.statusInactive")}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{formatDate(u.last_login)}</td>
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                type="button"
                                                onClick={() => setEditing(u)}
                                                className="text-xs px-3 py-1.5 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors font-medium"
                                            >
                                                {t("settings.manage")}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {editingUser && (
                <UserEditModal
                    user={editingUser}
                    isSelf={editingUser.id === currentUser?.id}
                    onClose={() => setEditing(null)}
                    updateUser={updateUser}
                    resetMfa={resetMfa}
                    t={t}
                />
            )}
        </div>
    );
}

/** 單一使用者的「管理」modal:帳號旗標 + 個人設定,變更即時套用。
 *  Per-user "Manage" modal: account flags + personal settings; changes apply immediately. */
function UserEditModal({
    user,
    isSelf,
    onClose,
    updateUser,
    resetMfa,
    t,
}: {
    user: ManagedUser;
    isSelf: boolean;
    onClose: () => void;
    updateUser: (userId: number, patch: ManagedUserPatch) => Promise<boolean>;
    resetMfa: (userId: number, username: string) => Promise<boolean>;
    t: Translate;
}) {
    const [saving, setSaving] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);

    const apply = async (patch: ManagedUserPatch) => {
        setSaving(true);
        await updateUser(user.id, patch);
        setSaving(false);
    };

    const languageOptions: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={`${t("settings.userModalTitle")} — ${user.username}`}
            isLoading={saving}
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
                <div className="text-sm text-muted-foreground">
                    {user.email || "—"}
                </div>

                {isSelf && (
                    <div className="bg-warning/10 border-l-4 border-warning p-3 rounded-r-md text-sm text-amber-800 dark:text-amber-200">
                        {t("settings.selfEditNote")}
                    </div>
                )}

                {/* 帳號啟用 / Account enabled */}
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-sm font-medium text-foreground">{t("settings.userActiveLabel")}</p>
                        <p className="text-sm text-muted-foreground">{t("settings.userActiveDescription")}</p>
                    </div>
                    <ToggleSwitch
                        checked={user.is_active}
                        disabled={isSelf || saving}
                        onToggle={() => apply({ is_active: !user.is_active })}
                    />
                </div>

                {/* 管理員角色 / Administrator role */}
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-sm font-medium text-foreground">{t("settings.userSuperuserLabel")}</p>
                        <p className="text-sm text-muted-foreground">{t("settings.userSuperuserDescription")}</p>
                    </div>
                    <ToggleSwitch
                        checked={user.is_superuser}
                        disabled={isSelf || saving}
                        onToggle={() => apply({ is_superuser: !user.is_superuser })}
                    />
                </div>

                {/* 介面語言 / Interface language */}
                <div>
                    <p className="text-sm font-medium text-foreground mb-1">{t("settings.userLanguageLabel")}</p>
                    <select
                        className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        value={user.language ?? ""}
                        disabled={saving}
                        onChange={(e) => {
                            const value = e.target.value as LanguagePreference | "";
                            if (value) apply({ language: value });
                        }}
                    >
                        {user.language === null && (
                            <option value="" disabled>
                                {t("settings.userLanguageNotSet")}
                            </option>
                        )}
                        {languageOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* 兩步驟驗證（使用者遺失 passkey / 手機時由管理員重設）/ Two-step verification reset */}
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-sm font-medium text-foreground">{t("security.adminTitle")}</p>
                        <p className="text-sm text-muted-foreground">{user.mfa_enabled ? t("security.adminOn") : t("security.adminOff")}</p>
                    </div>
                    {user.mfa_enabled && (
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => setConfirmReset(true)}
                            className="shrink-0 text-xs px-3 py-1.5 rounded-md border border-destructive/50 text-destructive hover:bg-destructive/10 transition-colors font-medium"
                        >
                            {t("security.adminReset")}
                        </button>
                    )}
                </div>
            </div>
            <ConfirmDialog
                isOpen={confirmReset}
                onClose={() => setConfirmReset(false)}
                onConfirm={async () => {
                    setConfirmReset(false);
                    setSaving(true);
                    await resetMfa(user.id, user.username);
                    setSaving(false);
                }}
                title={t("security.adminReset")}
                message={t("security.adminResetConfirm", { user: user.username })}
                confirmText={t("security.adminReset")}
                isDestructive
            />
        </Modal>
    );
}
