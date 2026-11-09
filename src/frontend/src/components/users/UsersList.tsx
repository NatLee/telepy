"use client";

/**
 * 管理區「使用者」頁的清單與「管理」視窗（以前是網站設定頁的一個分頁）。清單先搜尋 / 篩選全部帳號再分頁
 * （帳號多了以前只能整頁捲）；視窗是帳號旗標 + 個人設定，變更即時套用。
 * The admin Users page's list and Manage dialog (formerly a tab of the site settings page). Search and filters run
 * over every account, then the result is paged (the table used to be one long scroll); the dialog holds the
 * account flags + personal settings and applies changes immediately.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, BadgeCheck, History, KeySquare, Plug, Search, Shield, ShieldCheck, UserCog, Users } from "lucide-react";
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
import { inMembership, keepVisible, liveFilter, membershipIndex, togglePage, type MemberFilter } from "@/lib/peopleMembers";
import { useAccessPage } from "@/hooks/useAccessPage";
import { BulkPickDialog, MembershipCounts, MembershipFilter, MembershipTab, useChoices, useMembershipWrite, type MembershipKind } from "@/components/users/UserMemberships";
import { pageSlice } from "@/lib/pagination";

/** 帳號超過這麼多才出現搜尋與篩選。/ Search and filters appear from this many accounts. */
const CONTROLS_FROM = 7;

