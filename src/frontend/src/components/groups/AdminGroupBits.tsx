"use client";

/**
 * 管理區「角色」與「群組」兩頁共用的積木：清單（搜尋 + 分頁 + 新增）、成員編輯（按儲存才送出）、名稱 / 說明的對話框，
 * 以及每頁最上面那一行「角色決定功能、群組決定分享」的說明（連到另一頁）。
 * Blocks shared by the admin Roles and Groups pages: the list (search, pages, new), the members editor (sent on
 * Save), the name / description dialog, and the one-line "roles decide features, groups decide sharing" note at the
 * top of each page (linking to the other one).
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Search, Shield, User, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { Chip } from "@/components/ui/section";
import { MemberPicker } from "@/components/groups/MemberPicker";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import type { AccessUser } from "@/lib/features";
import { memberDiff, nameProblem } from "@/lib/peopleGroups";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 「角色決定功能、群組決定分享」：每頁最上面一行，連到另一頁。/ The one-line difference, linking to the other page. */
export function RolesVsGroups({ page }: { page: "roles" | "groups" }) {
    const { t, tn } = useI18n();
    const other = page === "roles" ? "/tunnels/admin/groups" : "/tunnels/admin/roles";
    return (
        <Callout tone="info" title={t(page === "roles" ? "roles.diffTitle" : "adminGroups.diffTitle")}>
            {tn(page === "roles" ? "roles.diff" : "adminGroups.diff", {
                link: (
                    <Link href={other} className="text-foreground underline underline-offset-2">
                        {t(page === "roles" ? "adminGroups.title" : "roles.title")}
                    </Link>
                ),
            })}
        </Callout>
    );
}

/** 左邊的清單（搜尋從 7 個起、分頁）。/ The list on the left (search from 7, pages). */
export function AdminGroupList<T extends { id: number; name: string }>({
    items,
    filter,
    current,
    onPick,
    onCreate,
    title,
    searchLabel,
    emptyText,
    storageKey,
    icon: Icon,
    sub,
    badge,
    ariaLabel,
}: {
    items: T[];
    filter: (items: T[], query: string) => T[];
    current: number | null;
    onPick: (id: number) => void;
    onCreate: () => void;
    title: string;
    searchLabel: string;
    emptyText: string;
    storageKey: string;
    icon: LucideIcon;
    sub: (item: T) => React.ReactNode;
    badge?: (item: T) => React.ReactNode;
    ariaLabel: string;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = filter(items, query);
    const pager = usePagination(shown.length, { storageKey, resetKey: query });
    return (
        <nav className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-card" aria-label={ariaLabel}>
            <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs text-muted-foreground">
                    {title} <span className="tabular-nums">({query.trim() ? `${shown.length}/${items.length}` : items.length})</span>
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onCreate}>
                    <Plus size={14} /> {t("access.newGroupShort")}
                </Button>
            </div>
            {items.length >= 7 && (
                <div className="relative px-1">
                    <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} className="h-8 pl-8" aria-label={searchLabel} />
                </div>
            )}
            {items.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{emptyText}</p>}
            {items.length > 0 && shown.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noMatch")}</p>}
            <div className="space-y-1">
                {pageSlice(shown, pager.page, pager.size).map((g) => {
                    const active = g.id === current;
                    return (
                        <button
                            key={g.id}
                            type="button"
                            onClick={() => onPick(g.id)}
                            aria-current={active ? "true" : undefined}
                            className={cn(
                                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                                active ? "bg-muted text-foreground [&>svg]:text-primary" : "text-muted-foreground hover:bg-surface hover:text-foreground",
                            )}
                        >
                            <Icon size={16} />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-foreground">{g.name}</span>
                                <span className="block text-xs leading-snug text-muted-foreground">{sub(g)}</span>
                            </span>
                            {badge?.(g)}
                        </button>
                    );
                })}
            </div>
            <Pagination pager={pager} compact className="justify-center pt-1" />
        </nav>
    );
}

/** 載入中 / 讀不到。/ Loading / failed. */
export function PolicyState({ header, loading }: { header: React.ReactNode; loading: boolean }) {
    const { t } = useI18n();
    return (
        <div className="space-y-6">
            {header}
            {loading ? (
                <div className="flex justify-center py-12 text-muted-foreground">
                    <div className="mr-3 size-6 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden />
                    {t("access.loading")}
                </div>
            ) : (
                <Callout tone="danger">{t("access.loadFailed")}</Callout>
            )}
        </div>
    );
}

