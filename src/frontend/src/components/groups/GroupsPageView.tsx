"use client";

/**
 * 「群組」頁：上面是自己的個人群組（跟分享視窗同一套清單與編輯），下面是自己所在的群組 —— 別人的個人群組（可以
 * 退出）與開放分享的組織群組（唯讀，管理員管）。只為功能規則存在的組織群組不列（後端就不給）。資訊鈕 = 群組分享的
 * 說明圖。有人退出我的群組、通道分享變了就重抓。
 * The Groups page: your personal groups on top (the same list and editing as the share dialog), then the groups you
 * are in — someone's personal group (you may leave it) and organization groups open to sharing (read-only, admins
 * keep them). Organization groups kept only for feature rules are left out (the backend never sends them). The info
 * button opens the group sharing diagram. Refetches when someone leaves my group or a tunnel share changes.
 */
import React, { useCallback, useState } from "react";
import Link from "next/link";
import { Building2, CircleHelp, User, UsersRound } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Chip, Section, SectionPanels } from "@/components/ui/section";
import { LeaveGroupButton } from "@/components/groups/LeaveGroupButton";
import { PersonalGroupsSection, usePersonalGroupEditor } from "@/components/groups/PersonalGroupsManager";
import { GroupShareInfoDialog } from "@/components/tunnels/ShareModalGroups";
import { usePersonalGroups } from "@/hooks/usePersonalGroups";
import { hasFeature } from "@/lib/features";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import type { MemberOfGroup } from "@/lib/peopleGroups";

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

/** 我所在的群組：每個的種類、說明、分享給它的通道（經由它拿到的標出來），個人群組可以退出。/ The groups I'm in. */
function MemberOfSection({ groups, onLeft }: { groups: MemberOfGroup[]; onLeft: () => void }) {
    const { t } = useI18n();
    return (
        <Section icon={<UsersRound />} title={t("peopleGroups.memberOf")} description={t("peopleGroups.memberOfHint")}>
            {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("peopleGroups.memberOfNone")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80" data-refresh-list>
                    {groups.map((g) => (
                        <li key={g.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-2.5">
                            <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                    <span className="min-w-0 truncate text-sm text-foreground">{g.name}</span>
                                    {g.kind === "personal" ? (
                                        <Chip>
                                            <User aria-hidden />
                                            {t("share.group.personalOf", { owner: g.owner ?? "?" })}
                                        </Chip>
                                    ) : (
                                        <Chip>
                                            <Building2 aria-hidden />
                                            {t("share.group.kindOrg")}
                                        </Chip>
                                    )}
                                </span>
                                {g.description && <span className="text-xs leading-snug text-muted-foreground">{g.description}</span>}
                                {g.tunnels.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">{t("peopleGroups.noTunnels")}</span>
                                ) : (
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                        <span className="text-muted-foreground">{t("personalGroups.sharedOn")}</span>
                                        {g.tunnels.map((tn) => (
                                            <Link
                                                key={tn.id}
                                                href={`/tunnels/${tn.id}?tab=access`}
                                                prefetch={false}
                                                className="text-foreground underline-offset-2 hover:underline"
                                                title={tn.through ? t("peopleGroups.through") : t("peopleGroups.otherWay")}
                                            >
                                                {tn.name}
                                                {!tn.through && <span className="text-muted-foreground"> ({t("peopleGroups.otherWayShort")})</span>}
                                            </Link>
                                        ))}
                                    </span>
                                )}
                            </span>
                            {g.kind === "personal" ? (
                                <LeaveGroupButton groupId={g.id} name={g.name} owner={g.owner ?? "?"} onLeft={onLeft} />
                            ) : (
                                <span className="text-xs text-muted-foreground">{t("peopleGroups.orgManaged")}</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">{t("peopleGroups.orgHiddenNote")}</p>
        </Section>
    );
}
