"use client";

/**
 * 分享彈窗的「群組」分頁：通道分享給哪些群組（組織群組或個人群組；每個的權限、帳號、期限、成員、暫停狀態）與新增；
 * 自己的個人群組也在這裡新增、編輯、刪除（改成員 / 刪除前先預覽影響）。資訊鈕打開群組分享的說明圖。
 * The share dialog's Groups tab: the groups a tunnel is shared with (organization or personal; permission, accounts,
 * end, members, paused state) and the add form. Your own personal groups are made, edited and deleted here too
 * (members / delete preview the impact first). The info button opens the group sharing diagram.
 */
import React, { useState } from "react";
import { Building2, CircleHelp, CirclePause, Pencil, Plus, Share2, Trash2, User, UserCog, Users, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Chip, Section } from "@/components/ui/section";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { ShareExpiryChoice, ShareExpiryControl } from "@/components/tunnels/ShareExpiry";
import { ShareModalEditTargetUsersModal } from "@/components/tunnels/ShareModalEditTargetUsersModal";
import { useGroupShares } from "@/hooks/useGroupShares";
import { usePersonalGroups } from "@/hooks/usePersonalGroups";
import { useImpactConfirm } from "@/components/groups/ImpactConfirm";
import { PersonalGroupDialog, type PersonalGroupForm } from "@/components/groups/PersonalGroupDialog";
import { hasFeature } from "@/lib/features";
import { filterNamedGroups, memberDiff, type PersonalGroup } from "@/lib/peopleGroups";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { choicesByKind, groupShareSpots, memberParts, shareKindLabel, type GroupShare, type SharePermission } from "@/lib/groupShares";
import { shareExpiryValue, type ShareExpiryPreset } from "@/lib/shareExpiry";
import type { ReverseServerUsername } from "@/types/tunnel";
import type { TranslationKey } from "@/locales/en";

const PERM_KEY: Record<SharePermission, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

interface Props {
    tunnelId: number | null;
    isOpen: boolean;
    tunnelUsernames: ReverseServerUsername[];
    readOnly: boolean;
    /** 「分享通道」功能關著：只能收回。/ Sharing turned off: removing only. */
    locked: boolean;
    /** 群組分享變了：人員分頁重新整理。/ A group share changed: the people tab refreshes. */
    onChanged: () => void;
}

