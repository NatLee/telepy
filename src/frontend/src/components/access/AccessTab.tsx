"use client";

/**
 * 設定頁「存取」分頁：誰可以用哪些 Telepy 功能（跟隧道分享無關）。左邊選對象（所有人 / 群組 / 人），右邊是那個對象的
 * 功能矩陣：每列一個功能，格子 = 沿用 / 允許 / 拒絕；「沿用」顯示會拿到什麼、從哪一層來。群組可以建立、改名、刪除、
 * 編輯成員。資訊按鈕打開兩條線的說明圖（AccessInfoDialog）。解析規則在 lib/features.ts（跟後端一樣、有測試）。
 * The Settings page's Access tab: who may use which Telepy features (unrelated to tunnel sharing). Pick a subject on
 * the left (everyone / a group / a person); the right side is its feature matrix (inherit / allow / deny per row,
 * "inherit" shows what it yields and from where). Groups can be created, renamed, deleted and given members. The info
 * button opens the two-lane explainer. Resolution lives in lib/features.ts (same rules as the backend, tested).
 */
import React, { useMemo, useState } from "react";
import {
    Ban,
    BookOpen,
    Check,
    Clapperboard,
    FolderOpen,
    Globe,
    Info,
    KeyRound,
    MonitorPlay,
    Pencil,
    Plug,
    Plus,
    ScreenShare,
    Search,
    Share2,
    Shield,
    ShieldCheck,
    TerminalSquare,
    Trash2,
    User,
    Users,
    Waypoints,
    Webhook,
    Wrench,
    X,
    type LucideIcon, KeySquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAccessPage } from "@/hooks/useAccessPage";
import {
    FEATURES,
    cellValue,
    deniedCount,
    filterUsers,
    resolveFeature,
    type AccessGroup,
    type AccessPolicy,
    type FeatureId,
    type GrantValue,
    type Resolution,
    type Subject,
} from "@/lib/features";
import type { TranslationKey } from "@/locales/en";
import { AccessInfoDialog } from "./AccessInfoDialog";

const FEATURE_ICON: Record<FeatureId, LucideIcon> = {
    "tunnels.create": Plus,
    "tunnels.share": Share2,
    terminal: TerminalSquare,
    toolbox: Wrench,
    files: FolderOpen,
    remote_browser: MonitorPlay,
    remote_desktop: ScreenShare,
    network: Waypoints,
    "keys.personal": KeyRound,
    "recordings.manage": Clapperboard,
    "command_rules.manage": ShieldCheck,
    "webhooks.personal": Webhook,
    "mcp.connect": Plug,
    "api.tokens": KeySquare,
    "api.docs": BookOpen,
};

const sameSubject = (a: Subject, b: Subject) => a.kind === b.kind && (a.kind === "everyone" || (b.kind !== "everyone" && a.id === b.id));

export function AccessTab({ initialUser }: { initialUser?: number | null }) {
    const { t } = useI18n();
    const page = useAccessPage();
    const [subject, setSubject] = useState<Subject>(initialUser ? { kind: "user", id: initialUser } : { kind: "everyone" });
    const [infoOpen, setInfoOpen] = useState(false);
    const [infoFeature, setInfoFeature] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const policy = page.policy;

    if (page.loading && !policy) {
        return (
            <div className="flex justify-center py-12 text-muted-foreground">
                <div className="mr-3 size-6 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden />
                {t("access.loading")}
            </div>
        );
    }
    if (!policy) return <Callout tone="danger">{t("access.loadFailed")}</Callout>;

    // 選的群組 / 人被刪掉了就回到「所有人」。/ Fall back to everyone when the picked group / person is gone.
    const exists =
        subject.kind === "everyone" ||
        (subject.kind === "group" ? policy.groups.some((g) => g.id === subject.id) : policy.users.some((u) => u.id === subject.id));
    const current: Subject = exists ? subject : { kind: "everyone" };
    const infoUser = current.kind === "user" ? current.id : null;
    const openInfo = (feature: string | null) => {
        setInfoFeature(feature);
        setInfoOpen(true);
    };

    return (
        <div className="space-y-6">
            <Callout tone="info" title={t("access.bannerTitle")}>
                <p>{t("access.banner")}</p>
                <Button type="button" variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => openInfo(null)}>
                    <Info size={14} /> {t("access.howItWorks")}
                </Button>
            </Callout>

            <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <SubjectList policy={policy} current={current} onPick={setSubject} onCreate={() => setCreating(true)} />
                <SubjectPanel
                    key={`${current.kind}-${current.kind === "everyone" ? 0 : current.id}`}
                    policy={policy}
                    subject={current}
                    saving={page.saving}
                    onGrant={(f, v) => page.setGrant(current, f, v)}
                    onUpdateGroup={page.updateGroup}
                    onDeleteGroup={async (id) => {
                        if (await page.deleteGroup(id)) setSubject({ kind: "everyone" });
                    }}
                    onInfo={openInfo}
                    onPick={setSubject}
                />
            </div>

            {infoOpen && <AccessInfoDialog isOpen onClose={() => setInfoOpen(false)} policy={policy} userId={infoUser} feature={infoFeature} />}
            {creating && (
                <GroupDialog
                    title={t("access.newGroup")}
                    saving={page.saving}
                    onClose={() => setCreating(false)}
                    onSave={async (name, description) => {
                        const id = await page.createGroup({ name, description });
                        if (id !== null) {
                            setCreating(false);
                            setSubject({ kind: "group", id });
                        }
                    }}
                />
            )}
        </div>
    );
}

