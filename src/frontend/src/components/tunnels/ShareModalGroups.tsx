"use client";

/**
 * 分享彈窗的「群組」分頁：通道分享給哪些使用者群組（每個群組的權限、帳號、期限、成員）與新增；資訊鈕打開群組分享的說明圖。
 * The share dialog's Groups tab: the user groups a tunnel is shared with (permission, accounts, end, members) and the
 * add form; the info button opens the group sharing diagram.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Building2, CircleHelp, Pencil, Share2, UserCog, Users, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Section } from "@/components/ui/section";
import { Modal } from "@/components/ui/Modal";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { ShareExpiryChoice, ShareExpiryControl } from "@/components/tunnels/ShareExpiry";
import { ShareModalEditTargetUsersModal } from "@/components/tunnels/ShareModalEditTargetUsersModal";
import { useGroupShares } from "@/hooks/useGroupShares";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { groupShareSpots, otherMembers, pickableGroups, type GroupShare, type SharePermission } from "@/lib/groupShares";
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
    const isAdmin = !!useAuth().user?.is_superuser;
    const { list, busy, share, update, remove } = useGroupShares(tunnelId, isOpen, onChanged);
    const [pick, setPick] = useState("");
    const [perm, setPerm] = useState<SharePermission>("view");
    const [accounts, setAccounts] = useState<number[]>([]);
    const [preset, setPreset] = useState<ShareExpiryPreset>("never");
    const [date, setDate] = useState("");
    const [editing, setEditing] = useState<{ id: number; name: string; allowedIds: number[] } | null>(null);
    const [removing, setRemoving] = useState<GroupShare | null>(null);
    const [info, setInfo] = useState(false);

    if (!list) return null;
    const manage = list.can_manage && !readOnly;
    const canAdd = manage && !locked;
    const choices = pickableGroups(list);

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
                </div>
            ) : (
                <ul className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-border/80" data-refresh-list>
                    {list.shares.map((g) => {
                        const others = otherMembers(g);
                        return (
                            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
                                <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                                        <Users size={16} />
                                    </span>
                                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                                        <span className="max-w-full truncate text-sm text-foreground">{g.name}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {t("share.group.counts", { members: g.members, through: g.through })}
                                            {g.direct > 0 && <> · {t("share.group.direct", { count: g.direct })}</>}
                                            {others > 0 && <> · {t("share.group.others", { count: others })}</>}
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
                                                <p className="mb-2 text-xs text-muted-foreground">{t("share.group.membersOf", { name: g.name })}</p>
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
                                        className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground ring-1 ring-inset ring-border transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-default"
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

            {canAdd &&
                (list.groups.length === 0 ? (
                    <Callout tone="info" title={t("share.group.noGroups")}>
                        {isAdmin ? (
                            <Link href="/tunnels/admin/access" className="underline underline-offset-2">
                                {t("share.group.makeGroups")}
                            </Link>
                        ) : (
                            t("share.group.askAdmin")
                        )}
                    </Callout>
                ) : (
                    <form onSubmit={submit} className="space-y-3 rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-border/80">
                        <p className="flex items-center gap-2 text-sm">
                            <Share2 size={15} className="text-muted-foreground" aria-hidden /> {t("share.group.add")}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                            <Field label={t("share.group.pick")}>
                                <NativeSelect value={pick} onChange={(e) => setPick(e.target.value)} disabled={choices.length === 0}>
                                    <option value="">{choices.length === 0 ? t("share.group.allShared") : t("share.group.pickPlaceholder")}</option>
                                    {choices.map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {t("share.group.choice", { name: g.name, count: g.members })}
                                        </option>
                                    ))}
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

const RULES: TranslationKey[] = ["share.group.flow.rule1", "share.group.flow.rule2", "share.group.flow.rule3", "share.group.flow.rule4", "share.group.flow.rule5"];

/** 群組分享怎麼運作：身分提供者的群組 ─ Telepy 使用者群組 ─ 分享 ─ 每位成員。/ How group sharing works. */
export function GroupShareInfoDialog({ isOpen, onClose, share }: { isOpen: boolean; onClose: () => void; share: GroupShare | null }) {
    const { t } = useI18n();
    const spots = groupShareSpots(share);
    const perm = share ? t(PERM_KEY[share.permission_type]) : t("share.permView");
    const accounts = share ? share.allowed_target_usernames.map((a) => a.username).join(", ") || t("share.group.noAccounts") : "ubuntu";
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("share.group.flow.title")} description={t("share.group.flow.description")} icon={<Users />} size="5xl">
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Building2} title={t("share.group.flow.provider")} sub={t("share.group.flow.providerSub")} state="waiting" stateText={t("share.group.flow.optional")} />
                    <FlowLink compact label={t("share.group.flow.sync")} state="waiting" />
                    <FlowNode
                        icon={Users}
                        title={share ? share.name : t("share.group.flow.group")}
                        sub={share ? t("share.group.flow.groupCount", { count: share.members }) : t("share.group.flow.groupSub")}
                        state={spots.group}
                    />
                    <FlowLink compact label={t("share.group.flow.shared")} state={spots.share} />
                    <FlowNode icon={Share2} title={t("share.group.flow.share")} sub={t("share.group.flow.shareSub", { permission: perm, accounts })} state={spots.share} />
                    <FlowLink compact label={t("share.group.flow.each")} state={spots.members} />
                    <FlowNode
                        icon={UsersRound}
                        title={t("share.group.flow.members")}
                        sub={share ? t("share.group.flow.membersCount", { through: share.through, direct: share.direct }) : t("share.group.flow.membersSub")}
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
