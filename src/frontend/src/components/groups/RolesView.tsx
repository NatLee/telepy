"use client";

/**
 * 管理區「角色」頁：一群人共用同一套功能規則（以前叫組織群組）。角色只決定「能用哪些工具」，從不出現在分享視窗、
 * 也從不給或拿走通道——那是「群組」頁的事。左邊是角色清單（搜尋 + 分頁 + 新增），右邊是選中的角色（`?role=<id>`）：
 * 名稱與說明、成員（單一登入標記、SCIM 說明）、功能規則（數量 + 到功能權限設定）。資料來自 `GET /api/access`。
 * The admin Roles page: a set of people sharing the same feature rules (formerly "organization groups"). A role only
 * decides which tools people may use; it never shows up in share dialogs and never gives or takes tunnels — that is
 * the Groups page's job. Left: the role list (search, pages, new). Right: the picked role (`?role=<id>`): name and
 * description, members (SSO marks, SCIM note) and feature rules (counts + a link to Feature access).
 */
import React, { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Ban, BadgeCheck, Building2, Check, Info, Pencil, SlidersHorizontal, Trash2, Users, UsersRound } from "lucide-react";
import { AdminChip } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, Section, SectionPanels } from "@/components/ui/section";
import { AdminGroupList, EmptyGroups, GroupNameDialog, MembersEditor, PolicyState, RolesVsGroups } from "@/components/groups/AdminGroupBits";
import { RolesInfoDialog } from "@/components/groups/RolesGroupsInfoDialog";
import { useAccessPage } from "@/hooks/useAccessPage";
import { filterGroups, type AccessGroup, type AccessPolicy } from "@/lib/features";
import { ruleCounts, scimManaged } from "@/lib/peopleGroups";
import { useI18n } from "@/lib/i18n";

export function RolesView({ initialRole, startNew }: { initialRole: number | null; startNew: boolean }) {
    const { t } = useI18n();
    const page = useAccessPage();
    const router = useRouter();
    const pathname = usePathname();
    const [picked, setPicked] = useState<number | null>(initialRole);
    const [creating, setCreating] = useState(startNew);
    const [info, setInfo] = useState(false);
    const policy = page.policy;

    const pick = (id: number | null) => {
        setPicked(id);
        router.replace(id ? `${pathname}?role=${id}` : pathname, { scroll: false });
    };

    const header = (
        <PageHeader
            icon={<BadgeCheck />}
            title={t("roles.title")}
            titleAddon={<AdminChip />}
            description={t("roles.description")}
            actions={
                <Button variant="outline" onClick={() => setInfo(true)}>
                    <Info size={16} /> {t("access.howItWorks")}
                </Button>
            }
        />
    );

    if (!policy) return <PolicyState header={header} loading={page.loading} />;

    // 選的角色不見了（被刪 / 網址亂打）就選第一個。/ The picked role is gone: fall back to the first.
    const role = policy.groups.find((g) => g.id === picked) ?? policy.groups[0] ?? null;

    return (
        <div className="space-y-6">
            {header}
            <RolesVsGroups page="roles" />
            <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <AdminGroupList
                    items={policy.groups}
                    filter={filterGroups}
                    current={role?.id ?? null}
                    onPick={pick}
                    onCreate={() => setCreating(true)}
                    title={t("roles.title")}
                    searchLabel={t("roles.search")}
                    emptyText={t("roles.none")}
                    storageKey="telepy.rolesPageSize"
                    icon={BadgeCheck}
                    ariaLabel={t("roles.title")}
                    sub={(g) => t("access.memberCount", { count: g.members.length })}
                />
                {role ? (
                    <RolePanel key={role.id} policy={policy} role={role} page={page} onDeleted={() => pick(null)} />
                ) : (
                    <EmptyGroups icon={BadgeCheck} text={t("roles.empty")} action={t("roles.new")} onCreate={() => setCreating(true)} />
                )}
            </div>

            {creating && (
                <GroupNameDialog
                    title={t("roles.new")}
                    hint={t("roles.dialogHint")}
                    icon={<BadgeCheck />}
                    placeholder={t("roles.namePlaceholder")}
                    saving={page.saving}
                    onClose={() => setCreating(false)}
                    onSave={async (draft) => {
                        const id = await page.createRole(draft);
                        if (id !== null) {
                            setCreating(false);
                            pick(id);
                        }
                    }}
                />
            )}
            {info && <RolesInfoDialog isOpen onClose={() => setInfo(false)} policy={policy} roleId={role?.id ?? null} />}
        </div>
    );
}

