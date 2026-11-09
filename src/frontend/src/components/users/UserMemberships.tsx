"use client";

/**
 * 使用者頁與「管理」視窗裡跟角色 / 群組有關的積木：可搜尋的選擇清單（篩選浮層、批次對話框共用）、角色 / 群組篩選、
 * 每個人「N 個角色 · N 個群組」（點開列名字）、批次加入 / 移除（群組先預覽誰會多 / 少哪些通道），以及「管理」視窗的
 * 「角色與群組」分頁。寫入都走增減路由，兩個管理員同時改也不會互相蓋掉。資料來自 `GET /api/access`。
 * Role / group pieces of the Users page and the Manage dialog: a searchable pick list (shared by the filter popover
 * and the bulk dialog), the role / group filters, each person's "N roles · N groups" (a click lists them), bulk add /
 * remove (groups preview who gains / loses which tunnels first), and the Manage dialog's "Roles & groups" tab. Every
 * write uses the delta routes, so two admins editing at once never overwrite each other. Data from `GET /api/access`.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Check, ChevronDown, Search, Server, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Section } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { useImpactConfirm } from "@/components/groups/ImpactConfirm";
import { TypeAhead } from "@/components/groups/PeopleMembers";
import type { useAccessPage, MembersDelta } from "@/hooks/useAccessPage";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { parseShareGroups } from "@/lib/peopleGroups";
import { applyDelta, bulkTouches, sortGroups, type MemberFilter } from "@/lib/peopleMembers";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Access = ReturnType<typeof useAccessPage>;
export type MembershipKind = "role" | "group";

/** 一個可以選的角色或群組。/ A role or group to pick. */
export interface ChoiceItem {
    id: number;
    name: string;
    description: string;
    members: number[];
    /** 群組：分享給它的通道數與名稱。/ Groups: the tunnels shared with it. */
    tunnels?: number;
    tunnelNames?: string[];
}

/** 政策 → 角色與群組（排好序，群組只解析一次）。/ The policy → roles and groups (sorted; groups parsed once). */
export function useChoices(access: Access): { roles: ChoiceItem[]; groups: ChoiceItem[] } {
    const policy = access.policy;
    return useMemo(() => {
        if (!policy) return { roles: [], groups: [] };
        return {
            roles: sortGroups(policy.groups, "name").map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.members })),
            groups: parseShareGroups(policy).map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.members, tunnels: g.shares.length, tunnelNames: g.shares.map((x) => x.tunnel_name) })),
        };
    }, [policy]);
}

const KIND_ICON = { role: BadgeCheck, group: Users } as const;

