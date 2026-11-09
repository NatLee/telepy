"use client";

/**
 * 個人群組的清單與編輯（分享視窗的「群組」分頁和「群組」頁共用）：每個的人數與用在哪些通道，新增 / 編輯 / 刪除；
 * 改成員、刪除一個有分享的群組之前，先預覽誰會多了 / 少了哪些通道。`detailed` = 頁面版：列出成員名稱與通道。
 * Personal groups' list and editing (shared by the share dialog's Groups tab and the Groups page): members and the
 * tunnels using each, new / edit / delete; member changes and deletes of a shared group preview the impact first.
 * `detailed` = the page version: member names and tunnels spelled out.
 */
import React, { useState } from "react";
import Link from "next/link";
import { CirclePause, Pencil, Plus, Trash2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Section } from "@/components/ui/section";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { FoldedItems } from "@/components/groups/FoldedItems";
import { useImpactConfirm } from "@/components/groups/ImpactConfirm";
import { FoldedNames } from "@/components/groups/MemberNames";
import { PersonalGroupDialog, type PersonalGroupForm } from "@/components/groups/PersonalGroupDialog";
import type { usePersonalGroups } from "@/hooks/usePersonalGroups";
import { filterNamedGroups, type PersonalGroup } from "@/lib/peopleGroups";
import { memberDelta } from "@/lib/peopleMembers";
import { useI18n } from "@/lib/i18n";

type Personal = ReturnType<typeof usePersonalGroups>;

/** 新增 / 編輯 / 刪除的對話框與預覽確認。`dialogs` 要畫在頁面上。/ The new / edit / delete dialogs and the impact gate; render `dialogs`. */
export function usePersonalGroupEditor(personal: Personal) {
    const { t } = useI18n();
    const [editing, setEditing] = useState<PersonalGroup | "new" | null>(null);
    const gate = useImpactConfirm();

    const askDelete = (g: PersonalGroup) =>
        void gate.ask({
            preview: g.shares.length > 0 ? () => personal.preview(g.id, { delete: true }) : undefined,
            run: () => personal.remove(g.id),
            title: t("personalGroups.deleteTitle", { name: g.name }),
            confirmText: t("personalGroups.delete"),
            alwaysAsk: t("personalGroups.deleteMessage", { name: g.name, count: g.shares.length }),
            destructive: true,
        });

    const save = (form: PersonalGroupForm) => {
        if (editing === "new") {
            void personal.create(form).then((r) => {
                if (r !== null) setEditing(null);
            });
            return;
        }
        const g = editing;
        if (!g) return;
        // 名稱 / 說明用 PATCH，成員只送增減（不蓋掉別的視窗同時的修改）。/ Name / description by PATCH, members as a delta.
        const delta = memberDelta(g.members, form.members);
        const membersChanged = delta.add.length + delta.remove.length > 0;
        const metaChanged = form.name !== g.name || form.description !== g.description;
        void gate.ask({
            preview: g.shares.length > 0 && membersChanged ? () => personal.preview(g.id, { members: form.members }) : undefined,
            run: async () => {
                let ok = true;
                if (metaChanged) ok = (await personal.update(g.id, { name: form.name, description: form.description }, membersChanged)) !== null;
                if (ok && membersChanged) ok = (await personal.members(g.id, delta)) !== null;
                if (ok) setEditing(null);
            },
            title: t("personalGroups.confirmMembers", { name: g.name }),
            confirmText: t("common.save"),
        });
    };

    const dialogs = (
        <>
            {editing !== null && personal.list && (
                <PersonalGroupDialog
                    group={editing === "new" ? null : editing}
                    users={personal.list.users}
                    maxMembers={personal.list.max_members}
                    saving={personal.busy || gate.checking}
                    onClose={() => setEditing(null)}
                    onSave={save}
                />
            )}
            {gate.dialog}
        </>
    );

    return { openNew: () => setEditing("new"), openEdit: (g: PersonalGroup) => setEditing(g), askDelete, dialogs };
}

