"use client";

/**
 * 管理區「使用者」頁的清單與「管理」視窗（以前是網站設定頁的一個分頁）。清單先搜尋 / 篩選全部帳號再分頁
 * （帳號多了以前只能整頁捲）；視窗是帳號旗標 + 個人設定，變更即時套用。
 * The admin Users page's list and Manage dialog (formerly a tab of the site settings page). Search and filters run
 * over every account, then the result is paged (the table used to be one long scroll); the dialog holds the
 * account flags + personal settings and applies changes immediately.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, History, KeySquare, Plug, Search, Shield, ShieldCheck, UserCog } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type LanguagePreference, type Translate } from "@/lib/i18n";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { NavTabs } from "@/components/ui/nav-tabs";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination } from "@/components/ui/pagination";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { usePagination } from "@/hooks/usePagination";
import { useUserManagement, type ManagedUser, type ManagedUserPatch } from "@/hooks/useUserManagement";
import { SignInHistory } from "@/components/layout/SignInHistory";
import { SignInDevices } from "@/components/layout/SignInDevices";
import { ApiTokens } from "@/components/tokens/ApiTokens";
import { ConnectedApps } from "@/components/layout/ConnectedApps";
import { CliSignIns } from "@/components/tokens/CliSignIns";
import { UserActivity } from "@/components/activity/UserActivity";
import { DisableAccountDialog } from "@/components/users/DisableAccountDialog";
import { USER_BUCKETS, bucketCounts, filterUsers, type UserBucket } from "@/lib/managedUsers";
import { pageSlice } from "@/lib/pagination";

/** 帳號超過這麼多才出現搜尋與篩選。/ Search and filters appear from this many accounts. */
const CONTROLS_FROM = 7;

