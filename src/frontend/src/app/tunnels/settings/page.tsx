"use client";

/**
 * 網站設定頁(管理員專用)。分頁記在 ?tab=(MCP 頁可直接連到 AI 分頁),從 lg 起是黏在左側、依「帳號 / 功能」分組的一欄,
 * 窄一點是一行有分組的下拉選單。設定依 key 分頁(lib/siteSettingsTabs,有測試:後端的每個設定都要有家)。label 與說明
 * 優先用前端字典(siteSettings.<key>.label/.description),找不到才退回後端 meta;以秒為單位的設定用「數字 + 單位」輸入
 * (DurationField)。登入分頁另有「登入頁的樣子」面板,註冊分頁有允許的網域,AI 分頁顯示 MCP 端點網址。
 * 使用者與功能權限搬到管理區的「使用者與權限」(lib/adminAreas);舊的 ?tab=users / ?tab=access 會轉過去。
 * 個人偏好在 sidebar 左下角的齒輪 modal,不在這裡。
 * Site settings page (admin-only). The tab is kept in ?tab= (the MCP page deep-links to the AI tab); from lg the
 * tabs are a sticky left rail grouped as Accounts / Features, below that a one-line grouped select. Settings go to
 * a tab by key (lib/siteSettingsTabs, tested: every backend setting needs a home). Labels come from the frontend
 * dictionaries with a backend-meta fallback; seconds are edited as a number plus a unit. Users and feature access
 * moved to the admin section's "Users & access" (lib/adminAreas); the old ?tab=users / ?tab=access redirect there.
 * Personal preferences live in the sidebar gear modal instead.
 */
import React, { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { Settings, Shield, UserPlus, Globe, Bot, Plug, Activity, ArrowRight, Bell, ScreenShare, SquareTerminal, LogIn, Webhook, HeartPulse, Waypoints } from "lucide-react";
import { apiFetch, readJson } from "@/lib/api";
import { CopyButton } from "@/components/ui/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layout/PageHeader";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useSettingsPage, SettingMeta } from "@/hooks/useSettingsPage";
import { useMcpServerUrl } from "@/hooks/useMcpPage";
import { en } from "@/locales/en";
import type { TranslationKey } from "@/locales/en";
import { SIGNIN_LOOK_KEYS, SignInLookPanel } from "@/components/auth/SignInLookSettings";
import { REGISTER_DOMAIN_KEYS, RegisterDomainsPanel } from "@/components/settings/RegisterDomains";
import { movedSettingsTab } from "@/lib/adminAreas";
import { SITE_TAB_GROUPS, parseSiteTab, siteTabOf, type SiteTabId } from "@/lib/siteSettingsTabs";

function titleize(key: string) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 只能選固定值的字串設定：用下拉選單。/ String settings with a fixed set of values get a select. */
const SETTING_CHOICES: Record<string, { value: string; label: TranslationKey }[]> = {
    desktop_clipboard: [
        { value: "both", label: "siteSettings.desktop_clipboard.both" },
        { value: "to_remote", label: "siteSettings.desktop_clipboard.to_remote" },
        { value: "off", label: "siteSettings.desktop_clipboard.off" },
    ],
};

/** 以秒為單位的站台設定(逾時 / 存活時間)。/ Site settings measured in seconds. */
const SECONDS_KEY = /_(timeout|lifetime|delay|secs)$/;

/** 秒數設定的單位(由小到大)。/ Units for seconds-based settings, smallest first. */
type DurationUnit = "seconds" | "minutes" | "hours" | "days";
const DURATION_UNITS: { id: DurationUnit; secs: number; label: TranslationKey }[] = [
    { id: "seconds", secs: 1, label: "settings.unitSeconds" },
    { id: "minutes", secs: 60, label: "settings.unitMinutes" },
    { id: "hours", secs: 3600, label: "settings.unitHours" },
    { id: "days", secs: 86400, label: "settings.unitDays" },
];
const unitSecs = (id: DurationUnit) => DURATION_UNITS.find((u) => u.id === id)?.secs ?? 1;
/** 能整除的最大單位(2592000 → 天、3600 → 小時、90 → 秒)。/ The largest unit that divides the value exactly. */
function unitFor(seconds: number): DurationUnit {
    for (const u of [...DURATION_UNITS].reverse()) {
        if (seconds > 0 && seconds % u.secs === 0) return u.id;
    }
    return "seconds";
}
/** 單位換算後的顯示值(最多兩位小數)。/ The amount in a unit, at most two decimals. */
const amountIn = (seconds: number, unit: DurationUnit) => String(Math.round((seconds / unitSecs(unit)) * 100) / 100);

