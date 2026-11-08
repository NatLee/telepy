"use client";

/**
 * 管理區「組織群組」頁：管理員（與單一登入規則 / SCIM）管的群組。左邊是群組清單（搜尋 + 分頁 + 新增），右邊是選中的
 * 群組（`?group=<id>`）：名稱與說明、成員、分享（「可以分享」開關 + 分享給它的通道）、功能規則（數量 + 去功能權限設定）。
 * 改成員、刪除、關掉分享前先預覽會讓誰多 / 少哪些通道（useImpactConfirm）。資料來自 `GET /api/access`。
 * The admin Organization groups page: groups admins (and SSO rules / SCIM) manage. Left: the group list (search,
 * pages, new). Right: the picked group (`?group=<id>`): name and description, members, sharing ("Can be shared" + the
 * tunnels shared with it) and feature rules (counts + a link to Feature access). Saving members, deleting or turning
 * sharing off previews who gains / loses which tunnels first. Data from `GET /api/access`.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Ban, Building2, Check, Info, Pencil, Plus, Search, Server, Share2, Shield, SlidersHorizontal, Trash2, User, Users, UsersRound } from "lucide-react";
import { AdminChip } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { Chip, Section, SectionPanels } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { MemberPicker } from "@/components/groups/MemberPicker";
import { useImpactConfirm } from "@/components/groups/ImpactConfirm";
import { OrgGroupsInfoDialog } from "@/components/groups/OrgGroupsInfoDialog";
import { useAccessPage } from "@/hooks/useAccessPage";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { filterGroups, type AccessGroup, type AccessPolicy } from "@/lib/features";
import { memberDiff, nameProblem, orgSharing, ruleCounts, scimManaged } from "@/lib/peopleGroups";
import { tunnelPageUrl } from "@/lib/tunnelPage";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const PERM_KEY: Record<string, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

export function OrgGroupsView({ initialGroup, startNew }: { initialGroup: number | null; startNew: boolean }) {
    const { t } = useI18n();
    const page = useAccessPage();
    const router = useRouter();
    const pathname = usePathname();
    const [picked, setPicked] = useState<number | null>(initialGroup);
    const [creating, setCreating] = useState(startNew);
    const [info, setInfo] = useState(false);
    const policy = page.policy;

    const pick = (id: number | null) => {
        setPicked(id);
        router.replace(id ? `${pathname}?group=${id}` : pathname, { scroll: false });
    };

    const header = (
        <PageHeader
            icon={<UsersRound />}
            title={t("orgGroups.title")}
            titleAddon={<AdminChip />}
            description={t("orgGroups.description")}
            actions={
                <Button variant="outline" onClick={() => setInfo(true)}>
                    <Info size={16} /> {t("access.howItWorks")}
                </Button>
            }
        />
    );

    if (page.loading && !policy) {
        return (
            <div className="space-y-6">
                {header}
                <div className="flex justify-center py-12 text-muted-foreground">
                    <div className="mr-3 size-6 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden />
                    {t("access.loading")}
                </div>
            </div>
        );
    }
    if (!policy) {
        return (
            <div className="space-y-6">
                {header}
                <Callout tone="danger">{t("access.loadFailed")}</Callout>
            </div>
        );
    }

    // 選的群組不見了（被刪 / 網址亂打）就選第一個。/ The picked group is gone: fall back to the first.
    const group = policy.groups.find((g) => g.id === picked) ?? policy.groups[0] ?? null;

    return (
        <div className="space-y-6">
            {header}
            <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <GroupList policy={policy} current={group?.id ?? null} onPick={pick} onCreate={() => setCreating(true)} />
                {group ? (
                    <GroupPanel key={group.id} policy={policy} group={group} page={page} onDeleted={() => pick(null)} />
                ) : (
                    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
                        <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                            <UsersRound size={20} />
                        </span>
                        <p className="mb-3 text-sm text-muted-foreground">{t("orgGroups.empty")}</p>
                        <Button type="button" onClick={() => setCreating(true)}>
                            <Plus size={15} /> {t("orgGroups.new")}
                        </Button>
                    </div>
                )}
            </div>

            {creating && (
                <OrgGroupDialog
                    title={t("orgGroups.new")}
                    saving={page.saving}
                    withShareable
                    onClose={() => setCreating(false)}
                    onSave={async (draft) => {
                        const id = await page.createGroup(draft);
                        if (id !== null) {
                            setCreating(false);
                            pick(id);
                        }
                    }}
                />
            )}
            {info && <OrgGroupsInfoDialog isOpen onClose={() => setInfo(false)} policy={policy} groupId={group?.id ?? null} />}
        </div>
    );
}

/* ── 左邊：群組清單 / The group list ───────────────────────────── */

