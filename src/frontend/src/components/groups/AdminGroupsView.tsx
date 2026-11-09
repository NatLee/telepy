"use client";

/**
 * 管理區「群組」頁：管理員維護成員的群組（也可以由 SCIM 推送或單一登入規則放人），只用來分享通道——通道擁有者在
 * 分享視窗看得到它們，分享後每位成員都拿到那條通道。群組從不決定功能（那是「角色」頁的事）。左邊是群組清單
 * （搜尋 + 分頁 + 新增），右邊是選中的群組（`?group=<id>`）：名稱與說明、成員、分享給它的通道。改成員或刪除前先
 * 預覽誰會多 / 少哪些通道（useImpactConfirm）。資料來自 `GET /api/access` 的 `share_groups`。
 * The admin Groups page: groups whose members admins keep (or SCIM pushes / SSO rules fill), used only for sharing
 * tunnels — tunnel owners see them in share dialogs, and every member gets a tunnel shared with one. Groups never
 * decide features (the Roles page does). Left: the list (search, pages, new). Right: the picked group
 * (`?group=<id>`): name and description, members, and the tunnels shared with it. Saving members or deleting
 * previews who gains / loses which tunnels first. Data from `GET /api/access`'s `share_groups`.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2, Info, Pencil, Server, Share2, Trash2, Users, UsersRound } from "lucide-react";
import { AdminChip } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Pagination } from "@/components/ui/pagination";
import { Chip, Section, SectionPanels } from "@/components/ui/section";
import { AdminGroupList, EmptyGroups, GroupNameDialog, MembersEditor, PolicyState, RolesVsGroups } from "@/components/groups/AdminGroupBits";
import { AdminGroupsInfoDialog } from "@/components/groups/RolesGroupsInfoDialog";
import { useImpactConfirm } from "@/components/groups/ImpactConfirm";
import { useAccessPage } from "@/hooks/useAccessPage";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import type { AccessPolicy } from "@/lib/features";
import { filterAdminGroups, parseShareGroups, type AdminGroup, type AdminGroupShare } from "@/lib/peopleGroups";
import { tunnelPageUrl } from "@/lib/tunnelPage";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const PERM_KEY: Record<string, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

export function AdminGroupsView({ initialGroup, startNew }: { initialGroup: number | null; startNew: boolean }) {
    const { t } = useI18n();
    const page = useAccessPage();
    const router = useRouter();
    const pathname = usePathname();
    const [picked, setPicked] = useState<number | null>(initialGroup);
    const [creating, setCreating] = useState(startNew);
    const [info, setInfo] = useState(false);
    const policy = page.policy;
    // 一份政策只解析一次：成員編輯器靠陣列身分判斷「伺服器換了」。/ Parse once per policy: the members editor keys off array identity.
    const groups = useMemo(() => (policy ? parseShareGroups(policy) : []), [policy]);

    const pick = (id: number | null) => {
        setPicked(id);
        router.replace(id ? `${pathname}?group=${id}` : pathname, { scroll: false });
    };

    const header = (
        <PageHeader
            icon={<UsersRound />}
            title={t("adminGroups.title")}
            titleAddon={<AdminChip />}
            description={t("adminGroups.description")}
            actions={
                <Button variant="outline" onClick={() => setInfo(true)}>
                    <Info size={16} /> {t("access.howItWorks")}
                </Button>
            }
        />
    );

    if (!policy) return <PolicyState header={header} loading={page.loading} />;

    // 選的群組不見了就選第一個。/ The picked group is gone: fall back to the first.
    const group = groups.find((g) => g.id === picked) ?? groups[0] ?? null;

    return (
        <div className="space-y-6">
            {header}
            <RolesVsGroups page="groups" />
            <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <AdminGroupList
                    items={groups}
                    filter={filterAdminGroups}
                    current={group?.id ?? null}
                    onPick={pick}
                    onCreate={() => setCreating(true)}
                    title={t("adminGroups.title")}
                    searchLabel={t("adminGroups.search")}
                    emptyText={t("adminGroups.none")}
                    storageKey="telepy.adminGroupsPageSize"
                    icon={Users}
                    ariaLabel={t("adminGroups.title")}
                    sub={(g) => (
                        <>
                            {t("access.memberCount", { count: g.members.length })}
                            {g.shares.length > 0 && <> · {t("adminGroups.tunnelCount", { count: g.shares.length })}</>}
                        </>
                    )}
                    badge={(g) => (g.synced ? <Building2 size={14} className="shrink-0 text-muted-foreground" aria-label={t("peopleGroups.keeper.synced")} /> : null)}
                />
                {group ? (
                    <GroupPanel key={group.id} policy={policy} group={group} page={page} onDeleted={() => pick(null)} />
                ) : (
                    <EmptyGroups icon={UsersRound} text={t("adminGroups.empty")} action={t("adminGroups.new")} onCreate={() => setCreating(true)} />
                )}
            </div>

            {creating && (
                <GroupNameDialog
                    title={t("adminGroups.new")}
                    hint={t("adminGroups.dialogHint")}
                    icon={<Users />}
                    placeholder={t("adminGroups.namePlaceholder")}
                    saving={page.saving}
                    onClose={() => setCreating(false)}
                    onSave={async (draft) => {
                        const id = await page.createShareGroup(draft);
                        if (id !== null) {
                            setCreating(false);
                            pick(id);
                        }
                    }}
                />
            )}
            {info && <AdminGroupsInfoDialog isOpen onClose={() => setInfo(false)} policy={policy} groupId={group?.id ?? null} />}
        </div>
    );
}

function GroupPanel({ policy, group, page, onDeleted }: { policy: AccessPolicy; group: AdminGroup; page: ReturnType<typeof useAccessPage>; onDeleted: () => void }) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const gate = useImpactConfirm();
    const shared = group.shares.length > 0;

    // 沒有分享給它的通道時，改成員不影響任何通道：不必問。/ No shares = members change no tunnel access: nothing to preview.
    const saveMembers = (members: number[]) =>
        gate.ask({
            preview: shared ? () => page.previewShareGroup(group.id, { members }) : undefined,
            run: () => page.updateShareGroup(group.id, { members }),
            title: t("adminGroups.confirmMembers", { name: group.name }),
            confirmText: t("access.membersSave"),
        });
    const remove = () =>
        gate.ask({
            preview: shared ? () => page.previewShareGroup(group.id, { delete: true }) : undefined,
            run: async () => {
                if (await page.deleteShareGroup(group.id)) onDeleted();
            },
            title: t("adminGroups.deleteTitle", { name: group.name }),
            confirmText: t("adminGroups.delete"),
            alwaysAsk: t("adminGroups.deleteMessage", { name: group.name }),
            destructive: true,
        });

    return (
        <div className="min-w-0">
            <SectionPanels>
                <div className="space-y-6">
                    <Section
                        icon={<Users />}
                        title={group.name}
                        description={group.description || t("adminGroups.noDescription")}
                        action={
                            <div className="flex gap-1">
                                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={t("adminGroups.edit")} title={t("adminGroups.edit")}>
                                    <Pencil />
                                </Button>
                                <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" disabled={gate.checking} onClick={() => void remove()} aria-label={t("adminGroups.delete")} title={t("adminGroups.delete")}>
                                    <Trash2 />
                                </Button>
                            </div>
                        }
                    >
                        <div className="flex flex-wrap gap-1.5">
                            <Chip><Users aria-hidden />{t("access.memberCount", { count: group.members.length })}</Chip>
                            <Chip><Share2 aria-hidden />{t("adminGroups.tunnelCount", { count: group.shares.length })}</Chip>
                            <Chip><Building2 aria-hidden />{t(group.synced ? "peopleGroups.keeper.synced" : "peopleGroups.keeper.admins")}</Chip>
                        </div>
                        {group.scim && <Callout tone="info" icon={<Building2 />}>{t("adminGroups.scimNote")}</Callout>}
                    </Section>

                    <Section icon={<UsersRound />} title={t("access.members")} description={t("adminGroups.membersHint")}>
                        <MembersEditor
                            users={policy.users}
                            groupId={group.id}
                            members={group.members}
                            ssoMembers={group.sso_members}
                            saving={page.saving || gate.checking}
                            onSave={saveMembers}
                        />
                        {group.sso_members.length > 0 && <p className="text-xs text-muted-foreground">{t("access.ssoMembersHint")}</p>}
                    </Section>

                    <Section icon={<Share2 />} title={t("adminGroups.sharesTitle")} description={t("adminGroups.sharesHint")}>
                        {shared ? <SharesList shares={group.shares} /> : <p className="text-sm text-muted-foreground">{t("adminGroups.noShares")}</p>}
                    </Section>
                </div>
            </SectionPanels>

            {editing && (
                <GroupNameDialog
                    title={t("adminGroups.edit")}
                    icon={<Users />}
                    initialName={group.name}
                    initialDescription={group.description}
                    placeholder={t("adminGroups.namePlaceholder")}
                    saving={page.saving}
                    onClose={() => setEditing(false)}
                    onSave={async (draft) => {
                        if (await page.updateShareGroup(group.id, draft)) setEditing(false);
                    }}
                />
            )}
            {gate.dialog}
        </div>
    );
}

function SharesList({ shares }: { shares: AdminGroupShare[] }) {
    const { t } = useI18n();
    const pager = usePagination(shares.length, { storageKey: "telepy.adminGroupSharesPageSize" });
    return (
        <>
            <ul className="divide-y divide-border/70 rounded-lg ring-1 ring-inset ring-border/80" data-refresh-list>
                {pageSlice(shares, pager.page, pager.size).map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <Link href={tunnelPageUrl(s.tunnel_id, "access")} className="flex min-w-0 items-center gap-1.5 text-foreground underline-offset-2 hover:underline">
                            <Server size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate">{s.tunnel_name}</span>
                        </Link>
                        <span className="text-xs text-muted-foreground">
                            {s.owner && <>{t("adminGroups.owner", { owner: s.owner })} · </>}
                            {t(PERM_KEY[s.permission_type])} · {t("adminGroups.through", { count: s.through })}
                        </span>
                    </li>
                ))}
            </ul>
            <Pagination pager={pager} compact className="justify-center" />
        </>
    );
}