/**
 * 以秒儲存的設定:數字 + 單位 + 儲存。換單位時數值跟著換算(30 天 → 720 小時),存回去的永遠是秒。
 * 存好的值變了(存檔、還原、重新載入)時由呼叫端以 key 重新掛載,所以這裡只在初始化時推導一次。
 * A seconds-based setting: number + unit + save. Switching the unit converts the amount (30 days → 720 hours);
 * what is saved is always seconds. The caller remounts it (key) when the saved value changes, so the local
 * state is derived once.
 */
function DurationField({ seconds, label, onSave }: { seconds: number; label: string; onSave: (seconds: number) => void }) {
    const { t } = useI18n();
    const [unit, setUnit] = useState<DurationUnit>(() => unitFor(seconds));
    const [amount, setAmount] = useState(() => amountIn(seconds, unitFor(seconds)));
    const commit = () => {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) return;
        onSave(Math.round(n * unitSecs(unit)));
    };
    const changeUnit = (next: DurationUnit) => {
        const n = Number(amount);
        if (Number.isFinite(n)) setAmount(amountIn(n * unitSecs(unit), next));
        setUnit(next);
    };
    return (
        <div className="flex items-center gap-2">
            <Input
                type="number"
                className="w-24 h-8"
                value={amount}
                min={0}
                step="any"
                aria-label={label}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            />
            <NativeSelect className="h-8 w-28" value={unit} onChange={(e) => changeUnit(e.target.value as DurationUnit)} aria-label={t("settings.unitLabel")}>
                {DURATION_UNITS.map((u) => <option key={u.id} value={u.id}>{t(u.label)}</option>)}
            </NativeSelect>
            <Button type="button" size="sm" variant="soft" onClick={commit}>
                {t("common.save")}
            </Button>
        </div>
    );
}

/** 分頁裡排最前面的設定（開關整個功能的）。/ Settings listed first in their tab (the ones that turn a feature on). */
const LEAD_KEYS = ["notify_user_webhooks", "lan_scan_enabled"];

/** 每一頁的名字、圖示與上面那段說明。/ Each tab's name, icon and the note on top. */
const SITE_TABS: Record<SiteTabId, { label: TranslationKey; icon: React.ReactNode; banner: TranslationKey }> = {
    general: { label: "settings.groupAccount", icon: <UserPlus size={15} />, banner: "settings.generalBanner" },
    signin: { label: "settings.groupSignin", icon: <LogIn size={15} />, banner: "settings.signinBanner" },
    commands: { label: "settings.groupCommands", icon: <SquareTerminal size={15} />, banner: "settings.commandsBanner" },
    desktop: { label: "settings.groupDesktop", icon: <ScreenShare size={15} />, banner: "settings.desktopBanner" },
    browser: { label: "settings.groupRemoteBrowser", icon: <Globe size={15} />, banner: "settings.browserBanner" },
    devices: { label: "settings.groupDevices", icon: <Waypoints size={15} />, banner: "settings.devicesBanner" },
    ai: { label: "settings.groupAi", icon: <Bot size={15} />, banner: "settings.aiBanner" },
    notify: { label: "settings.groupNotify", icon: <Bell size={15} />, banner: "settings.notifyBanner" },
};

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
                <Callout tone="warning">{t("settings.adminOnly")}</Callout>
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

    // 使用者與功能權限搬到管理區了：舊書籤轉過去。/ Users and feature access moved to the admin section: old bookmarks follow.
    const moved = movedSettingsTab(searchParams.get("tab"), searchParams.get("user"));
    React.useEffect(() => {
        if (moved) router.replace(moved);
    }, [moved, router]);

    const tab = parseSiteTab(searchParams.get("tab"));
    const setTab = (next: SiteTabId) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === "general") params.delete("tab");
        else params.set("tab", next);
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    };
    const navTabs = (ids: readonly SiteTabId[]): NavTab<SiteTabId>[] => ids.map((id) => ({ value: id, label: t(SITE_TABS[id].label), icon: SITE_TABS[id].icon }));
    if (moved) return null;

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader
                icon={<Settings />}
                title={t("settings.title")}
                titleAddon={<Chip tone="primary"><Shield /> {t("common.adminOnly")}</Chip>}
                description={t("settings.subtitle")}
            />

            <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6">
                {/* 窄的時候是一行有分組的下拉選單（十個分頁的橫列看不到大半）；從 lg 起是黏在左側、分組的一欄。
                    Below lg a one-line grouped select (a row of ten tabs hides most of them); from lg a sticky grouped rail. */}
                <NativeSelect className="h-9 lg:hidden" aria-label={t("settings.tabsAria")} value={tab} onChange={(e) => setTab(e.target.value as SiteTabId)}>
                    {SITE_TAB_GROUPS.map((g) => (
                        <optgroup key={g.id} label={t(g.key)}>
                            {g.tabs.map((id) => <option key={id} value={id}>{t(SITE_TABS[id].label)}</option>)}
                        </optgroup>
                    ))}
                </NativeSelect>
                <nav aria-label={t("settings.tabsAria")} className="hidden space-y-4 lg:sticky lg:top-20 lg:block">
                    {SITE_TAB_GROUPS.map((g) => (
                        <div key={g.id}>
                            <p className="px-3 pb-1 text-xs text-muted-foreground">{t(g.key)}</p>
                            <NavTabs tabs={navTabs(g.tabs)} value={tab} onChange={setTab} aria-label={t(g.key)} />
                        </div>
                    ))}
                </nav>

                <div className="min-w-0">
                    <SiteSettingsTab tab={tab} settings={settings} />
                </div>
            </div>
        </div>
    );
}