export function ShareModalGroups({ tunnelId, isOpen, tunnelUsernames, readOnly, locked, onChanged }: Props) {
    const { t } = useI18n();
    const user = useAuth().user;
    const { list, busy, share, update, remove, reload } = useGroupShares(tunnelId, isOpen, onChanged);
    // 個人群組要有「分享通道」功能（後端沒有就 403）。/ Personal groups need the share feature (the backend answers 403 otherwise).
    const personalOn = hasFeature(user, "tunnels.share");
    const personal = usePersonalGroups(isOpen && personalOn, () => {
        void reload();
        onChanged();
    });
    const [groupDialog, setGroupDialog] = useState<PersonalGroup | "new" | null>(null);
    const gate = useImpactConfirm();
    const [pick, setPick] = useState("");
    const [perm, setPerm] = useState<SharePermission>("view");
    const [accounts, setAccounts] = useState<number[]>([]);
    const [preset, setPreset] = useState<ShareExpiryPreset>("never");
    const [date, setDate] = useState("");
    const [editing, setEditing] = useState<{ id: number; name: string; allowedIds: number[] } | null>(null);
    const [removing, setRemoving] = useState<GroupShare | null>(null);
    const [info, setInfo] = useState(false);
    const pager = usePagination(list?.shares.length ?? 0, { storageKey: "telepy.groupSharesPageSize" });

    if (!list) return null;
    const manage = list.can_manage && !readOnly;
    const canAdd = manage && !locked;
    const choices = choicesByKind(list);
    const choiceCount = choices.personal.length + choices.org.length;
    const canPersonal = canAdd && personalOn && personal.list !== null;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const expires = shareExpiryValue(preset, date);
        if (!pick || expires === undefined) return;
        if (await share(Number(pick), perm, accounts, expires)) {
            setPick("");
            setPerm("view");
            setAccounts([]);
            setPreset("never");
            setDate("");
        }
    };

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("share.group.intro")}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setInfo(true)}>
                    <CircleHelp size={14} /> {t("share.group.how")}
                </Button>
            </div>

            {list.shares.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-7 text-center">
                    <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                        <UsersRound size={20} />
                    </span>
                    <p className="text-sm text-muted-foreground">{t("share.group.none")}</p>
                    {canPersonal && choiceCount === 0 && (
                        <>
                            <p className="mt-1 max-w-md text-xs text-muted-foreground">{t("share.group.noGroupsPersonal")}</p>
                            <Button type="button" size="sm" className="mt-3" onClick={() => setGroupDialog("new")}>
                                <Plus size={14} /> {t("personalGroups.new")}
                            </Button>
                        </>
                    )}
                </div>
            ) : (
                <ul className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-border/80" data-refresh-list>
                    {pageSlice(list.shares, pager.page, pager.size).map((g) => {
                        return (
                            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
                                <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                                        <Users size={16} />
                                    </span>
                                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                                        <span className="flex max-w-full flex-wrap items-center gap-1.5">
                                            <span className="min-w-0 truncate text-sm text-foreground">{g.name}</span>
                                            <KindChip share={g} />
                                        </span>
                                        {!g.active && (
                                            <span className="flex items-start gap-1 text-xs leading-snug text-warning">
                                                <CirclePause size={13} className="mt-px shrink-0" aria-hidden />
                                                {t("share.group.paused", { owner: g.owner ?? "?" })}
                                            </span>
                                        )}
                                        <span className="text-xs text-muted-foreground">
                                            {t("share.group.counts", { members: g.members, through: g.through })}
                                            {memberParts(g).map((part) => (
                                                <React.Fragment key={part}>
                                                    {" · "}
                                                    {part === "direct" ? t("share.group.direct", { count: g.direct }) : part === "elsewhere" ? t("share.group.elsewhere", { count: g.elsewhere }) : t("share.group.ownerIn")}
                                                </React.Fragment>
                                            ))}
                                        </span>
                                        <ShareExpiryControl expiresAt={g.expires_at} editable={canAdd} onChange={(v) => update(g.id, { expires_at: v })} />
                                    </span>
                                </div>
                                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                                    {g.member_names && (
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button type="button" size="sm" variant="ghost" className="text-xs">
                                                    <Users size={14} /> {t("share.group.members")}
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent align="end" className="w-60 p-3">
                                                <p className="mb-2 text-xs text-muted-foreground">{t("share.group.membersOf", { name: g.name })} · {g.member_names.length}</p>
                                                {g.member_names.length === 0 ? (
                                                    <p className="text-sm text-muted-foreground">{t("share.group.empty")}</p>
                                                ) : (
                                                    <ul className="max-h-60 space-y-1 overflow-auto text-sm">
                                                        {g.member_names.map((n) => (
                                                            <li key={n} className="truncate">{n}</li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </PopoverContent>
                                        </Popover>
                                    )}
                                    <button
                                        type="button"
                                        disabled={!canAdd || tunnelUsernames.length === 0}
                                        onClick={() => setEditing({ id: g.id, name: g.name, allowedIds: g.allowed_target_usernames.map((a) => a.id) })}
                                        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-inset ring-border transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-default"
                                        title={g.allowed_target_usernames.map((a) => a.username).join(", ") || t("share.group.noAccounts")}
                                    >
                                        <UserCog size={14} aria-hidden />
                                        <span>{t("share.thTargetUsers")}</span>
                                        <span className="tabular-nums text-foreground">{g.allowed_target_usernames.length}</span>
                                        {canAdd && <Pencil size={12} aria-hidden />}
                                    </button>
                                    <NativeSelect
                                        value={g.permission_type}
                                        onChange={(e) => void update(g.id, { permission_type: e.target.value as SharePermission })}
                                        disabled={!canAdd || busy}
                                        aria-label={t("share.thPermission")}
                                        className="h-8 w-28 text-xs"
                                    >
                                        {(Object.keys(PERM_KEY) as SharePermission[]).map((p) => (
                                            <option key={p} value={p}>{t(PERM_KEY[p])}</option>
                                        ))}
                                    </NativeSelect>
                                    {manage && (
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            onClick={() => setRemoving(g)}
                                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                            title={t("share.group.remove")}
                                            aria-label={t("share.group.remove")}
                                        >
                                            <X />
                                        </Button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            <Pagination pager={pager} />

            {canAdd &&
                (list.groups.length === 0 ? (
                    canPersonal ? (
                        list.shares.length > 0 && (
                            <Callout tone="info" title={t("share.group.noGroups")}>
                                <p>{t("share.group.noGroupsPersonal")}</p>
                                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setGroupDialog("new")}>
                                    <Plus size={14} /> {t("personalGroups.new")}
                                </Button>
                            </Callout>
                        )
                    ) : (
                        <Callout tone="info" title={t("share.group.noGroups")}>
                            {t("share.group.askAdmin")}
                        </Callout>
                    )
                ) : (
                    <form onSubmit={submit} className="space-y-3 rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-border/80">
                        <p className="flex items-center gap-2 text-sm">
                            <Share2 size={15} className="text-muted-foreground" aria-hidden /> {t("share.group.add")}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                            <Field label={t("share.group.pick")}>
                                <NativeSelect value={pick} onChange={(e) => setPick(e.target.value)} disabled={choiceCount === 0}>
                                    <option value="">{choiceCount === 0 ? t("share.group.allShared") : t("share.group.pickPlaceholder")}</option>
                                    {choices.personal.length > 0 && (
                                        <optgroup label={t("share.group.optPersonal")}>
                                            {choices.personal.map((g) => (
                                                <option key={g.id} value={g.id}>
                                                    {t("share.group.choice", { name: g.name, count: g.members })}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {choices.org.length > 0 && (
                                        <optgroup label={t("share.group.optOrg")}>
                                            {choices.org.map((g) => (
                                                <option key={g.id} value={g.id}>
                                                    {t("share.group.choice", { name: g.name, count: g.members })}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                </NativeSelect>
                            </Field>
                            <Field label={t("share.thPermission")}>
                                <NativeSelect value={perm} onChange={(e) => setPerm(e.target.value as SharePermission)}>
                                    {(Object.keys(PERM_KEY) as SharePermission[]).map((p) => (
                                        <option key={p} value={p}>{t(PERM_KEY[p])}</option>
                                    ))}
                                </NativeSelect>
                            </Field>
                        </div>
                        {pick && tunnelUsernames.length > 0 && (
                            <div>
                                <p className="mb-2 text-xs text-muted-foreground">{t("share.group.allowLabel")}</p>
                                <div className="flex flex-wrap gap-2">
                                    {tunnelUsernames.map((u) => (
                                        <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs ring-1 ring-inset ring-border transition-colors hover:ring-foreground/20 has-checked:bg-primary/10 has-checked:text-primary has-checked:ring-primary/40">
                                            <input
                                                type="checkbox"
                                                checked={accounts.includes(u.id)}
                                                onChange={(e) => setAccounts((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)))}
                                                className="size-3.5 accent-primary"
                                            />
                                            <code className="font-mono">{u.username}</code>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                        {pick && <ShareExpiryChoice preset={preset} date={date} onPreset={setPreset} onDate={setDate} />}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">{t("share.group.followsNote")}</p>
                            <Button type="submit" disabled={!pick || busy || (preset === "date" && !date)}>
                                <Users size={15} /> {t("share.group.share")}
                            </Button>
                        </div>
                    </form>
                ))}
            {!readOnly && locked && list.can_manage && <Callout tone="warning">{t("access.shareOff")}</Callout>}

            {canPersonal && personal.list && (
                <PersonalGroupsSection
                    groups={personal.list.groups}
                    limit={personal.list.limit}
                    busy={personal.busy}
                    onNew={() => setGroupDialog("new")}
                    onEdit={(g) => setGroupDialog(g)}
                    onDelete={(g) =>
                        void gate.ask({
                            preview: g.shares.length > 0 ? () => personal.preview(g.id, { delete: true }) : undefined,
                            run: () => personal.remove(g.id),
                            title: t("personalGroups.deleteTitle", { name: g.name }),
                            confirmText: t("personalGroups.delete"),
                            alwaysAsk: t("personalGroups.deleteMessage", { name: g.name, count: g.shares.length }),
                            destructive: true,
                        })
                    }
                />
            )}
            {groupDialog !== null && personal.list && (
                <PersonalGroupDialog
                    group={groupDialog === "new" ? null : groupDialog}
                    users={personal.list.users}
                    maxMembers={personal.list.max_members}
                    saving={personal.busy || gate.checking}
                    onClose={() => setGroupDialog(null)}
                    onSave={(form: PersonalGroupForm) => {
                        if (groupDialog === "new") {
                            void personal.create(form).then((r) => {
                                if (r !== null) setGroupDialog(null);
                            });
                            return;
                        }
                        const g = groupDialog;
                        const changed = memberDiff(g.members, form.members);
                        void gate.ask({
                            preview: g.shares.length > 0 && changed.added + changed.removed > 0 ? () => personal.preview(g.id, { members: form.members }) : undefined,
                            run: async () => {
                                if ((await personal.update(g.id, form)) !== null) setGroupDialog(null);
                            },
                            title: t("personalGroups.confirmMembers", { name: g.name }),
                            confirmText: t("common.save"),
                        });
                    }}
                />
            )}
            {gate.dialog}

            <ShareModalEditTargetUsersModal
                isOpen={editing !== null}
                username={editing?.name ?? null}
                allowedIds={editing?.allowedIds ?? []}
                tunnelUsernames={tunnelUsernames}
                onClose={() => setEditing(null)}
                onSave={async () => {
                    if (editing && (await update(editing.id, { allowed_target_username_ids: editing.allowedIds }))) setEditing(null);
                }}
                onAllowedIdsChange={(allowedIds) => setEditing((prev) => (prev ? { ...prev, allowedIds } : null))}
            />
            <ConfirmDialog
                isOpen={removing !== null}
                onClose={() => setRemoving(null)}
                onConfirm={() => {
                    const g = removing;
                    setRemoving(null);
                    if (g) void remove(g.id);
                }}
                title={t("share.group.removeTitle", { name: removing?.name ?? "" })}
                message={t("share.group.removeMessage", { count: removing?.through ?? 0 })}
                confirmText={t("share.group.remove")}
                isDestructive
            />
            <GroupShareInfoDialog isOpen={info} onClose={() => setInfo(false)} share={list.shares[0] ?? null} />
        </div>
    );
}

/** 分享列上的種類：個人 · 你的 / 個人 · 某人 / 組織。/ The kind on a share row. */
function KindChip({ share }: { share: GroupShare }) {
    const { t } = useI18n();
    const k = shareKindLabel(share);
    if (k.kind === "org") return <Chip><Building2 aria-hidden />{t("share.group.kindOrg")}</Chip>;
    return (
        <Chip>
            <User aria-hidden />
            {k.kind === "mine" ? t("share.group.kindMine") : t("share.group.kindPersonal", { owner: k.owner ?? "?" })}
        </Chip>
    );
}

/** 你的個人群組：每個的人數與用在哪些通道，新增 / 編輯 / 刪除。/ Your personal groups: members, tunnels using them, new / edit / delete. */
function PersonalGroupsSection({
    groups,
    limit,
    busy,
    onNew,
    onEdit,
    onDelete,
}: {
    groups: PersonalGroup[];
    limit: number;
    busy: boolean;
    onNew: () => void;
    onEdit: (g: PersonalGroup) => void;
    onDelete: (g: PersonalGroup) => void;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = filterNamedGroups(groups, query);
    const pager = usePagination(shown.length, { storageKey: "telepy.personalGroupsPageSize", resetKey: query });
    return (
        <Section
            icon={<User />}
            title={t("personalGroups.yours")}
            description={t("personalGroups.yoursHint")}
            action={
                <Button type="button" size="sm" variant="outline" disabled={busy || groups.length >= limit} onClick={onNew} title={groups.length >= limit ? t("personalGroups.limit", { limit }) : undefined}>
                    <Plus size={14} /> {t("personalGroups.newShort")}
                </Button>
            }
        >
            {groups.length >= 7 && (
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("personalGroups.search")} aria-label={t("personalGroups.search")} className="h-8" />
            )}
            {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("personalGroups.none")}</p>
            ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("access.noMatch")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                    {pageSlice(shown, pager.page, pager.size).map((g) => {
                        const paused = g.shares.filter((s) => !s.active).length;
                        return (
                            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                                <span className="flex min-w-0 flex-1 basis-48 flex-col">
                                    <span className="truncate text-sm text-foreground" title={g.description || undefined}>{g.name}</span>
                                    <span className="text-xs text-muted-foreground" title={g.shares.map((s) => s.tunnel_name).join(", ") || undefined}>
                                        {t("access.memberCount", { count: g.members.length })} · {t("personalGroups.usedBy", { count: g.shares.length })}
                                        {paused > 0 && <span className="text-warning"> · {t("personalGroups.pausedCount", { count: paused })}</span>}
                                    </span>
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
        </Section>
    );
}

const RULES: TranslationKey[] = [
    "share.group.flow.rule1",
    "share.group.flow.rule2",
    "share.group.flow.rule3",
    "share.group.flow.rule4",
    "share.group.flow.rule5",
    "share.group.flow.rule6",
];

/** 群組分享怎麼運作：組織群組（身分提供者 / 管理員管）或個人群組（你管）─ 這條通道 ─ 每位成員。
 *  How group sharing works: an organization group (identity provider / admins) or a personal group (you) ─ this
 *  tunnel ─ each member. */
export function GroupShareInfoDialog({ isOpen, onClose, share }: { isOpen: boolean; onClose: () => void; share: GroupShare | null }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<"org" | "personal" | null>(null);
    const kind = picked ?? share?.kind ?? "org";
    // 選的種類跟這筆分享不同時，用範例畫。/ When the picked kind differs from the share, draw an example.
    const real = share && share.kind === kind ? share : null;
    const spots = groupShareSpots(real);
    const perm = real ? t(PERM_KEY[real.permission_type]) : t("share.permView");
    const accounts = real ? real.allowed_target_usernames.map((a) => a.username).join(", ") || t("share.group.noAccounts") : "ubuntu";
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("share.group.flow.title")} description={t("share.group.flow.description")} icon={<Users />} size="5xl">
            <div className="space-y-5">
                <Segmented<"org" | "personal">
                    size="sm"
                    aria-label={t("share.group.flow.kind")}
                    value={kind}
                    onChange={setPicked}
                    options={[
                        { value: "org", label: t("orgGroups.title"), icon: <Building2 size={13} /> },
                        { value: "personal", label: t("personalGroups.title"), icon: <User size={13} /> },
                    ]}
                />
                <FlowPath>
                    {kind === "org" ? (
                        <FlowNode icon={Building2} title={t("share.group.flow.provider")} sub={t("share.group.flow.providerSub")} state="waiting" stateText={t("share.group.flow.optional")} />
                    ) : (
                        <FlowNode icon={User} title={t("share.group.flow.you")} sub={real?.owner && !real.mine ? real.owner : t("share.group.flow.youSub")} state={real ? (real.active ? "ok" : "failed") : "waiting"} stateText={real && !real.active ? t("share.group.flow.notManaging") : undefined} />
                    )}
                    <FlowLink compact label={kind === "org" ? t("share.group.flow.sync") : t("share.group.flow.picks")} state={kind === "org" ? "waiting" : spots.group} />
                    <FlowNode
                        icon={Users}
                        title={real ? real.name : kind === "org" ? t("share.group.flow.group") : t("personalGroups.title")}
                        sub={real ? t("share.group.flow.groupCount", { count: real.members }) : kind === "org" ? t("share.group.flow.groupSub") : t("share.group.flow.personalSub")}
                        state={spots.group}
                    />
                    <FlowLink compact label={t("share.group.flow.shared")} state={spots.share} />
                    <FlowNode icon={Share2} title={t("share.group.flow.share")} sub={t("share.group.flow.shareSub", { permission: perm, accounts })} state={spots.share} stateText={real && !real.active ? t("share.group.flow.pausedState") : undefined} />
                    <FlowLink compact label={t("share.group.flow.each")} state={spots.members} />
                    <FlowNode
                        icon={UsersRound}
                        title={t("share.group.flow.members")}
                        sub={real ? t("share.group.flow.membersCount", { through: real.through, direct: real.direct }) : t("share.group.flow.membersSub")}
                        state={spots.members}
                    />
                </FlowPath>
                <Section title={t("share.group.flow.rulesTitle")}>
                    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                        {RULES.map((k) => (
                            <li key={k}>{t(k)}</li>
                        ))}
                    </ul>
                </Section>
            </div>
        </Modal>
    );
}