function GroupList({ policy, current, onPick, onCreate }: { policy: AccessPolicy; current: number | null; onPick: (id: number) => void; onCreate: () => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const groups = filterGroups(policy.groups, query);
    const pager = usePagination(groups.length, { storageKey: "telepy.orgGroupsPageSize", resetKey: query });
    return (
        <nav className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-card" aria-label={t("orgGroups.listAria")}>
            <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs text-muted-foreground">
                    {t("orgGroups.title")} <span className="tabular-nums">({query.trim() ? `${groups.length}/${policy.groups.length}` : policy.groups.length})</span>
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onCreate}>
                    <Plus size={14} /> {t("access.newGroupShort")}
                </Button>
            </div>
            {policy.groups.length >= 7 && (
                <div className="relative px-1">
                    <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("orgGroups.search")} className="h-8 pl-8" aria-label={t("orgGroups.search")} />
                </div>
            )}
            {policy.groups.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noGroups")}</p>}
            {policy.groups.length > 0 && groups.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noMatch")}</p>}
            <div className="space-y-1">
                {pageSlice(groups, pager.page, pager.size).map((g) => {
                    const sharing = orgSharing(g);
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
                            <Users size={16} />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-foreground">{g.name}</span>
                                <span className="block text-xs leading-snug text-muted-foreground">
                                    {t("access.memberCount", { count: g.members.length })}
                                    {sharing.shares.length > 0 && <> · {t("orgGroups.tunnelCount", { count: sharing.shares.length })}</>}
                                </span>
                            </span>
                            {sharing.shareable && <Share2 size={14} className="shrink-0 text-muted-foreground" aria-label={t("orgGroups.shareable")} />}
                        </button>
                    );
                })}
            </div>
            <Pagination pager={pager} compact className="justify-center pt-1" />
        </nav>
    );
}

/* ── 右邊：一個群組 / One group ────────────────────────────────── */

