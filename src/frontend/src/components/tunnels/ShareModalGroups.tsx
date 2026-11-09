"use client";

/**
 * 分享彈窗的「群組」分頁：通道分享給哪些群組（每個標出成員是誰在維護；權限、帳號、期限、成員、暫停狀態）與新增
 * （一張可搜尋、分頁的清單）；你建立的群組也在這裡新增、編輯、刪除（改成員 / 刪除前先預覽影響）。資訊鈕打開群組分享的說明圖。
 * The share dialog's Groups tab: the groups a tunnel is shared with (each labelled by who keeps its members;
 * permission, accounts, end, members, paused state) and the add form (one searchable, paged list). The groups you
 * made are made, edited and deleted here too (members / delete preview the impact first). The info button opens the
 * group sharing diagram.
 */
import React, { useState } from "react";
import { Building2, CircleHelp, CirclePause, Pencil, Plus, Share2, User, UserCog, Users, UsersRound, X } from "lucide-react";
import { GroupSearchBox, GroupSearchFooter, useGroupSearch } from "@/components/groups/GroupSearch";
import { GroupKeeper } from "@/components/groups/GroupKeeper";
import { MemberNamesPopover } from "@/components/groups/MemberNames";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Section } from "@/components/ui/section";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { ShareExpiryChoice, ShareExpiryControl } from "@/components/tunnels/ShareExpiry";
import { ShareModalEditTargetUsersModal } from "@/components/tunnels/ShareModalEditTargetUsersModal";
import { useGroupShares } from "@/hooks/useGroupShares";
import { usePersonalGroups } from "@/hooks/usePersonalGroups";
import { PersonalGroupsSection, usePersonalGroupEditor } from "@/components/groups/PersonalGroupsManager";
import { hasFeature } from "@/lib/features";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { groupShareSpots, memberParts, sortedChoices, type GroupShare, type SharePermission } from "@/lib/groupShares";
import { shareExpiryValue, type ShareExpiryPreset } from "@/lib/shareExpiry";
import type { ReverseServerUsername } from "@/types/tunnel";
import type { TranslationKey } from "@/locales/en";

const PERM_KEY: Record<SharePermission, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

const CHOICE_ROW = "flex cursor-pointer items-center gap-2.5 rounded-lg bg-card px-3 py-2 ring-1 ring-inset ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30";

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
    const editor = usePersonalGroupEditor(personal);
    const [pick, setPick] = useState<number | null>(null);
    const [perm, setPerm] = useState<SharePermission>("view");
    const [accounts, setAccounts] = useState<number[]>([]);
    const [preset, setPreset] = useState<ShareExpiryPreset>("never");
    const [date, setDate] = useState("");
    const [editing, setEditing] = useState<{ id: number; name: string; allowedIds: number[] } | null>(null);
    const [removing, setRemoving] = useState<GroupShare | null>(null);
    const [info, setInfo] = useState(false);
    const pager = usePagination(list?.shares.length ?? 0, { storageKey: "telepy.groupSharesPageSize" });
    // 一張清單：自己做的在前；7 個起有搜尋，分頁，選中的那個一定看得到。/ One list, yours first; search from 7, pages, the pick stays visible.
    const choices = list ? sortedChoices(list) : [];
    const search = useGroupSearch(choices, pick);

    if (!list) return null;
    const manage = list.can_manage && !readOnly;
    const canAdd = manage && !locked;
    const choiceCount = choices.length;
    const canPersonal = canAdd && personalOn && personal.list !== null;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const expires = shareExpiryValue(preset, date);
        if (pick === null || expires === undefined) return;
        if (await share(pick, perm, accounts, expires)) {
            setPick(null);
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
                            <p className="mt-1 max-w-md text-xs text-muted-foreground">{t("share.group.noGroupsMake")}</p>
                            <Button type="button" size="sm" className="mt-3" onClick={editor.openNew}>
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
                                        <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5">
                                            <span className="min-w-0 truncate text-sm text-foreground">{g.name}</span>
                                            <GroupKeeper group={g} />
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
                                    {g.member_names && <MemberNamesPopover title={t("share.group.membersOf", { name: g.name })} names={g.member_names} />}
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
                                <p>{t("share.group.noGroupsMake")}</p>
                                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={editor.openNew}>
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
                        <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                            <fieldset className="min-w-0 space-y-1.5">
                                <legend className="mb-1.5 text-xs text-muted-foreground">{t("share.group.pick")}</legend>
                                {choiceCount === 0 ? (
                                    <p className="text-sm text-muted-foreground">{t("share.group.allShared")}</p>
                                ) : (
                                    <>
                                        <GroupSearchBox s={search} />
                                        {search.visible.map((g) => (
                                            <label key={g.id} className={CHOICE_ROW}>
                                                <input type="radio" name="group-share-pick" checked={pick === g.id} onChange={() => setPick(g.id)} className="size-4 shrink-0 accent-primary" />
                                                <span className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate text-sm text-foreground" title={g.name}>{g.name}</span>
                                                    <GroupKeeper group={{ kind: g.kind, mine: g.kind === "personal", synced: g.synced }} />
                                                </span>
                                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("access.memberCount", { count: g.members })}</span>
                                            </label>
                                        ))}
                                        <GroupSearchFooter s={search} />
                                    </>
                                )}
                            </fieldset>
                            <Field label={t("share.thPermission")}>
                                <NativeSelect value={perm} onChange={(e) => setPerm(e.target.value as SharePermission)}>
                                    {(Object.keys(PERM_KEY) as SharePermission[]).map((p) => (
                                        <option key={p} value={p}>{t(PERM_KEY[p])}</option>
                                    ))}
                                </NativeSelect>
                            </Field>
                        </div>
                        {pick !== null && tunnelUsernames.length > 0 && (
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
                        {pick !== null && <ShareExpiryChoice preset={preset} date={date} onPreset={setPreset} onDate={setDate} />}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">{t("share.group.followsNote")}</p>
                            <Button type="submit" disabled={pick === null || busy || (preset === "date" && !date)}>
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
                    onNew={editor.openNew}
                    onEdit={editor.openEdit}
                    onDelete={editor.askDelete}
                />
            )}
            {editor.dialogs}

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

const RULES: TranslationKey[] = [
    "share.group.flow.rule1",
    "share.group.flow.rule2",
    "share.group.flow.rule3",
    "share.group.flow.rule4",
    "share.group.flow.rule5",
    "share.group.flow.rule6",
];

/** 群組分享怎麼運作：成員由管理員（或公司帳號同步）維護的群組，或你維護的群組 ─ 這條通道 ─ 每位成員。
 *  How group sharing works: a group admins keep (or synced from company accounts), or one you keep ─ this tunnel ─
 *  each member. */
export function GroupShareInfoDialog({ isOpen, onClose, share }: { isOpen: boolean; onClose: () => void; share: GroupShare | null }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<"org" | "personal" | null>(null);
    const kind = picked ?? share?.kind ?? "personal";
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
                        { value: "personal", label: t("peopleGroups.keeper.you"), icon: <User size={13} /> },
                        { value: "org", label: t("peopleGroups.keeper.admins"), icon: <Building2 size={13} /> },
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
                        title={real ? real.name : kind === "org" ? t("share.group.flow.group") : t("share.group.flow.yourGroup")}
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
