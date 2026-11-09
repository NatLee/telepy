"use client";

/**
 * 「群組」頁：上面是「你建立的群組」（跟分享視窗同一套清單與編輯），下面是「你所在的群組」—— 每個只標出成員是誰在
 * 維護（做群組的人可以退出；管理員維護或公司帳號同步的唯讀）。「管理員維護的群組 / 個人群組」的分法只留在管理區；角色從不出現在這裡。
 * 資訊鈕 = 群組分享的說明圖。有人退出我的群組、通道分享變了就重抓。
 * The Groups page: "Groups you made" on top (the same list and editing as the share dialog), then "Groups you're in"
 * — each labelled only by who keeps its members (a group someone made can be left; ones admins keep or synced from
 * company accounts are read-only). The admin-kept / personal split stays in the admin area; roles never appear here. The info button
 * opens the group sharing diagram. Refetches when someone leaves my group or a tunnel share changes.
 */
import React, { useCallback, useState } from "react";
import Link from "next/link";
import { CircleHelp, UsersRound } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Section, SectionPanels } from "@/components/ui/section";
import { FoldedItems } from "@/components/groups/FoldedItems";
import { GroupKeeper } from "@/components/groups/GroupKeeper";
import { LeaveGroupButton } from "@/components/groups/LeaveGroupButton";
import { PersonalGroupsSection, usePersonalGroupEditor } from "@/components/groups/PersonalGroupsManager";
import { GroupShareInfoDialog } from "@/components/tunnels/ShareModalGroups";
import { usePagination } from "@/hooks/usePagination";
import { usePersonalGroups } from "@/hooks/usePersonalGroups";
import { hasFeature } from "@/lib/features";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { pageSlice } from "@/lib/pagination";
import { filterMemberOf, type MemberOfGroup } from "@/lib/peopleGroups";

export function GroupsPageView() {
    const { t } = useI18n();
    const user = useAuth().user;
    const personal = usePersonalGroups(true);
    const editor = usePersonalGroupEditor(personal);
    const [info, setInfo] = useState(false);
    const reload = personal.reload;
    const refetch = useCallback(() => void reload(), [reload]);
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.PERSONAL_GROUP_LEFT]: refetch,
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: refetch,
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: refetch,
        [NOTIFICATION_ACTIONS.TUNNEL_PERMISSION_UPDATED]: refetch,
    });
    const list = personal.list;
    // 建立 / 修改要「分享通道」功能，而且要能管至少一條通道（後端的 can_share 兩者都看）。/ Making groups needs both.
    const canAdd = hasFeature(user, "tunnels.share") && (list?.can_share ?? false);

    return (
        <div className="space-y-6">
            <PageHeader
                icon={<UsersRound />}
                title={t("peopleGroups.title")}
                description={t("peopleGroups.description")}
                actions={
                    <Button type="button" variant="outline" onClick={() => setInfo(true)}>
                        <CircleHelp size={15} /> {t("share.group.how")}
                    </Button>
                }
            />
            {!list ? (
                <div className="flex justify-center py-12 text-muted-foreground">
                    <div className="mr-3 size-6 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden />
                    {t("common.loading")}
                </div>
            ) : (
                <SectionPanels>
                    <PersonalGroupsSection
                        groups={list.groups}
                        limit={list.limit}
                        busy={personal.busy}
                        canAdd={canAdd}
                        detailed
                        onNew={editor.openNew}
                        onEdit={editor.openEdit}
                        onDelete={editor.askDelete}
                    />
                    <MemberOfSection groups={list.member_of} onLeft={refetch} />
                </SectionPanels>
            )}
            {editor.dialogs}
            <GroupShareInfoDialog isOpen={info} onClose={() => setInfo(false)} share={null} />
        </div>
    );
}

/** 我所在的群組：誰維護成員、說明、分享給它的通道（經由它拿到的標出來）；別人做的群組可以退出。7 個起有搜尋，分頁。
 *  The groups I'm in: who keeps the members, description, the tunnels shared with it (the ones held through it
 *  marked); a group someone made can be left. A search from 7 groups, then pages. */
function MemberOfSection({ groups, onLeft }: { groups: MemberOfGroup[]; onLeft: () => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = filterMemberOf(groups, query);
    const pager = usePagination(shown.length, { storageKey: "telepy.memberOfGroupsPageSize", resetKey: query });
    return (
        <Section icon={<UsersRound />} title={t("peopleGroups.memberOf")} description={t("peopleGroups.memberOfHint")}>
            {groups.length >= 7 && (
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.searchGroups")} aria-label={t("groups.searchGroups")} className="h-8" />
            )}
            {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("peopleGroups.memberOfNone")}</p>
            ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("groups.noMatch")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80" data-refresh-list>
                    {pageSlice(shown, pager.page, pager.size).map((g) => (
                        <li key={g.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-2.5">
                            <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span className="min-w-0 truncate text-sm text-foreground">{g.name}</span>
                                    <GroupKeeper group={g} />
                                </span>
                                {g.description && <span className="text-xs leading-snug text-muted-foreground">{g.description}</span>}
                                {g.tunnels.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">{t("peopleGroups.noTunnels")}</span>
                                ) : (
                                    <FoldedItems
                                        label={t("personalGroups.sharedOn")}
                                        items={g.tunnels.map((tn) => ({
                                            key: tn.id,
                                            node: (
                                                <Link
                                                    href={`/tunnels/${tn.id}?tab=access`}
                                                    prefetch={false}
                                                    className="text-foreground underline-offset-2 hover:underline"
                                                    title={tn.through ? t("peopleGroups.through") : t("peopleGroups.otherWay")}
                                                >
                                                    {tn.name}
                                                    {!tn.through && <span className="text-muted-foreground"> ({t("peopleGroups.otherWayShort")})</span>}
                                                </Link>
                                            ),
                                        }))}
                                    />
                                )}
                            </span>
                            {g.kind === "personal" && <LeaveGroupButton groupId={g.id} name={g.name} owner={g.owner ?? "?"} onLeft={onLeft} />}
                        </li>
                    ))}
                </ul>
            )}
            <Pagination pager={pager} compact className="justify-center" />
        </Section>
    );
}
