"use client";

/**
 * 管理區「角色」與「群組」兩頁共用的積木：清單（一行一個；搜尋、排序、分頁、新增）、成員編輯（按儲存才送出增減）、名稱 / 說明的對話框，
 * 以及每頁最上面那一行「角色決定功能、群組決定分享」的說明（連到另一頁）。
 * Blocks shared by the admin Roles and Groups pages: the list (one line each; search, sort, pages, new), the members
 * editor (the delta sent on Save), the name / description dialog, and the one-line "roles decide features, groups decide sharing" note at the
 * top of each page (linking to the other one).
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Search, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination } from "@/components/ui/pagination";
import { PeopleMembers } from "@/components/groups/PeopleMembers";
import { usePagination, type PaginationState } from "@/hooks/usePagination";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { pageSlice } from "@/lib/pagination";
import type { AccessUser } from "@/lib/features";
import { nameProblem } from "@/lib/peopleGroups";
import { GROUP_SORTS, applyDelta, memberDelta, pinnedItem, sortGroups, type GroupSort } from "@/lib/peopleMembers";
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

/** 清單上方的排序與每頁筆數（小的那種）。/ The small sort + page size row above a list. */
export function ListControls({
    sort,
    onSort,
    pager,
    sortLabel,
}: {
    sort?: GroupSort;
    onSort?: (s: GroupSort) => void;
    pager: PaginationState;
    sortLabel?: string;
}) {
    const { t } = useI18n();
    const showSize = pager.total > pager.sizes[0];
    if (!onSort && !showSize) return null;
    return (
        <div className="flex gap-2 px-1">
            {onSort && sort && (
                <NativeSelect className="h-7 min-w-0 flex-1 text-xs" aria-label={sortLabel ?? t("members.sortAria")} value={sort} onChange={(e) => onSort(e.target.value as GroupSort)}>
                    {GROUP_SORTS.map((s) => (
                        <option key={s} value={s}>{t(s === "name" ? "members.sortName" : "members.sortMembers")}</option>
                    ))}
                </NativeSelect>
            )}
            {showSize && (
                <NativeSelect className="h-7 w-28 shrink-0 text-xs" aria-label={t("ui.page.size")} value={pager.size} onChange={(e) => pager.setSize(Number(e.target.value))}>
                    {pager.sizes.map((n) => (
                        <option key={n} value={n}>{t("ui.page.sizeOption", { size: n })}</option>
                    ))}
                </NativeSelect>
            )}
        </div>
    );
}

/** 一行一個：圖示、名稱、右邊安靜的數字。/ One line each: icon, name, quiet counts on the right. */
export function CompactRow({
    active,
    icon,
    label,
    counts,
    badge,
    onClick,
    pinned = false,
    title,
}: {
    active: boolean;
    icon: React.ReactNode;
    label: React.ReactNode;
    counts?: React.ReactNode;
    badge?: React.ReactNode;
    onClick: () => void;
    /** 選中但在別頁，釘在最上面。/ Selected but on another page, pinned on top. */
    pinned?: boolean;
    title?: string;
}) {
    const { t } = useI18n();
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "true" : undefined}
            title={title}
            className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                active ? "bg-muted text-foreground [&>svg]:text-primary" : "text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
        >
            {icon}
            <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
            {pinned && <span className="shrink-0 text-xs text-muted-foreground">{t("members.otherPage")}</span>}
            {counts && <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">{counts}</span>}
            {badge}
        </button>
    );
}

/** 一個數字加小圖示（清單右邊的）。/ A small icon + number (the list's right side). */
export function CountText({ icon: Icon, count, label }: { icon: LucideIcon; count: number; label: string }) {
    return (
        <span className="inline-flex items-center gap-0.5" title={label} aria-label={label}>
            <Icon size={12} aria-hidden />
            <span aria-hidden>{count}</span>
        </span>
    );
}