/* ── 左邊：對象清單 / The subject list ─────────────────────────── */

function SubjectRow({ active, icon, label, sub, badge, onClick }: { active: boolean; icon: React.ReactNode; label: React.ReactNode; sub?: React.ReactNode; badge?: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "true" : undefined}
            className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                active ? "bg-muted text-foreground [&>svg]:text-primary" : "text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
        >
            {icon}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{label}</span>
                {sub && <span className="block break-words text-xs leading-snug text-muted-foreground">{sub}</span>}
            </span>
            {badge}
        </button>
    );
}

function OffBadge({ count }: { count: number }) {
    const { t } = useI18n();
    if (count === 0) return null;
    return (
        <Chip tone="danger" title={t("access.offCount", { count })}>
            <Ban aria-hidden />
            {count}
        </Chip>
    );
}

function SubjectList({ policy, current, onPick, onCreate }: { policy: AccessPolicy; current: Subject; onPick: (s: Subject) => void; onCreate: () => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const people = filterUsers(policy.users, query);
    return (
        <nav className="space-y-5 rounded-xl border border-border bg-card p-3 shadow-card" aria-label={t("access.subjectsAria")}>
            <div>
                <SubjectRow
                    active={current.kind === "everyone"}
                    icon={<Globe size={16} />}
                    label={t("access.everyone")}
                    sub={t("access.everyoneSub")}
                    badge={<OffBadge count={deniedCount(policy, { kind: "everyone" })} />}
                    onClick={() => onPick({ kind: "everyone" })}
                />
            </div>

            <div className="space-y-1">
                <div className="flex items-center justify-between px-2.5">
                    <span className="text-xs text-muted-foreground">{t("access.groups")}</span>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onCreate}>
                        <Plus size={14} /> {t("access.newGroupShort")}
                    </Button>
                </div>
                {policy.groups.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noGroups")}</p>}
                {policy.groups.map((g) => (
                    <SubjectRow
                        key={g.id}
                        active={sameSubject(current, { kind: "group", id: g.id })}
                        icon={<Users size={16} />}
                        label={g.name}
                        sub={t("access.memberCount", { count: g.members.length })}
                        badge={<OffBadge count={deniedCount(policy, { kind: "group", id: g.id })} />}
                        onClick={() => onPick({ kind: "group", id: g.id })}
                    />
                ))}
            </div>

            <div className="space-y-1">
                <span className="block px-2.5 text-xs text-muted-foreground">{t("access.people")}</span>
                {policy.users.length > 7 && (
                    <div className="relative px-1 pb-1">
                        <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("access.searchPeople")} className="h-8 pl-8" aria-label={t("access.searchPeople")} />
                    </div>
                )}
                {people.map((u) => (
                    <SubjectRow
                        key={u.id}
                        active={sameSubject(current, { kind: "user", id: u.id })}
                        icon={u.is_superuser ? <Shield size={16} /> : <User size={16} />}
                        label={u.username}
                        sub={u.is_superuser ? t("access.adminChip") : u.groups.length > 0 ? policy.groups.filter((g) => u.groups.includes(g.id)).map((g) => g.name).join(", ") : undefined}
                        badge={u.is_superuser ? undefined : <OffBadge count={deniedCount(policy, { kind: "user", id: u.id })} />}
                        onClick={() => onPick({ kind: "user", id: u.id })}
                    />
                ))}
            </div>
        </nav>
    );
}