export function UsersList() {
    const { user: currentUser } = useAuth();
    const { t, locale } = useI18n();
    const { users, loading, updateUser, resetMfa } = useUserManagement(true);
    const access = useAccessPage();
    const choices = useChoices(access);
    const write = useMembershipWrite(access);
    const [editing, setEditing] = useState<ManagedUser | null>(null);
    const [query, setQuery] = useState("");
    const [bucket, setBucket] = useState<UserBucket>("all");
    const [roleFilterRaw, setRoleFilter] = useState<MemberFilter>("any");
    const [groupFilterRaw, setGroupFilter] = useState<MemberFilter>("any");
    const [selected, setSelected] = useState<Set<number>>(() => new Set());
    const [bulk, setBulk] = useState<{ kind: MembershipKind; op: "add" | "remove" } | null>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    const index = useMemo(() => membershipIndex(choices.roles, choices.groups), [choices]);
    const roleNames = useMemo(() => new Map(choices.roles.map((g) => [g.id, g.name])), [choices]);
    const groupNames = useMemo(() => new Map(choices.groups.map((g) => [g.id, g.name])), [choices]);
    // 篩選的角色 / 群組被刪了就回到「任何」。/ A deleted role / group filter falls back to "any".
    const roleFilter = liveFilter(roleFilterRaw, choices.roles.map((g) => g.id));
    const groupFilter = liveFilter(groupFilterRaw, choices.groups.map((g) => g.id));

    // modal 內容跟著列表資料走,更新後即時反映。/ Keep the modal in sync with the list data.
    const editingUser = editing ? users.find((u) => u.id === editing.id) ?? editing : null;

    const inFilters = users.filter((u) => inMembership(index.get(u.id), roleFilter, groupFilter));
    const counts = bucketCounts(inFilters, query);
    const found = filterUsers(inFilters, query, bucket);
    const pager = usePagination(found.length, { storageKey: "telepy.adminUsersPageSize", resetKey: `${query}|${bucket}|${roleFilter}|${groupFilter}` });
    const shown = pageSlice(found, pager.page, pager.size);
    // 只算還在結果裡的勾選：看不到的人不會被批次改到。/ Only ticks still in the result count: hidden people are never changed in bulk.
    const picked = keepVisible(selected, found.map((u) => u.id));
    const pageIds = shown.map((u) => u.id);
    const pageAll = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
    const pageSome = pageIds.some((id) => picked.has(id));
    const filtered = roleFilter !== "any" || groupFilter !== "any";
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
            {access.policy && (choices.roles.length > 0 || choices.groups.length > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                    <MembershipFilter kind="role" items={choices.roles} value={roleFilter} onChange={setRoleFilter} />
                    <MembershipFilter kind="group" items={choices.groups} value={groupFilter} onChange={setGroupFilter} />
                    {filtered && (
                        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => { setRoleFilter("any"); setGroupFilter("any"); }}>
                            {t("members.clearFilters")}
                        </Button>
                    )}
                </div>
            )}
            {pageAll && found.length > shown.length && (
                <p className="text-sm text-muted-foreground" aria-live="polite">
                    {picked.size < found.length ? (
                        <>
                            {t("members.selectedOnPage", { count: picked.size })}{" "}
                            <button type="button" className="text-foreground underline underline-offset-2" onClick={() => setSelected(new Set(found.map((u) => u.id)))}>
                                {t("members.selectAllMatching", { count: found.length })}
                            </button>
                        </>
                    ) : (
                        t("members.allMatchingSelected", { count: found.length })
                    )}
                </p>
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
                                    <th className="w-10 py-3 pl-4 pr-0 text-left">
                                        <input
                                            type="checkbox"
                                            className="size-4 accent-primary align-middle"
                                            checked={pageAll}
                                            ref={(el) => {
                                                if (el) el.indeterminate = !pageAll && pageSome;
                                            }}
                                            onChange={() => setSelected(togglePage(picked, pageIds))}
                                            aria-label={t("members.selectPage")}
                                        />
                                    </th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground">{t("settings.thUsername")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden sm:table-cell">{t("settings.thEmail")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden sm:table-cell">{t("settings.thAccountType")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden sm:table-cell">{t("settings.thStatus")}</th>
                                    <th className="px-4 py-3 text-left text-xs text-muted-foreground hidden md:table-cell">{t("settings.thLastLogin")}</th>
                                    <th className="px-4 py-3 text-right text-xs text-muted-foreground">{t("settings.thActions")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/70" data-refresh-list>
                                {shown.map((u) => (
                                    <tr key={u.id} className={`transition-colors hover:bg-surface ${picked.has(u.id) ? "bg-surface" : ""}`}>
                                        <td className="w-10 py-3 pl-4 pr-0 align-top">
                                            <input
                                                type="checkbox"
                                                className="mt-1 size-4 accent-primary"
                                                checked={picked.has(u.id)}
                                                onChange={() => {
                                                    const next = new Set(picked);
                                                    if (next.has(u.id)) next.delete(u.id);
                                                    else next.add(u.id);
                                                    setSelected(next);
                                                }}
                                                aria-label={t("members.selectUser", { name: u.username })}
                                            />
                                        </td>
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
                                            {u.provisioned_by && (
                                                <span className="ml-2 text-xs text-muted-foreground" title={t("scim.userHint", { provider: u.provisioned_by })}>
                                                    {t("scim.provisionedBy", { provider: u.provisioned_by })}
                                                </span>
                                            )}
                                            {/* 手機上：帳號類型、狀態、email 收在名字下面一行小字，表格只留勾選、名字、管理。
                                                Phones: account type, status and email go on one quiet line under the name. */}
                                            <span className="mt-0.5 block pl-[2.375rem] text-xs text-muted-foreground sm:hidden">
                                                <span className={u.is_superuser ? "text-primary" : undefined}>{u.is_superuser ? t("settings.roleAdmin") : t("settings.roleUser")}</span>
                                                {" · "}
                                                <span className={u.is_active ? "text-success" : "text-destructive"}>{u.is_active ? t("settings.statusActive") : t("settings.statusInactive")}</span>
                                                {u.email && <span className="block break-all">{u.email}</span>}
                                            </span>
                                            {access.policy && (
                                                <span className="mt-0.5 block pl-[2.375rem]">
                                                    <MembershipCounts
                                                        roles={(index.get(u.id)?.roles ?? []).map((id) => roleNames.get(id) ?? `#${id}`)}
                                                        groups={(index.get(u.id)?.groups ?? []).map((id) => groupNames.get(id) ?? `#${id}`)}
                                                    />
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{u.email || "—"}</td>
                                        <td className="px-4 py-3 hidden sm:table-cell">
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
                                        <td className="px-4 py-3 hidden sm:table-cell">
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

            {picked.size > 0 && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2 shadow-pop ring-1 ring-border" role="region" aria-label={t("members.bulkAria")}>
                    <span className="mr-auto text-sm text-foreground">{t("members.bulkSelected", { count: picked.size })}</span>
                    <span className="flex flex-wrap gap-1.5">
                        <Button type="button" size="sm" variant="outline" disabled={!access.policy} onClick={() => setBulk({ kind: "role", op: "add" })}>
                            <BadgeCheck size={14} /> {t("members.bulkAddRole")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={!access.policy} onClick={() => setBulk({ kind: "group", op: "add" })}>
                            <Users size={14} /> {t("members.bulkAddGroup")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={!access.policy} onClick={() => setBulk({ kind: "role", op: "remove" })}>
                            {t("members.bulkRemoveRole")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={!access.policy} onClick={() => setBulk({ kind: "group", op: "remove" })}>
                            {t("members.bulkRemoveGroup")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                            {t("members.clearSelection")}
                        </Button>
                    </span>
                </div>
            )}

            {bulk && (
                <BulkPickDialog
                    kind={bulk.kind}
                    op={bulk.op}
                    items={bulk.kind === "role" ? choices.roles : choices.groups}
                    selected={[...picked]}
                    busy={access.saving || write.checking}
                    onClose={() => setBulk(null)}
                    onRun={(target) => {
                        const { kind, op } = bulk;
                        setBulk(null);
                        void write.run(kind, op, target, [...picked]);
                    }}
                />
            )}
            {write.dialog}

            {editingUser && (
                <UserEditModal
                    user={editingUser}
                    isSelf={editingUser.id === currentUser?.id}
                    onClose={() => setEditing(null)}
                    updateUser={updateUser}
                    resetMfa={resetMfa}
                    access={access}
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
type UserModalTab = "account" | "membership" | "security" | "history" | "apps" | "tokens" | "activity";

function UserEditModal({
    user,
    isSelf,
    onClose,
    updateUser,
    resetMfa,
    access,
    t,
}: {
    user: ManagedUser;
    access: ReturnType<typeof useAccessPage>;
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
        { value: "membership" as const, label: t("settings.userTabMembership"), hint: t("settings.userTabMembershipHint"), icon: <BadgeCheck /> },
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
                            {user.provisioned_by && <p className="mt-1 text-sm text-warning">{t("scim.userHint", { provider: user.provisioned_by })}</p>}
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

            {tab === "membership" && <MembershipTab access={access} userId={user.id} isSuperuser={user.is_superuser} onNavigate={onClose} />}

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