/** 左邊的清單（搜尋從 7 個起、排序、分頁；選中的在別頁就釘在最上面）。/ The list on the left (search from 7, sort, pages; the selection pinned when on another page). */
export function AdminGroupList<T extends { id: number; name: string; members: number[] }>({
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
    counts,
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
    /** 每頁筆數（排序記在 `<storageKey>.sort`）。/ The page size key (the sort goes to `<storageKey>.sort`). */
    storageKey: string;
    icon: LucideIcon;
    counts: (item: T) => React.ReactNode;
    badge?: (item: T) => React.ReactNode;
    ariaLabel: string;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const [sort, setSort] = useStoredChoice<GroupSort>(`${storageKey}.sort`, GROUP_SORTS, "name");
    const shown = sortGroups(filter(items, query), sort);
    const pager = usePagination(shown.length, { storageKey, resetKey: `${query}|${sort}` });
    const slice = pageSlice(shown, pager.page, pager.size);
    const pinned = pinnedItem(shown, slice, current);
    const row = (g: T, isPinned = false) => (
        <CompactRow
            key={`${isPinned ? "pin-" : ""}${g.id}`}
            active={g.id === current}
            pinned={isPinned}
            icon={<Icon size={15} className="shrink-0" />}
            label={g.name}
            counts={counts(g)}
            badge={badge?.(g)}
            onClick={() => onPick(g.id)}
        />
    );
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
            {items.length >= 2 && <ListControls sort={sort} onSort={setSort} pager={pager} />}
            {items.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{emptyText}</p>}
            {items.length > 0 && shown.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noMatch")}</p>}
            <div className="space-y-0.5">
                {pinned && (
                    <div className="border-b border-border/70 pb-0.5">{row(pinned, true)}</div>
                )}
                {slice.map((g) => row(g))}
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

/** 成員：先在這裡改、按儲存才送出增減（不蓋掉別人同時的修改）。單一登入給的成員有建築物圖示。
 *  Members: edited here, the delta sent on Save (never overwriting a concurrent edit); SSO members are marked. */
export function MembersEditor({
    users,
    members,
    ssoMembers,
    saving,
    storageKey,
    hint,
    onSave,
}: {
    users: AccessUser[];
    members: number[];
    ssoMembers: { user_id: number; provider: string }[] | undefined;
    saving: boolean;
    storageKey: string;
    hint?: string;
    /** 送出增減；`next` = 套上之後的整份（預覽用）。/ Send the delta; `next` = the whole list after it (for previews). */
    onSave: (delta: { add: number[]; remove: number[] }, next: number[]) => Promise<unknown>;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<number[]>(members);
    const [base, setBase] = useState(members);
    if (base !== members) {
        setBase(members);
        setDraft(members);
    }
    const sso = useMemo(() => new Map((ssoMembers ?? []).map((m) => [m.user_id, m.provider] as const)), [ssoMembers]);
    const delta = memberDelta(members, draft);
    const changed = delta.add.length + delta.remove.length;
    return (
        <div className="space-y-2">
            <PeopleMembers
                people={users}
                base={members}
                value={draft}
                onChange={setDraft}
                storageKey={storageKey}
                hint={hint}
                disabled={saving}
                marks={(id) =>
                    sso.has(id) ? <Building2 size={14} className="shrink-0 text-muted-foreground" aria-label={t("access.viaSso", { provider: sso.get(id) ?? "" })} /> : null
                }
            />
            {changed > 0 && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 shadow-pop ring-1 ring-border">
                    <span className="text-sm text-foreground">{t("access.membersChanged", { added: delta.add.length, removed: delta.remove.length })}</span>
                    <span className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setDraft(members)}>{t("access.membersDiscard")}</Button>
                        <Button type="button" size="sm" disabled={saving} onClick={() => void onSave(delta, applyDelta(members, delta))}>{t("access.membersSave")}</Button>
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