/** 名稱、說明（群組也找分享給它的通道），每個字都要有。/ Name and description (groups also shared tunnels); every word. */
function searchChoices<T extends ChoiceItem>(items: T[], query: string): T[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return items;
    return items.filter((g) => {
        const hay = [g.name, g.description, ...(g.tunnelNames ?? [])].join("\n").toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/** 可搜尋、分頁的選擇清單；`lead` = 清單前面固定的選項（任何 / 沒有）。/ A searchable, paged pick list; `lead` = fixed options before it. */
function ChoiceList({
    kind,
    items,
    value,
    onPick,
    lead,
    storageKey,
    note,
}: {
    kind: MembershipKind;
    items: ChoiceItem[];
    value: MemberFilter | null;
    onPick: (v: MemberFilter) => void;
    lead?: { value: MemberFilter; label: string }[];
    storageKey: string;
    /** 一列後面的說明（批次：幾個人會改）。/ A note after a row (bulk: how many people change). */
    note?: (item: ChoiceItem) => React.ReactNode;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = searchChoices(items, query);
    const pager = usePagination(shown.length, { storageKey, resetKey: query });
    const Icon = KIND_ICON[kind];
    const label = t(kind === "role" ? "roles.search" : "adminGroups.search");
    const option = (key: string, v: MemberFilter, content: React.ReactNode, extra?: React.ReactNode) => (
        <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onPick(v)}
            className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                value === v ? "bg-muted text-foreground" : "text-foreground hover:bg-surface",
            )}
        >
            <span className="grid size-4 shrink-0 place-items-center text-primary" aria-hidden>{value === v && <Check size={14} />}</span>
            {content}
            {extra && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{extra}</span>}
        </button>
    );
    return (
        <div className="space-y-2">
            {items.length >= 7 && (
                <div className="relative">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input type="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder={label} aria-label={label} className="h-8 pl-8" />
                </div>
            )}
            <div role="radiogroup" aria-label={label} className="space-y-0.5">
                {lead?.map((l) => option(`lead-${l.value}`, l.value, <span className="min-w-0 truncate">{l.label}</span>))}
                {items.length === 0 && <p className="px-2.5 py-1 text-sm text-muted-foreground">{t(kind === "role" ? "roles.none" : "adminGroups.none")}</p>}
                {items.length > 0 && shown.length === 0 && <p className="px-2.5 py-1 text-sm text-muted-foreground">{t("access.noMatch")}</p>}
                {pageSlice(shown, pager.page, pager.size).map((g) =>
                    option(
                        String(g.id),
                        g.id,
                        <>
                            <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0 truncate">{g.name}</span>
                        </>,
                        note ? note(g) : t("access.memberCount", { count: g.members.length }),
                    ),
                )}
            </div>
            <Pagination pager={pager} compact className="justify-center" />
        </div>
    );
}

/** 使用者頁的角色 / 群組篩選（按鈕 + 可搜尋的浮層）。/ The Users page's role / group filter (a button + a searchable popover). */
export function MembershipFilter({ kind, items, value, onChange }: { kind: MembershipKind; items: ChoiceItem[]; value: MemberFilter; onChange: (v: MemberFilter) => void }) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const Icon = KIND_ICON[kind];
    const picked = typeof value === "number" ? items.find((g) => g.id === value)?.name : null;
    const current =
        value === "any" ? t(kind === "role" ? "members.filterAnyRole" : "members.filterAnyGroup") : value === "none" ? t(kind === "role" ? "members.filterNoRole" : "members.filterNoGroup") : picked ?? "?";
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className={cn("h-8 min-w-0 max-w-full justify-start", value !== "any" && "border-primary/60")}>
                    <Icon size={14} className="shrink-0" />
                    <span className="min-w-0 truncate">{current}</span>
                    <ChevronDown size={14} className="ml-auto shrink-0 opacity-60" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] overflow-auto p-2">
                <ChoiceList
                    kind={kind}
                    items={items}
                    value={value}
                    storageKey={`telepy.usersFilter${kind === "role" ? "Roles" : "Groups"}PageSize`}
                    lead={[
                        { value: "any", label: t(kind === "role" ? "members.filterAnyRole" : "members.filterAnyGroup") },
                        { value: "none", label: t(kind === "role" ? "members.filterNoRole" : "members.filterNoGroup") },
                    ]}
                    onPick={(v) => {
                        onChange(v);
                        setOpen(false);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

/** 「2 個角色 · 1 個群組」，點開列出名字。/ "2 roles · 1 group"; a click lists them. */
export function MembershipCounts({ roles, groups }: { roles: string[]; groups: string[] }) {
    const { t } = useI18n();
    if (roles.length + groups.length === 0) return <span className="text-xs text-muted-foreground">{t("members.noMemberships")}</span>;
    const text = [roles.length > 0 && t("members.roleCount", { count: roles.length }), groups.length > 0 && t("members.groupCount", { count: groups.length })].filter(Boolean).join(" · ");
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {text}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 space-y-3 overflow-auto p-3 text-sm">
                {roles.length > 0 && <NameList icon={BadgeCheck} title={t("roles.title")} names={roles} />}
                {groups.length > 0 && <NameList icon={Users} title={t("adminGroups.title")} names={groups} />}
            </PopoverContent>
        </Popover>
    );
}

function NameList({ icon: Icon, title, names }: { icon: typeof Users; title: string; names: string[] }) {
    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{title} · {names.length}</p>
            <ul className="space-y-0.5">
                {names.map((n) => (
                    <li key={n} className="flex min-w-0 items-center gap-1.5 text-foreground">
                        <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 truncate">{n}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/* ── 寫入：一個人或一批人 / Writes: one person or a batch ───────── */

/**
 * 把一群人加進 / 移出一個角色或群組：只送真的會改的人；群組有分享時先預覽。回傳 `run` 與要畫的 `dialog`。
 * Adds / removes people to / from a role or group: only those who really change are sent; a group with shares is
 * previewed first. Returns `run` and the `dialog` to render.
 */
export function useMembershipWrite(access: Access) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const gate = useImpactConfirm();
    const run = async (kind: MembershipKind, op: "add" | "remove", target: ChoiceItem, userIds: number[]): Promise<boolean> => {
        const touched = bulkTouches(target.members, userIds, op);
        if (touched.length === 0) {
            showError(t(op === "add" ? "members.bulkNothingAdd" : "members.bulkNothingRemove", { name: target.name }));
            return false;
        }
        const delta: MembersDelta = op === "add" ? { add: touched } : { remove: touched };
        const done = t(op === "add" ? "members.bulkAdded" : "members.bulkRemoved", { count: touched.length, name: target.name });
        if (kind === "role") {
            const ok = (await access.roleMembers(target.id, delta)) !== null;
            if (ok) showSuccess(done);
            return ok;
        }
        let ok = false;
        await gate.ask({
            preview: (target.tunnels ?? 0) > 0 ? () => access.previewShareGroup(target.id, { members: applyDelta(target.members, delta) }) : undefined,
            run: async () => {
                ok = (await access.shareGroupMembers(target.id, delta)) !== null;
                if (ok) showSuccess(done);
            },
            title: t("adminGroups.confirmMembers", { name: target.name }),
            confirmText: t("access.membersSave"),
        });
        return ok;
    };
    return { run, checking: gate.checking, dialog: gate.dialog };
}

/** 批次：選一個角色 / 群組，把勾選的人加進去或移出來。/ Bulk: pick a role / group and add / remove the ticked people. */
export function BulkPickDialog({
    kind,
    op,
    items,
    selected,
    busy,
    onClose,
    onRun,
}: {
    kind: MembershipKind;
    op: "add" | "remove";
    items: ChoiceItem[];
    selected: number[];
    busy: boolean;
    onClose: () => void;
    onRun: (target: ChoiceItem) => void;
}) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<number | null>(null);
    const target = items.find((g) => g.id === picked) ?? null;
    const touched = target ? bulkTouches(target.members, selected, op).length : 0;
    const Icon = KIND_ICON[kind];
    const titleKey =
        kind === "role" ? (op === "add" ? "members.bulkAddRole" : "members.bulkRemoveRole") : op === "add" ? "members.bulkAddGroup" : "members.bulkRemoveGroup";
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t(titleKey)}
            description={t("members.bulkSelected", { count: selected.length })}
            icon={<Icon />}
            size="md"
            isLoading={busy}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="button" variant={op === "remove" ? "destructive" : "default"} disabled={!target || touched === 0 || busy} onClick={() => target && onRun(target)}>
                        {target ? t(op === "add" ? "members.bulkAddTo" : "members.bulkRemoveFrom", { count: touched, name: target.name }) : t(titleKey)}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                {kind === "group" && <p className="text-xs leading-relaxed text-muted-foreground">{t("members.bulkGroupNote")}</p>}
                <ChoiceList
                    kind={kind}
                    items={items}
                    value={picked}
                    onPick={(v) => typeof v === "number" && setPicked(v)}
                    storageKey={`telepy.bulk${kind === "role" ? "Roles" : "Groups"}PageSize`}
                    note={(g) => {
                        const n = bulkTouches(g.members, selected, op).length;
                        return n === 0 ? t(op === "add" ? "members.bulkAllIn" : "members.bulkNoneIn") : t(op === "add" ? "members.bulkWouldAdd" : "members.bulkWouldRemove", { count: n });
                    }}
                />
            </div>
        </Modal>
    );
}

/* ── 「管理」視窗的「角色與群組」分頁 / The Manage dialog's tab ─────── */

export function MembershipTab({ access, userId, isSuperuser, onNavigate }: { access: Access; userId: number; isSuperuser: boolean; onNavigate: () => void }) {
    const { t } = useI18n();
    const { roles, groups } = useChoices(access);
    const write = useMembershipWrite(access);
    if (!access.policy) {
        return access.loading ? <p className="text-sm text-muted-foreground">{t("access.loading")}</p> : <Callout tone="danger">{t("access.loadFailed")}</Callout>;
    }
    const busy = access.saving || write.checking;
    return (
        <div className="space-y-6">
            <MembershipSection
                kind="role"
                items={roles}
                userId={userId}
                busy={busy}
                note={isSuperuser ? t("members.rolesAdminNote") : t("members.rolesHint")}
                href={(id) => `/tunnels/admin/roles?role=${id}`}
                onNavigate={onNavigate}
                onChange={(op, g) => void write.run("role", op, g, [userId])}
            />
            <MembershipSection
                kind="group"
                items={groups}
                userId={userId}
                busy={busy}
                note={t("members.groupsHint")}
                href={(id) => `/tunnels/admin/groups?group=${id}`}
                onNavigate={onNavigate}
                onChange={(op, g) => void write.run("group", op, g, [userId])}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">{t("members.personalPrivate")}</p>
            {write.dialog}
        </div>
    );
}

function MembershipSection({
    kind,
    items,
    userId,
    busy,
    note,
    href,
    onNavigate,
    onChange,
}: {
    kind: MembershipKind;
    items: ChoiceItem[];
    userId: number;
    busy: boolean;
    note: string;
    href: (id: number) => string;
    onNavigate: () => void;
    onChange: (op: "add" | "remove", target: ChoiceItem) => void;
}) {
    const { t } = useI18n();
    const mine = items.filter((g) => g.members.includes(userId));
    const others = items.filter((g) => !g.members.includes(userId));
    const pager = usePagination(mine.length, { storageKey: `telepy.userMemberships${kind}PageSize` });
    const Icon = KIND_ICON[kind];
    return (
        <Section icon={<Icon />} title={`${t(kind === "role" ? "roles.title" : "adminGroups.title")} · ${mine.length}`} description={note}>
            {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(kind === "role" ? "members.inNoRole" : "members.inNoGroup")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-md ring-1 ring-inset ring-border/80">
                    {pageSlice(mine, pager.page, pager.size).map((g) => (
                        <li key={g.id} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                            <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                            <Link href={href(g.id)} prefetch={false} onClick={onNavigate} className="min-w-0 flex-1 truncate text-foreground underline-offset-2 hover:underline">
                                {g.name}
                            </Link>
                            {kind === "group" && (g.tunnels ?? 0) > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={t("adminGroups.tunnelCount", { count: g.tunnels ?? 0 })}>
                                    <Server size={12} aria-hidden />
                                    {g.tunnels}
                                </span>
                            )}
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={busy}
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => onChange("remove", g)}
                                aria-label={t("members.leave", { name: g.name })}
                                title={t("members.leave", { name: g.name })}
                            >
                                <X />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <Pagination pager={pager} compact className="justify-center" />
            <TypeAhead
                showOnFocus
                disabled={busy || others.length === 0}
                icon={<Icon />}
                placeholder={t(kind === "role" ? "members.addToRole" : "members.addToGroup")}
                emptyText={t("access.noMatch")}
                onPick={(id) => {
                    const g = others.find((x) => x.id === id);
                    if (g) onChange("add", g);
                }}
                search={(q) =>
                    searchChoices(others, q)
                        .slice(0, 8)
                        .map((g) => ({ id: g.id, label: g.name, sub: t("access.memberCount", { count: g.members.length }), icon: <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden /> }))
                }
            />
        </Section>
    );
}