function GroupPanel({ policy, group, page, onDeleted }: { policy: AccessPolicy; group: AccessGroup; page: ReturnType<typeof useAccessPage>; onDeleted: () => void }) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const gate = useImpactConfirm();
    const sharing = orgSharing(group);
    const rules = ruleCounts(group.grants);
    const scim = scimManaged(group.description);
    const ssoCount = group.sso_members?.length ?? 0;
    // 只有能分享或還有分享的群組，改成員才會動到通道。/ Members only change tunnel access for shareable groups or ones still shared.
    const touchesTunnels = sharing.shareable || sharing.shares.length > 0;

    const saveMembers = (members: number[]) =>
        gate.ask({
            preview: touchesTunnels ? () => page.previewGroup(group.id, { members }) : undefined,
            run: () => page.updateGroup(group.id, { members }),
            title: t("orgGroups.confirmMembers", { name: group.name }),
            confirmText: t("access.membersSave"),
        });
    const remove = () =>
        gate.ask({
            preview: sharing.shares.length > 0 ? () => page.previewGroup(group.id, { delete: true }) : undefined,
            run: async () => {
                if (await page.deleteGroup(group.id)) onDeleted();
            },
            title: t("orgGroups.deleteTitle", { name: group.name }),
            confirmText: t("access.deleteGroup"),
            alwaysAsk: t("orgGroups.deleteMessage", { name: group.name }),
            destructive: true,
        });
    const setShareable = (on: boolean) =>
        gate.ask({
            preview: !on && sharing.shares.length > 0 ? () => page.previewGroup(group.id, { shareable: false }) : undefined,
            run: () => page.updateGroup(group.id, { shareable: on }),
            title: t("orgGroups.confirmUnshare", { name: group.name }),
            confirmText: t("orgGroups.unshareConfirm"),
            destructive: true,
        });

    return (
        <div className="min-w-0">
            <SectionPanels>
                <div className="space-y-6">
                    <Section
                        icon={<Users />}
                        title={group.name}
                        description={group.description || t("orgGroups.noDescription")}
                        action={
                            <div className="flex gap-1">
                                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={t("access.editGroup")} title={t("access.editGroup")}>
                                    <Pencil />
                                </Button>
                                <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" disabled={gate.checking} onClick={() => void remove()} aria-label={t("access.deleteGroup")} title={t("access.deleteGroup")}>
                                    <Trash2 />
                                </Button>
                            </div>
                        }
                    >
                        <div className="flex flex-wrap gap-1.5">
                            <Chip><Users aria-hidden />{t("access.memberCount", { count: group.members.length })}</Chip>
                            <Chip>
                                <Share2 aria-hidden />
                                {sharing.shareable ? t("orgGroups.shareable") : t("orgGroups.notShareable")}
                            </Chip>
                            <Chip><SlidersHorizontal aria-hidden />{t("orgGroups.rulesCount", { allow: rules.allow, deny: rules.deny })}</Chip>
                        </div>
                        {scim && <Callout tone="info" icon={<Building2 />}>{t("orgGroups.scimNote")}</Callout>}
                    </Section>

                    <Section icon={<UsersRound />} title={t("access.members")} description={t("orgGroups.membersHint")}>
                        <MembersEditor policy={policy} group={group} saving={page.saving || gate.checking} onSave={saveMembers} />
                        {ssoCount > 0 && <p className="text-xs text-muted-foreground">{t("access.ssoMembersHint")}</p>}
                    </Section>

                    <Section icon={<Share2 />} title={t("orgGroups.sharingTitle")} description={t("orgGroups.sharingHint")}>
                        <Switch checked={sharing.shareable} disabled={page.saving || gate.checking} onCheckedChange={(on) => void setShareable(on)}>
                            <span className="text-sm text-foreground">{t("orgGroups.canBeShared")}</span>
                        </Switch>
                        <p className="text-xs leading-relaxed text-muted-foreground">{t(sharing.shareable ? "orgGroups.shareableOn" : "orgGroups.shareableOff")}</p>
                        {sharing.shares.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("orgGroups.noShares")}</p>
                        ) : (
                            <SharesList shares={sharing.shares} />
                        )}
                    </Section>

                    <Section
                        icon={<SlidersHorizontal />}
                        title={t("orgGroups.rulesTitle")}
                        description={t("orgGroups.rulesHint")}
                        action={
                            <Button asChild variant="outline" size="sm">
                                <Link href={`/tunnels/admin/access?group=${group.id}`}>{t("orgGroups.setRules")}</Link>
                            </Button>
                        }
                    >
                        <div className="flex flex-wrap gap-1.5">
                            <Chip tone={rules.allow > 0 ? "success" : "neutral"}><Check aria-hidden />{t("orgGroups.allows", { count: rules.allow })}</Chip>
                            <Chip tone={rules.deny > 0 ? "danger" : "neutral"}><Ban aria-hidden />{t("orgGroups.denies", { count: rules.deny })}</Chip>
                        </div>
                    </Section>
                </div>
            </SectionPanels>

            {editing && (
                <OrgGroupDialog
                    title={t("access.editGroup")}
                    initialName={group.name}
                    initialDescription={group.description}
                    saving={page.saving}
                    onClose={() => setEditing(false)}
                    onSave={async (draft) => {
                        if (await page.updateGroup(group.id, draft)) setEditing(false);
                    }}
                />
            )}
            {gate.dialog}
        </div>
    );
}

function SharesList({ shares }: { shares: ReturnType<typeof orgSharing>["shares"] }) {
    const { t } = useI18n();
    const pager = usePagination(shares.length, { storageKey: "telepy.orgGroupSharesPageSize" });
    return (
        <>
            <ul className="divide-y divide-border/70 rounded-lg ring-1 ring-inset ring-border/80">
                {pageSlice(shares, pager.page, pager.size).map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <Link href={tunnelPageUrl(s.tunnel_id, "access")} className="flex min-w-0 items-center gap-1.5 text-foreground underline-offset-2 hover:underline">
                            <Server size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate">{s.tunnel_name}</span>
                        </Link>
                        <span className="text-xs text-muted-foreground">
                            {s.owner && <>{t("orgGroups.owner", { owner: s.owner })} · </>}
                            {t(PERM_KEY[s.permission_type])} · {t("orgGroups.through", { count: s.through })}
                        </span>
                    </li>
                ))}
            </ul>
            <Pagination pager={pager} compact className="justify-center" />
        </>
    );
}