function RolePanel({ policy, role, page, onDeleted }: { policy: AccessPolicy; role: AccessGroup; page: ReturnType<typeof useAccessPage>; onDeleted: () => void }) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const rules = ruleCounts(role.grants);
    const scim = scimManaged(role.description);
    const ssoCount = role.sso_members?.length ?? 0;

    return (
        <div className="min-w-0">
            <SectionPanels>
                <div className="space-y-6">
                    <Section
                        icon={<BadgeCheck />}
                        title={role.name}
                        description={role.description || t("roles.noDescription")}
                        action={
                            <div className="flex gap-1">
                                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={t("roles.edit")} title={t("roles.edit")}>
                                    <Pencil />
                                </Button>
                                <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleting(true)} aria-label={t("roles.delete")} title={t("roles.delete")}>
                                    <Trash2 />
                                </Button>
                            </div>
                        }
                    >
                        <div className="flex flex-wrap gap-1.5">
                            <Chip><Users aria-hidden />{t("access.memberCount", { count: role.members.length })}</Chip>
                            <Chip><SlidersHorizontal aria-hidden />{t("roles.rulesCount", { allow: rules.allow, deny: rules.deny })}</Chip>
                        </div>
                        {scim && <Callout tone="info" icon={<Building2 />}>{t("roles.scimNote")}</Callout>}
                    </Section>

                    <Section icon={<UsersRound />} title={t("access.members")} description={t("roles.membersHint")}>
                        <MembersEditor
                            users={policy.users}
                            groupId={role.id}
                            members={role.members}
                            ssoMembers={role.sso_members}
                            saving={page.saving}
                            onSave={(members) => page.updateRole(role.id, { members })}
                        />
                        {ssoCount > 0 && <p className="text-xs text-muted-foreground">{t("access.ssoMembersHint")}</p>}
                    </Section>

                    <Section
                        icon={<SlidersHorizontal />}
                        title={t("roles.rulesTitle")}
                        description={t("roles.rulesHint")}
                        action={
                            <Button asChild variant="outline" size="sm">
                                <Link href={`/tunnels/admin/access?group=${role.id}`}>{t("roles.setRules")}</Link>
                            </Button>
                        }
                    >
                        <div className="flex flex-wrap gap-1.5">
                            <Chip tone={rules.allow > 0 ? "success" : "neutral"}><Check aria-hidden />{t("roles.allows", { count: rules.allow })}</Chip>
                            <Chip tone={rules.deny > 0 ? "danger" : "neutral"}><Ban aria-hidden />{t("roles.denies", { count: rules.deny })}</Chip>
                        </div>
                    </Section>
                </div>
            </SectionPanels>

            {editing && (
                <GroupNameDialog
                    title={t("roles.edit")}
                    icon={<BadgeCheck />}
                    initialName={role.name}
                    initialDescription={role.description}
                    placeholder={t("roles.namePlaceholder")}
                    saving={page.saving}
                    onClose={() => setEditing(false)}
                    onSave={async (draft) => {
                        if (await page.updateRole(role.id, draft)) setEditing(false);
                    }}
                />
            )}
            {deleting && (
                <ConfirmDialog
                    isOpen
                    isDestructive
                    title={t("roles.deleteTitle", { name: role.name })}
                    message={t("roles.deleteMessage", { name: role.name })}
                    confirmText={t("roles.delete")}
                    onClose={() => setDeleting(false)}
                    onConfirm={async () => {
                        setDeleting(false);
                        if (await page.deleteRole(role.id)) onDeleted();
                    }}
                />
            )}
        </div>
    );
}