/* ── 站台設定 / Site settings (admin) ───────────────────────────── */

function SiteSettingsTab({ tab, settings }: { tab: SiteTabId; settings: ReturnType<typeof useSettingsPage> }) {
    const { t } = useI18n();
    const { state, actions } = settings;
    const { settingsObj, meta, loading } = state;
    const { handleToggle, handleUpdate } = actions;
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    // 後端的鍵是字母序；開關整個功能的那個排最前面。/ Keys arrive sorted; the switch that turns a feature on goes first.
    // 登入頁的樣子與允許的註冊網域各有自己的面板，不在一般清單裡。/ The sign-in look and the allowed registration domains have their own panels.
    const entries = Object.entries(settingsObj)
        .filter(([k]) => siteTabOf(k) === tab && !SIGNIN_LOOK_KEYS.includes(k) && !REGISTER_DOMAIN_KEYS.includes(k))
        .sort(([a], [b]) => Number(!LEAD_KEYS.includes(a)) - Number(!LEAD_KEYS.includes(b)));

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
            // 網址欄位可以清空（= 關閉）。/ URL fields may be cleared (= off).
            if (!s && kind !== "url") return;
            handleUpdate(key, s);
        }
    };

    return (
        <div className="space-y-6">
            <Callout tone="info">{t(SITE_TABS[tab].banner)}</Callout>

            {tab === "ai" && <McpEndpointPanel />}
            {tab === "notify" && <WebhooksPanel />}
            {tab === "commands" && <SiteCommandRulesPanel />}

            {loading ? (
                <div className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card p-8 text-center text-muted-foreground">
                    <div className="flex justify-center mb-2">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                    {t("settings.loading")}
                </div>
            ) : entries.length === 0 ? (
                <div className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card p-8 text-center text-muted-foreground">
                    {t("settings.empty")}
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                    <ul className="divide-y divide-border/70">
                        {entries.map(([key, value]) => {
                            const kind = typeOf(key, value);
                            const m = meta[key];
                            const description = descriptionOf(key, m);
                            const current = editValues[key] ?? String(value ?? "");
                            return (
                                <li key={key} className="p-4 sm:px-6 sm:py-5 transition-colors hover:bg-surface">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-[1rem] text-foreground">
                                                {labelOf(key, m)}
                                            </h4>
                                            {description && (
                                                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                                                    {description}
                                                </p>
                                            )}
                                            <p className="mt-2 inline-block rounded-md bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground/80">
                                                {key}
                                            </p>
                                        </div>
                                        <div className="shrink-0 pt-0.5">
                                            {kind === "boolean" ? (
                                                <Switch checked={!!value} onCheckedChange={() => handleToggle(key, value)} aria-label={labelOf(key, m)} />
                                            ) : SETTING_CHOICES[key] ? (
                                                <NativeSelect className="h-8 w-56" value={String(value ?? "")} onChange={(e) => handleUpdate(key, e.target.value)} aria-label={labelOf(key, m)}>
                                                    {SETTING_CHOICES[key].map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
                                                </NativeSelect>
                                            ) : kind === "integer" && SECONDS_KEY.test(key) ? (
                                                <DurationField key={String(value)} seconds={Number(value) || 0} label={labelOf(key, m)} onSave={(secs) => handleUpdate(key, secs)} />
                                            ) : (
                                                <>
                                                    <div className="flex items-center gap-2">
                                                        <Input
                                                            type={kind === "integer" ? "number" : kind === "url" ? "url" : "text"}
                                                            className={`${kind === "integer" ? "w-24" : kind === "url" ? "w-56 sm:w-80" : "w-56"} h-8`}
                                                            value={current}
                                                            onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
                                                            onKeyDown={(e) => { if (e.key === "Enter") commit(key, kind, value); }}
                                                            min={kind === "integer" ? 0 : undefined}
                                                        />
                                                        <Button type="button" size="sm" variant="soft" onClick={() => commit(key, kind, value)}>
                                                            {t("common.save")}
                                                        </Button>
                                                    </div>
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

            {tab === "general" && !loading && <RegisterDomainsPanel values={settingsObj} onSave={handleUpdate} />}
            {tab === "signin" && !loading && <SignInLookPanel values={settingsObj} onSave={handleUpdate} />}
            {/* 位址檢查搬到管理區的「伺服器狀態」頁（那是診斷，不是設定）；這裡只留一個指路。
                The address check lives on the admin "Server health" page now (a diagnostic, not a setting); only a pointer here. */}
            {tab === "signin" && (
                <Callout tone="info" icon={<HeartPulse size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                    {t("health.fromSignin")}{" "}
                    <Link href="/tunnels/admin/health?tab=addresses#client-ip" prefetch={false} className="inline-flex items-center gap-1 text-foreground underline underline-offset-2">
                        {t("nav.adminHealth")} <ArrowRight size={12} className="opacity-60" />
                    </Link>
                </Callout>
            )}
        </div>
    );
}

/** AI 分頁:MCP 端點網址(由 PUBLIC_URL 決定)與相關頁面。/ AI tab: the MCP endpoint and related pages. */
function McpEndpointPanel() {
    const { t, tn } = useI18n();
    const serverUrl = useMcpServerUrl();
    const linkClass =
        "inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg ring-1 ring-inset ring-border hover:ring-primary/50 hover:text-primary transition-colors";

    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card p-4 sm:p-6">
            <SectionHeading icon={<Plug />} title={t("settings.mcpEndpoint")} />
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface pl-3.5 pr-1 py-1 ring-1 ring-inset ring-border/80">
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{serverUrl ?? "…"}</span>
                {serverUrl && <CopyButton value={serverUrl} />}
            </div>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {tn("settings.mcpEndpointHint", { env: <code className="px-1 rounded bg-muted font-mono text-[0.85em]">PUBLIC_URL</code> })}
            </p>
            {/* telepy login 也走這台 OAuth 伺服器、telepy exec 也算進 AI 上限；它的登入列在 API 頁，不在 MCP app 裡。
                telepy login uses this OAuth server too and telepy exec counts toward the AI limits; its sign-ins live on the API page. */}
            <Callout tone="info" className="mt-3">
                {t("settings.mcpCliNote")}
            </Callout>
            <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/tunnels/mcp" prefetch={false} className={linkClass}>
                    <Plug size={13} /> {t("nav.mcp")} <ArrowRight size={12} className="opacity-60" />
                </Link>
                <Link href="/tunnels/admin/activity" prefetch={false} className={linkClass}>
                    <Activity size={13} /> {t("nav.adminActivity")} <ArrowRight size={12} className="opacity-60" />
                </Link>
            </div>
        </section>
    );
}

/** 全站指令規則在管理區的全站指令規則頁編輯；這裡放入口與目前的數量。/ Site-wide rules are edited on the admin section's Site command rules page; this links there. */
function SiteCommandRulesPanel() {
    const { t } = useI18n();
    const [count, setCount] = useState<number | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const res = await apiFetch("/api/command-rules");
            const body = await readJson<{ site?: unknown[] }>(res);
            if (!cancelled && res.ok) setCount(body?.site?.length ?? 0);
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card p-4 sm:p-6">
            <SectionHeading icon={<SquareTerminal />} title={t("settings.commandsRulesTitle")} />
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{count === null ? "…" : t("settings.commandsRulesBody", { count })}</p>
            <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href="/tunnels/admin/commands">
                    {t("settings.commandsRulesOpen")} <ArrowRight />
                </Link>
            </Button>
        </section>
    );
}

/** 通知分頁：webhook 在自己的頁面（全站的在管理區的全站 Webhook 頁）。/ The Notifications tab: webhooks have their own pages (site-wide ones in the admin section). */
function WebhooksPanel() {
    const { t } = useI18n();
    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card p-4 sm:p-6">
            <SectionHeading icon={<Webhook />} title={t("settings.webhooksTitle")} />
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t("settings.webhooksBody")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button asChild variant="outline" size="sm">
                    <Link href="/tunnels/admin/webhooks">
                        {t("settings.webhooksSite")} <ArrowRight />
                    </Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                    <Link href="/tunnels/webhooks">{t("settings.webhooksMine")}</Link>
                </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground leading-relaxed">{t("settings.notifyDesktopNote")}</p>
        </section>
    );
}