/* ── 右邊：一個對象的功能矩陣 / One subject's feature matrix ───── */

function sourceText(t: (k: TranslationKey, v?: Record<string, string | number>) => string, r: Resolution, policy: AccessPolicy): string {
    if (r.from === "group") return t("access.src.group", { name: policy.groups.find((g) => g.id === r.groupId)?.name ?? "?" });
    return t(`access.src.${r.from}` as TranslationKey);
}

function SubjectPanel({
    policy,
    subject,
    saving,
    onGrant,
    onUpdateGroup,
    onDeleteGroup,
    onInfo,
    onPick,
}: {
    policy: AccessPolicy;
    subject: Subject;
    saving: boolean;
    onGrant: (feature: string, value: GrantValue) => void;
    onUpdateGroup: (id: number, draft: { name?: string; description?: string; members?: number[] }) => Promise<unknown>;
    onDeleteGroup: (id: number) => void;
    onInfo: (feature: string | null) => void;
    onPick: (s: Subject) => void;
}) {
    const { t } = useI18n();
    const group = subject.kind === "group" ? policy.groups.find((g) => g.id === subject.id) ?? null : null;
    const person = subject.kind === "user" ? policy.users.find((u) => u.id === subject.id) ?? null : null;
    const admin = !!person?.is_superuser;
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const title = subject.kind === "everyone" ? t("access.everyone") : group ? group.name : person?.username ?? "";
    const icon = subject.kind === "everyone" ? <Globe /> : group ? <Users /> : admin ? <Shield /> : <User />;
    const description = subject.kind === "everyone" ? t("access.everyoneHint") : group ? group.description || t("access.groupHint") : admin ? t("access.adminAlways") : t("access.userHint");

    return (
        <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 shadow-card sm:p-5">
            <SectionHeading
                as="h2"
                icon={icon}
                title={title}
                description={description}
                action={
                    group ? (
                        <div className="flex gap-1">
                            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={t("access.editGroup")} title={t("access.editGroup")}>
                                <Pencil />
                            </Button>
                            <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label={t("access.deleteGroup")} title={t("access.deleteGroup")}>
                                <Trash2 />
                            </Button>
                        </div>
                    ) : undefined
                }
            />

            {group && <MembersEditor policy={policy} group={group} saving={saving} onChange={(members) => onUpdateGroup(group.id, { members })} />}
            {person && !admin && (
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">{t("access.inGroups")}</span>
                    {person.groups.length === 0 && <span className="text-muted-foreground">{t("access.noGroupsForUser")}</span>}
                    {policy.groups.filter((g) => person.groups.includes(g.id)).map((g) => (
                        <button key={g.id} type="button" onClick={() => onPick({ kind: "group", id: g.id })} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <Chip className="hover:bg-muted/70"><Users aria-hidden />{g.name}</Chip>
                        </button>
                    ))}
                </div>
            )}

            {admin ? (
                <Callout tone="info">{t("access.adminAlwaysLong")}</Callout>
            ) : (
                <div className="space-y-2">
                    <SectionHeading title={t("access.matrixTitle")} description={t(subject.kind === "user" ? "access.matrixHintUser" : subject.kind === "group" ? "access.matrixHintGroup" : "access.matrixHintEveryone")} />
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {FEATURES.map((f) => (
                            <FeatureRow key={f.id} policy={policy} subject={subject} feature={f.id} fkey={f.key} saving={saving} onGrant={onGrant} onInfo={onInfo} />
                        ))}
                    </ul>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("access.sharingNote")}</p>
                </div>
            )}

            {editing && group && (
                <GroupDialog
                    title={t("access.editGroup")}
                    initialName={group.name}
                    initialDescription={group.description}
                    saving={saving}
                    onClose={() => setEditing(false)}
                    onSave={async (name, description) => {
                        if (await onUpdateGroup(group.id, { name, description })) setEditing(false);
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => {
                    setConfirmDelete(false);
                    if (group) onDeleteGroup(group.id);
                }}
                title={t("access.deleteGroup")}
                message={t("access.deleteGroupConfirm", { name: group?.name ?? "" })}
                confirmText={t("access.deleteGroup")}
                isDestructive
            />
        </section>
    );
}

function FeatureRow({ policy, subject, feature, fkey, saving, onGrant, onInfo }: { policy: AccessPolicy; subject: Subject; feature: FeatureId; fkey: string; saving: boolean; onGrant: (feature: string, value: GrantValue) => void; onInfo: (feature: string | null) => void }) {
    const { t } = useI18n();
    const value = cellValue(policy, subject, feature);
    const res = resolveFeature(policy, subject, feature);
    const Icon = FEATURE_ICON[feature];
    // 「沿用」時拿到什麼、從哪來；人自己設了 = 最終端。/ What inherit yields and from where; a person's own setting is final.
    const note =
        value === "inherit"
            ? t("access.inheritNote", { result: res.allowed ? t("access.result.on") : t("access.result.off"), from: sourceText(t, res, policy) })
            : subject.kind === "user"
              ? t("access.ownNoteUser")
              : subject.kind === "group"
                ? t("access.ownNoteGroup")
                : t("access.ownNoteEveryone");
    return (
        <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex min-w-0 items-start gap-2.5">
                <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                        {t(`access.f.${fkey}` as TranslationKey)}
                        {subject.kind === "user" && (
                            <Chip tone={res.allowed ? "success" : "danger"}>
                                {res.allowed ? <Check aria-hidden /> : <Ban aria-hidden />}
                                {res.allowed ? t("access.result.on") : t("access.result.off")}
                            </Chip>
                        )}
                    </p>
                    <p className="text-xs leading-snug text-muted-foreground">{t(`access.f.${fkey}Hint` as TranslationKey)}</p>
                </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-1 pl-6 sm:items-end sm:pl-0">
                <Segmented<GrantValue>
                    size="sm"
                    aria-label={t(`access.f.${fkey}` as TranslationKey)}
                    value={value}
                    onChange={(v) => !saving && v !== value && onGrant(feature, v)}
                    options={[
                        { value: "inherit", label: t("access.inherit") },
                        { value: "allow", label: t("access.allow"), icon: <Check size={13} /> },
                        { value: "deny", label: t("access.deny"), icon: <X size={13} /> },
                    ]}
                />
                <button type="button" onClick={() => onInfo(feature)} className="text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:text-right">
                    {note}
                </button>
            </div>
        </li>
    );
}

function MembersEditor({ policy, group, saving, onChange }: { policy: AccessPolicy; group: AccessGroup; saving: boolean; onChange: (members: number[]) => void }) {
    const { t } = useI18n();
    const members = useMemo(() => policy.users.filter((u) => group.members.includes(u.id)), [policy.users, group.members]);
    const others = policy.users.filter((u) => !group.members.includes(u.id));
    return (
        <div className="space-y-2">
            <SectionHeading title={t("access.members")} description={t("access.membersHint")} />
            <div className="flex flex-wrap items-center gap-1.5">
                {members.length === 0 && <span className="text-sm text-muted-foreground">{t("access.noMembers")}</span>}
                {members.map((u) => (
                    <Chip key={u.id} className="pr-0.5">
                        {u.is_superuser ? <Shield aria-hidden /> : <User aria-hidden />}
                        {u.username}
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => onChange(group.members.filter((id) => id !== u.id))}
                            className="grid size-4 place-items-center rounded-sm hover:bg-foreground/10"
                            aria-label={t("access.removeMember", { name: u.username })}
                            title={t("access.removeMember", { name: u.username })}
                        >
                            <X size={11} />
                        </button>
                    </Chip>
                ))}
            </div>
            {others.length > 0 && (
                <NativeSelect
                    className="h-8 w-full sm:w-64"
                    value=""
                    disabled={saving}
                    aria-label={t("access.addMember")}
                    onChange={(e) => {
                        const id = Number(e.target.value);
                        if (id) onChange([...group.members, id]);
                    }}
                >
                    <option value="">{t("access.addMember")}</option>
                    {others.map((u) => (
                        <option key={u.id} value={u.id}>{u.username}{u.is_superuser ? ` (${t("access.adminChip")})` : ""}</option>
                    ))}
                </NativeSelect>
            )}
        </div>
    );
}

function GroupDialog({ title, initialName = "", initialDescription = "", saving, onClose, onSave }: { title: string; initialName?: string; initialDescription?: string; saving: boolean; onClose: () => void; onSave: (name: string, description: string) => void }) {
    const { t } = useI18n();
    const [name, setName] = useState(initialName);
    const [description, setDescription] = useState(initialDescription);
    const valid = name.trim().length > 0 && name.trim().length <= 64;
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (valid && !saving) onSave(name.trim(), description.trim());
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
            </form>
        </Modal>
    );
}