/** 沒有任何一個時的空白狀態。/ The empty state when there is none. */
export function EmptyGroups({ icon: Icon, text, action, onCreate }: { icon: LucideIcon; text: string; action: string; onCreate: () => void }) {
    return (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                <Icon size={20} />
            </span>
            <p className="mb-3 text-sm text-muted-foreground">{text}</p>
            <Button type="button" onClick={onCreate}>
                <Plus size={15} /> {action}
            </Button>
        </div>
    );
}

/** 成員：先在這裡改、按儲存才送出。單一登入給的成員有建築物圖示。/ Members: edited here, sent on Save; SSO members are marked. */
export function MembersEditor({
    users,
    groupId,
    members,
    ssoMembers,
    saving,
    onSave,
}: {
    users: AccessUser[];
    groupId: number;
    members: number[];
    ssoMembers: { user_id: number; provider: string }[] | undefined;
    saving: boolean;
    onSave: (members: number[]) => Promise<unknown>;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<number[]>(members);
    const [base, setBase] = useState(members);
    if (base !== members) {
        setBase(members);
        setDraft(members);
    }
    const items = useMemo(() => {
        const sso = new Map((ssoMembers ?? []).map((m) => [m.user_id, m.provider] as const));
        return users.map((u) => ({
            id: u.id,
            label: u.username,
            text: [u.username, u.email],
            group: null,
            icon: u.is_superuser ? <Shield size={14} className="shrink-0 text-muted-foreground" aria-hidden /> : <User size={14} className="shrink-0 text-muted-foreground" aria-hidden />,
            meta: sso.has(u.id) ? <Building2 size={14} className="shrink-0 text-muted-foreground" aria-label={t("access.viaSso", { provider: sso.get(u.id) ?? "" })} /> : u.is_superuser ? <Chip>{t("access.adminChip")}</Chip> : undefined,
            title: sso.has(u.id) ? t("access.viaSso", { provider: sso.get(u.id) ?? "" }) : u.email || u.username,
        }));
    }, [users, ssoMembers, t]);
    const { added, removed } = memberDiff(members, draft);
    return (
        <div className="space-y-2">
            <MemberPicker items={items} selected={draft} onChange={setDraft} current={groupId} title={t("access.members")} hint={t("access.membersHint")} showFree={false} />
            {added + removed > 0 && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 shadow-pop ring-1 ring-border">
                    <span className="text-sm text-foreground">{t("access.membersChanged", { added, removed })}</span>
                    <span className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setDraft(members)}>{t("access.membersDiscard")}</Button>
                        <Button type="button" size="sm" disabled={saving} onClick={() => void onSave(draft)}>{t("access.membersSave")}</Button>
                    </span>
                </div>
            )}
        </div>
    );
}

/** 名稱與說明。/ Name and description. */
export function GroupNameDialog({
    title,
    hint,
    icon,
    initialName = "",
    initialDescription = "",
    placeholder,
    saving,
    onClose,
    onSave,
}: {
    title: string;
    /** 對話框最上面的一句話（角色 / 群組的差別）。/ One line at the top (role vs group). */
    hint?: string;
    icon: React.ReactNode;
    initialName?: string;
    initialDescription?: string;
    placeholder: string;
    saving: boolean;
    onClose: () => void;
    onSave: (draft: { name: string; description: string }) => void;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(initialName);
    const [description, setDescription] = useState(initialDescription);
    const valid = nameProblem(name) === null;
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (valid && !saving) onSave({ name: name.trim(), description: description.trim() });
    };
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={title}
            description={hint}
            icon={icon}
            size="md"
            isLoading={saving}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="button" disabled={!valid || saving} onClick={() => submit()}>{t("common.save")}</Button>
                </>
            }
        >
            <form className="space-y-4" onSubmit={submit}>
                <Field label={t("access.groupName")} required>
                    <Input value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} placeholder={placeholder} />
                </Field>
                <Field label={t("access.groupDescription")} hint={t("access.groupDescriptionHint")}>
                    <Input value={description} maxLength={256} onChange={(e) => setDescription(e.target.value)} />
                </Field>
            </form>
        </Modal>
    );
}