export function UsersList() {
    const { user: currentUser } = useAuth();
    const { t, locale } = useI18n();
    const { users, loading, updateUser, resetMfa } = useUserManagement(true);
    const [editing, setEditing] = useState<ManagedUser | null>(null);
    const [query, setQuery] = useState("");
    const [bucket, setBucket] = useState<UserBucket>("all");
    const listRef = React.useRef<HTMLDivElement>(null);

    // modal 內容跟著列表資料走,更新後即時反映。/ Keep the modal in sync with the list data.
    const editingUser = editing ? users.find((u) => u.id === editing.id) ?? editing : null;

    const counts = bucketCounts(users, query);
    const found = filterUsers(users, query, bucket);
    const pager = usePagination(found.length, { storageKey: "telepy.adminUsersPageSize", resetKey: `${query}|${bucket}` });
    const shown = pageSlice(found, pager.page, pager.size);
    const showControls = users.length >= CONTROLS_FROM;
    const bucketLabel = (b: UserBucket) => `${t(`settings.usersFilter.${b}`)} (${counts[b]})`;

    const formatDate = (iso: string | null) =>
        iso ? new Date(iso).toLocaleString(locale) : t("settings.neverLoggedIn");

    return (
        <div className="space-y-4">
            {showControls && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative min-w-0 sm:w-72">
                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.usersSearch")} aria-label={t("settings.usersSearch")} className="h-8 pl-8" />
                    </div>
                    {/* 手機上是一行的下拉選單，桌面是切換按鈕。/ A one-line select on phones, buttons on desktop. */}
                    <NativeSelect className="h-8 text-sm sm:hidden" aria-label={t("settings.usersFilterAria")} value={bucket} onChange={(e) => setBucket(e.target.value as UserBucket)}>
                        {USER_BUCKETS.map((b) => <option key={b} value={b}>{bucketLabel(b)}</option>)}
                    </NativeSelect>
                    <div className="max-sm:hidden">
                        <Segmented size="sm" aria-label={t("settings.usersFilterAria")} value={bucket} onChange={setBucket} options={USER_BUCKETS.map((b) => ({ value: b, label: bucketLabel(b) }))} />
                    </div>
                </div>
            )}

            <div ref={listRef} className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
                {loading && users.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                        <div className="flex justify-center mb-2">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        </div>
                        {t("settings.usersLoading")}
                    </div>
                ) : users.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">{t("settings.usersEmpty")}</div>
                ) : found.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">{t("settings.usersNoMatch")}</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-border/70 text-sm">
                            <thead className="bg-surface">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground">{t("settings.thUsername")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden sm:table-cell">{t("settings.thEmail")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground">{t("settings.thRole")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground">{t("settings.thStatus")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden md:table-cell">{t("settings.thLastLogin")}</th>
                                    <th className="px-4 py-3 text-right text-xs text-muted-foreground">{t("settings.thActions")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/70" data-refresh-list>
                                {shown.map((u) => (
                                    <tr key={u.id} className="hover:bg-surface transition-colors">
                                        <td className="px-4 py-3 text-foreground">
                                            <span className="mr-2.5 inline-grid size-7 place-items-center rounded-full bg-foreground align-middle text-xs text-background uppercase" aria-hidden>
                                                {u.username.slice(0, 1)}
                                            </span>
                                            {u.username}
                                            {u.id === currentUser?.id && (
                                                <span className="ml-2 text-xs text-muted-foreground">({t("settings.you")})</span>
                                            )}
                                            {u.mfa_enabled && (
                                                <span className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[0.6875rem] bg-success/10 text-success" title={t("security.adminOn")}>
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
                                                    ? "bg-success/10 text-success"
                                                    : "bg-destructive/10 text-destructive"
                                                }`}>
                                                {u.is_active ? t("settings.statusActive") : t("settings.statusInactive")}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{formatDate(u.last_login)}</td>
                                        <td className="px-4 py-3 text-right">
                                            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(u)}>
                                                {t("settings.manage")}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            {found.length > 0 && <Pagination pager={pager} anchor={listRef} />}

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

/** 單一使用者的「管理」modal:帳號旗標 + 個人設定,變更即時套用。分頁跟偏好設定一樣放在左側欄
 *  (帳號 / 安全性 / 登入紀錄 / 已連接的應用程式 / API token / AI 活動),fixedHeight 讓切換分頁時視窗不跳動。
 *  Per-user "Manage" modal: account flags + personal settings; changes apply immediately. Tabs sit in
 *  the side rail like the preferences modal (account / security / sign-in history / connected apps / API tokens /
 *  AI activity), and
 *  fixedHeight keeps the dialog the same size when switching tabs. */
type UserModalTab = "account" | "security" | "history" | "apps" | "tokens" | "activity";

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
    // 停用前先看會切掉什麼（啟用不必問）。/ Disabling shows what gets cut first; enabling needs no confirmation.
    const [confirmDisable, setConfirmDisable] = useState(false);
    const [tab, setTab] = useState<UserModalTab>("account");

    const apply = async (patch: ManagedUserPatch) => {
        setSaving(true);
        await updateUser(user.id, patch);
        setSaving(false);
    };

    const languageOptions: { value: LanguagePreference; label: string }[] = [
        { value: "auto", label: t("language.auto") },
        ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] })),
    ];

    const tabs = [
        { value: "account" as const, label: t("settings.userTabAccount"), hint: t("settings.userTabAccountHint"), icon: <UserCog /> },
        { value: "security" as const, label: t("settings.userTabSecurity"), hint: t("settings.userTabSecurityHint"), icon: <ShieldCheck /> },
        { value: "history" as const, label: t("settings.userTabHistory"), hint: t("settings.userTabHistoryHint"), icon: <History /> },
        { value: "apps" as const, label: t("settings.userTabApps"), hint: t("settings.userTabAppsHint"), icon: <Plug /> },
        { value: "tokens" as const, label: t("settings.userTabTokens"), hint: t("settings.userTabTokensHint"), icon: <KeySquare /> },
        { value: "activity" as const, label: t("settings.userTabActivity"), hint: t("settings.userTabActivityHint"), icon: <Activity /> },
    ];

    const role = (
        <span className={`shrink-0 rounded-sm px-1.5 py-px text-xs ${user.is_superuser ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            {user.is_superuser ? t("settings.roleAdmin") : t("settings.roleUser")}
        </span>
    );

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={`${t("settings.userModalTitle")} — ${user.username}`}
            description={user.email || undefined}
            icon={<UserCog />}
            isLoading={saving}
            size="5xl"
            fixedHeight
            nav={
                <div className="space-y-4">
                    {/* 被管理的人(桌面在側欄上方)。/ Who is being managed: top of the rail on desktop. */}
                    <div className="hidden items-center gap-2.5 px-1.5 sm:flex">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background uppercase" aria-hidden>
                            {user.username.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">{user.username}</span>
                            {role}
                        </span>
                    </div>
                    <NavTabs tabs={tabs} value={tab} onChange={setTab} aria-label={t("settings.userModalTitle")} />
                </div>
            }
            footer={
                <Button type="button" variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            {tab === "account" && (
                <div className="space-y-6">
                    {isSelf && <Callout tone="warning">{t("settings.selfEditNote")}</Callout>}

                    {/* 帳號啟用 / Account enabled */}
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm text-foreground">{t("settings.userActiveLabel")}</p>
                            <p className="text-sm text-muted-foreground">{t("settings.userActiveDescription")}</p>
                        </div>
                        <Switch
                            checked={user.is_active}
                            disabled={isSelf || saving}
                            onCheckedChange={(v) => (v ? apply({ is_active: true }) : setConfirmDisable(true))}
                            aria-label={t("settings.userActiveLabel")}
                        />
                    </div>

                    {/* 管理員角色 / Administrator role */}
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm text-foreground">{t("settings.userSuperuserLabel")}</p>
                            <p className="text-sm text-muted-foreground">{t("settings.userSuperuserDescription")}</p>
                        </div>
                        <Switch
                            checked={user.is_superuser}
                            disabled={isSelf || saving}
                            onCheckedChange={(v) => apply({ is_superuser: v })}
                            aria-label={t("settings.userSuperuserLabel")}
                        />
                    </div>

                    {/* 介面語言 / Interface language */}
                    <div className="max-w-sm">
                        <p className="text-sm text-foreground mb-2">{t("settings.userLanguageLabel")}</p>
                        <NativeSelect
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
                        </NativeSelect>
                    </div>

                    {/* 功能權限（存取分頁；跟隧道分享無關）。/ Feature permissions (the Access tab; not tunnel sharing). */}
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm text-foreground">{t("access.manageTitle")}</p>
                            <p className="text-sm text-muted-foreground">{user.is_superuser ? t("access.adminAlways") : t("access.manageHint", { user: user.username })}</p>
                        </div>
                        <Button asChild type="button" size="sm" variant="outline" className="shrink-0">
                            <Link href={`/tunnels/admin/access?user=${user.id}`} onClick={onClose}>{t("access.manageOpen")}</Link>
                        </Button>
                    </div>
                </div>
            )}

            {tab === "security" && (
                <div className="space-y-6">
                    {/* 兩步驟驗證（使用者遺失 passkey / 手機時由管理員重設）/ Two-step verification reset */}
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm text-foreground">{t("security.adminTitle")}</p>
                            <p className="text-sm text-muted-foreground">{user.mfa_enabled ? t("security.adminOn") : t("security.adminOff")}</p>
                        </div>
                        {user.mfa_enabled && (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={saving}
                                onClick={() => setConfirmReset(true)}
                                className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                                {t("security.adminReset")}
                            </Button>
                        )}
                    </div>

                    {/* 登入中的瀏覽器（可登出）/ Signed-in browsers (sign out) */}
                    <SignInDevices userId={user.id} userName={user.username} />
                </div>
            )}

            {/* 最近的登入 / Recent sign-ins */}
            {tab === "history" && (
                <SignInHistory endpoint={`/api/user/users/${user.id}/sign-ins`} description={t("security.signInsAdminDescription")} />
            )}

            {/* 這個人核可過的 MCP app（可看詳細、可撤銷）；CLI 登入在 API 與 CLI 分頁。/ Their MCP apps; CLI sign-ins are on the API tab. */}
            {tab === "apps" && <ConnectedApps userId={user.id} onShowCli={() => setTab("tokens")} />}

            {/* 這個人的個人 API token 與 CLI 登入（可撤銷）/ Their personal API tokens and CLI sign-ins (revoke) */}
            {tab === "tokens" && (
                <div className="space-y-6">
                    <ApiTokens userId={user.id} />
                    <CliSignIns userId={user.id} />
                    {/* 這個人的 token 呼叫紀錄在管理區的 API 活動。/ Their token calls are in the admin section's API activity. */}
                    <Link
                        href={`/tunnels/admin/api-activity?user=${user.id}`}
                        prefetch={false}
                        onClick={onClose}
                        className="inline-flex items-center gap-1 text-sm text-foreground underline underline-offset-2"
                    >
                        {t("settings.userTokensCalls")} <ArrowRight size={13} className="opacity-60" />
                    </Link>
                </div>
            )}

            {/* 這個人的 app 與 token 呼叫過的工具 / Tool calls by their apps and tokens */}
            {tab === "activity" && <UserActivity userId={user.id} onNavigate={onClose} />}

            <DisableAccountDialog
                isOpen={confirmDisable}
                user={user}
                onClose={() => setConfirmDisable(false)}
                onConfirm={async () => {
                    await apply({ is_active: false });
                    setConfirmDisable(false);
                }}
            />

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