/** 「你建立的群組」：每個的人數與用在哪些通道，新增 / 編輯 / 刪除。/ "Groups you made": members, tunnels using them, new / edit / delete. */
export function PersonalGroupsSection({
    groups,
    limit,
    busy,
    canAdd = true,
    detailed = false,
    onNew,
    onEdit,
    onDelete,
}: {
    groups: PersonalGroup[];
    limit: number;
    busy: boolean;
    /** 能不能新增（要能管至少一條通道的分享）。/ Whether new groups can be made (needs a tunnel to manage). */
    canAdd?: boolean;
    detailed?: boolean;
    onNew: () => void;
    onEdit: (g: PersonalGroup) => void;
    onDelete: (g: PersonalGroup) => void;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = filterNamedGroups(groups, query);
    const pager = usePagination(shown.length, { storageKey: "telepy.personalGroupsPageSize", resetKey: query });
    const full = groups.length >= limit;
    return (
        <Section
            icon={<User />}
            title={t("personalGroups.yours")}
            description={t("personalGroups.yoursHint")}
            action={
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || full || !canAdd}
                    onClick={onNew}
                    title={full ? t("personalGroups.limit", { limit }) : !canAdd ? t("personalGroups.needTunnel") : undefined}
                >
                    <Plus size={14} /> {t("personalGroups.newShort")}
                </Button>
            }
        >
            {!canAdd && <Callout tone="info">{t("personalGroups.needTunnel")}</Callout>}
            {groups.length >= 7 && (
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("personalGroups.search")} aria-label={t("personalGroups.search")} className="h-8" />
            )}
            {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("personalGroups.none")}</p>
            ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("access.noMatch")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80" data-refresh-list>
                    {pageSlice(shown, pager.page, pager.size).map((g) => {
                        const paused = g.shares.filter((s) => !s.active).length;
                        return (
                            <li key={g.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5">
                                <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="min-w-0 truncate text-sm text-foreground" title={g.description || undefined}>{g.name}</span>
                                    </span>
                                    {detailed && g.description && <span className="text-xs leading-snug text-muted-foreground">{g.description}</span>}
                                    <span className="text-xs text-muted-foreground" title={detailed ? undefined : g.shares.map((s) => s.tunnel_name).join(", ") || undefined}>
                                        {t("access.memberCount", { count: g.members.length })} · {t("personalGroups.usedBy", { count: g.shares.length })}
                                        {paused > 0 && <span className="text-warning"> · {t("personalGroups.pausedCount", { count: paused })}</span>}
                                    </span>
                                    {detailed && <FoldedNames title={t("share.group.membersOf", { name: g.name })} names={g.member_names} />}
                                    {detailed && g.shares.length > 0 && (
                                        <FoldedItems
                                            label={t("personalGroups.sharedOn")}
                                            items={g.shares.map((s) => ({
                                                key: s.id,
                                                node:
                                                    s.active && !s.hidden ? (
                                                        <Link href={`/tunnels/${s.tunnel_id}?tab=access`} prefetch={false} className="text-foreground underline-offset-2 hover:underline">
                                                            {s.tunnel_name}
                                                        </Link>
                                                    ) : (
                                                        <span className="inline-flex items-center gap-1 text-warning" title={t("personalGroups.pausedHint")}>
                                                            <CirclePause size={12} aria-hidden />
                                                            {s.hidden ? t("personalGroups.hiddenTunnel") : s.tunnel_name}
                                                        </span>
                                                    ),
                                            }))}
                                        />
                                    )}
                                </span>
                                <span className="flex gap-1">
                                    <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={() => onEdit(g)} aria-label={t("personalGroups.edit")} title={t("personalGroups.edit")}>
                                        <Pencil />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon-sm" disabled={busy} className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(g)} aria-label={t("personalGroups.delete")} title={t("personalGroups.delete")}>
                                        <Trash2 />
                                    </Button>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
            <Pagination pager={pager} compact className="justify-center" />
            {!detailed && (
                <Link href="/tunnels/groups" prefetch={false} className="inline-flex text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    {t("personalGroups.openPage")}
                </Link>
            )}
        </Section>
    );
}