/** 成員：先在這裡改、按儲存才送出。/ Members: edited here, sent on Save. */
function MembersEditor({ policy, group, saving, onSave }: { policy: AccessPolicy; group: AccessGroup; saving: boolean; onSave: (members: number[]) => Promise<unknown> }) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<number[]>(group.members);
    const [base, setBase] = useState(group.members);
    if (base !== group.members) {
        setBase(group.members);
        setDraft(group.members);
    }
    // 單一登入給的成員：標出來，手動拿掉只維持到他下次登入。/ Members from single sign-on are marked.
    const ssoMembers = group.sso_members;
    const items = useMemo(() => {
        const sso = new Map((ssoMembers ?? []).map((m) => [m.user_id, m.provider] as const));
        return policy.users.map((u) => ({
            id: u.id,
            label: u.username,
            text: [u.username, u.email],
            group: null,
            icon: u.is_superuser ? <Shield size={14} className="shrink-0 text-muted-foreground" aria-hidden /> : <User size={14} className="shrink-0 text-muted-foreground" aria-hidden />,
            meta: sso.has(u.id) ? <Building2 size={14} className="shrink-0 text-muted-foreground" aria-label={t("access.viaSso", { provider: sso.get(u.id) ?? "" })} /> : u.is_superuser ? <Chip>{t("access.adminChip")}</Chip> : undefined,
            title: sso.has(u.id) ? t("access.viaSso", { provider: sso.get(u.id) ?? "" }) : u.email || u.username,
        }));
    }, [policy.users, ssoMembers, t]);
    const { added, removed } = memberDiff(group.members, draft);
    return (
        <div className="space-y-2">
            <MemberPicker items={items} selected={draft} onChange={setDraft} current={group.id} title={t("access.members")} hint={t("access.membersHint")} showFree={false} />
            {added + removed > 0 && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 shadow-pop ring-1 ring-border">
                    <span className="text-sm text-foreground">{t("access.membersChanged", { added, removed })}</span>
                    <span className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setDraft(group.members)}>{t("access.membersDiscard")}</Button>
                        <Button type="button" size="sm" disabled={saving} onClick={() => void onSave(draft)}>{t("access.membersSave")}</Button>
                    </span>
                </div>
            )}
        </div>
    );
}

function OrgGroupDialog({
    title,
    initialName = "",
    initialDescription = "",
    withShareable = false,
    saving,
    onClose,
    onSave,
}: {
    title: string;
    initialName?: string;
    initialDescription?: string;
    withShareable?: boolean;
    saving: boolean;
    onClose: () => void;
    onSave: (draft: { name: string; description: string; shareable?: boolean }) => void;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(initialName);
    const [description, setDescription] = useState(initialDescription);
    const [shareable, setShareable] = useState(false);
    const valid = nameProblem(name) === null;
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (valid && !saving) onSave({ name: name.trim(), description: description.trim(), ...(withShareable ? { shareable } : {}) });
    };
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={title}
            icon={<Users />}
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
                    <Input value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} placeholder={t("access.groupNamePlaceholder")} />
                </Field>
                <Field label={t("access.groupDescription")} hint={t("access.groupDescriptionHint")}>
                    <Input value={description} maxLength={256} onChange={(e) => setDescription(e.target.value)} />
                </Field>
                {withShareable && (
                    <div className="space-y-1">
                        <Switch checked={shareable} onCheckedChange={setShareable}>
                            <span className="text-sm text-foreground">{t("orgGroups.canBeShared")}</span>
                        </Switch>
                        <p className="text-xs leading-relaxed text-muted-foreground">{t("orgGroups.shareableNew")}</p>
                    </div>
                )}
            </form>
        </Modal>
    );
}
