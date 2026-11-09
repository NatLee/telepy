"use client";

/**
 * 管理區「功能權限」頁（以前是設定頁的「存取」分頁）：誰可以用哪些 Telepy 功能（跟通道分享是兩回事）。左邊選對象（所有人 / 群組 / 人），右邊是那個對象的
 * 功能矩陣：每列一個功能，格子 = 沿用 / 允許 / 拒絕；「沿用」顯示會拿到什麼、從哪一層來。這裡的「群組」是角色
 * （政策 JSON 的 `groups`）：建立、改名、刪除與成員在「角色」頁（這裡只連過去）。分享用的群組從不出現在這裡。資訊按鈕打開兩條線的說明圖（AccessInfoDialog）。解析規則在 lib/features.ts（跟後端一樣、有測試）。
 * The admin Feature access page (formerly the Settings page's Access tab): who may use which Telepy features (separate from tunnel sharing). Pick a subject on
 * the left (everyone / a group / a person); the right side is its feature matrix (inherit / allow / deny per row,
 * "inherit" shows what it yields and from where). The policy's `groups` are roles, made and given members on the
 * Roles page (linked from here); groups for sharing never appear here. The info
 * button opens the two-lane explainer. Resolution lives in lib/features.ts (same rules as the backend, tested).
 */
import React, { useState } from "react";
import Link from "next/link";
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
    Plug,
    Plus,
    ScreenShare,
    Search,
    Share2,
    Shield,
    ShieldCheck,
    TerminalSquare,
    User,
    Users,
    Waypoints,
    Webhook,
    Wrench,
    X,
    type LucideIcon, KeySquare, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { CompactRow, CountText, ListControls } from "@/components/groups/AdminGroupBits";
import { GROUP_SORTS, personMatches, pinnedItem, sortGroups, type GroupSort } from "@/lib/peopleMembers";
import { useAccessPage } from "@/hooks/useAccessPage";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import {
    FEATURES,
    cellValue,
    deniedCount,
    filterGroups,
    resolveFeature,
    type AccessGroup,
    type AccessPolicy,
    type AccessUser,
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

export function AccessTab({
    initialUser,
    initialGroup,
    header,
}: {
    initialUser?: number | null;
    /** 先選這個角色（`?group=`）。/ Start on this role (`?group=`). */
    initialGroup?: number | null;
    /** 頁首（拿到打開說明的函式）；給了就不畫上面的說明框。/ The page header (gets the explainer opener); replaces the banner. */
    header?: (openInfo: () => void) => React.ReactNode;
}) {
    const { t } = useI18n();
    const page = useAccessPage();
    const [subject, setSubject] = useState<Subject>(
        initialUser ? { kind: "user", id: initialUser } : initialGroup ? { kind: "group", id: initialGroup } : { kind: "everyone" },
    );
    const [infoOpen, setInfoOpen] = useState(false);
    const [infoFeature, setInfoFeature] = useState<string | null>(null);
    const policy = page.policy;

    // 說明圖要等政策載入才有內容；載入前的頁首按鈕先記下要開，載入後就開。/ The explainer needs the policy; a click before it loads opens it once loaded.
    const head = header?.(() => {
        setInfoFeature(null);
        setInfoOpen(true);
    });
    if (page.loading && !policy) {
        return (
            <div className="space-y-6">
                {head}
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
                {head}
                <Callout tone="danger">{t("access.loadFailed")}</Callout>
            </div>
        );
    }

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
            {head ?? (
                <Callout tone="info" title={t("access.bannerTitle")}>
                    <p>{t("access.banner")}</p>
                    <Button type="button" variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => openInfo(null)}>
                        <Info size={14} /> {t("access.howItWorks")}
                    </Button>
                </Callout>
            )}

            <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <SubjectList policy={policy} current={current} onPick={setSubject} />
                <SubjectPanel
                    key={`${current.kind}-${current.kind === "everyone" ? 0 : current.id}`}
                    policy={policy}
                    subject={current}
                    saving={page.saving}
                    onGrant={(f, v) => page.setGrant(current, f, v)}
                    onInfo={openInfo}
                    onPick={setSubject}
                />
            </div>

            {infoOpen && <AccessInfoDialog isOpen onClose={() => setInfoOpen(false)} policy={policy} userId={infoUser} feature={infoFeature} />}
        </div>
    );
}

/* ── 左邊：對象清單 / The subject list ─────────────────────────── */

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

/** 清單超過這個數才有搜尋。/ The search shows from this many on. */
const SEARCH_FROM = 7;

type SubjectTab = "roles" | "people";
const SUBJECT_TABS: readonly SubjectTab[] = ["roles", "people"];

/** 「所有人」釘在最上面，下面分「角色 | 人」兩個分頁，各自搜尋、分頁（分頁記在瀏覽器）。
 *  Everyone pinned on top, then a Roles | People switch, each with its own search and pages (the tab is remembered). */
function SubjectList({ policy, current, onPick }: { policy: AccessPolicy; current: Subject; onPick: (s: Subject) => void }) {
    const { t } = useI18n();
    const [stored, setStored] = useStoredChoice<SubjectTab>("telepy.accessSubjectTab", SUBJECT_TABS, "roles");
    // 選中的對象（網址 ?user= / ?group=、矩陣上點角色）決定要看哪個分頁。/ The picked subject decides the tab.
    const kindTab = (s: Subject): SubjectTab | null => (s.kind === "group" ? "roles" : s.kind === "user" ? "people" : null);
    const [forced, setForced] = useState<SubjectTab | null>(kindTab(current));
    const [lastKind, setLastKind] = useState(current.kind);
    if (lastKind !== current.kind) {
        setLastKind(current.kind);
        const k = kindTab(current);
        if (k) setForced(k);
    }
    const tab = forced ?? stored;
    const setTab = (v: SubjectTab) => {
        setForced(null);
        setStored(v);
    };
    return (
        <nav className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-card" aria-label={t("access.subjectsAria")}>
            <CompactRow
                active={current.kind === "everyone"}
                icon={<Globe size={15} className="shrink-0" />}
                label={t("access.everyone")}
                title={t("access.everyoneSub")}
                badge={<OffBadge count={deniedCount(policy, { kind: "everyone" })} />}
                onClick={() => onPick({ kind: "everyone" })}
            />
            <Segmented<SubjectTab>
                size="sm"
                fullWidth
                aria-label={t("access.subjectsAria")}
                value={tab}
                onChange={setTab}
                options={[
                    { value: "roles", label: `${t("access.groups")} (${policy.groups.length})` },
                    { value: "people", label: `${t("access.people")} (${policy.users.length})` },
                ]}
            />
            {tab === "roles" ? <RoleSubjects policy={policy} current={current} onPick={onPick} /> : <PeopleSubjects policy={policy} current={current} onPick={onPick} />}
        </nav>
    );
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
    return (
        <div className="relative px-1">
            <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} className="h-8 pl-8" aria-label={label} />
        </div>
    );
}

function RoleSubjects({ policy, current, onPick }: { policy: AccessPolicy; current: Subject; onPick: (s: Subject) => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const [sort, setSort] = useStoredChoice<GroupSort>("telepy.accessGroupsPageSize.sort", GROUP_SORTS, "name");
    const roles = sortGroups(filterGroups(policy.groups, query), sort);
    const pager = usePagination(roles.length, { storageKey: "telepy.accessGroupsPageSize", resetKey: `${query}|${sort}` });
    const slice = pageSlice(roles, pager.page, pager.size);
    const pinned = pinnedItem(roles, slice, current.kind === "group" ? current.id : null);
    const row = (g: AccessGroup, isPinned = false) => (
        <CompactRow
            key={`${isPinned ? "pin-" : ""}${g.id}`}
            active={sameSubject(current, { kind: "group", id: g.id })}
            pinned={isPinned}
            icon={<BadgeCheck size={15} className="shrink-0" />}
            label={g.name}
            counts={<CountText icon={Users} count={g.members.length} label={t("access.memberCount", { count: g.members.length })} />}
            badge={<OffBadge count={deniedCount(policy, { kind: "group", id: g.id })} />}
            onClick={() => onPick({ kind: "group", id: g.id })}
        />
    );
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs text-muted-foreground tabular-nums">{query.trim() ? `${roles.length}/${policy.groups.length}` : ""}</span>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2">
                    <Link href="/tunnels/admin/roles?new=1" title={t("access.newGroupOnPage")}>
                        <Plus size={14} /> {t("access.newGroupShort")}
                    </Link>
                </Button>
            </div>
            {policy.groups.length >= SEARCH_FROM && <SearchBox value={query} onChange={setQuery} label={t("roles.search")} />}
            {policy.groups.length >= 2 && <ListControls sort={sort} onSort={setSort} pager={pager} />}
            {policy.groups.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noGroups")}</p>}
            {policy.groups.length > 0 && roles.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noMatch")}</p>}
            <div className="space-y-0.5">
                {pinned && <div className="border-b border-border/70 pb-0.5">{row(pinned, true)}</div>}
                {slice.map((g) => row(g))}
            </div>
            <Pagination pager={pager} compact className="justify-center pt-1" />
        </div>
    );
}

function PeopleSubjects({ policy, current, onPick }: { policy: AccessPolicy; current: Subject; onPick: (s: Subject) => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const people = policy.users.filter((u) => personMatches(u, query));
    const pager = usePagination(people.length, { storageKey: "telepy.accessPeoplePageSize", resetKey: query });
    const slice = pageSlice(people, pager.page, pager.size);
    const pinned = pinnedItem(people, slice, current.kind === "user" ? current.id : null);
    const row = (u: AccessUser, isPinned = false) => {
        const roleNames = policy.groups.filter((g) => u.groups.includes(g.id)).map((g) => g.name);
        return (
            <CompactRow
                key={`${isPinned ? "pin-" : ""}${u.id}`}
                active={sameSubject(current, { kind: "user", id: u.id })}
                pinned={isPinned}
                icon={u.is_superuser ? <Shield size={15} className="shrink-0" /> : <User size={15} className="shrink-0" />}
                label={u.username}
                title={u.is_superuser ? t("access.adminChip") : roleNames.join(", ") || undefined}
                counts={
                    u.is_superuser ? (
                        <span>{t("access.adminChip")}</span>
                    ) : roleNames.length > 0 ? (
                        <CountText icon={BadgeCheck} count={roleNames.length} label={t("members.roleCount", { count: roleNames.length })} />
                    ) : undefined
                }
                badge={u.is_superuser ? undefined : <OffBadge count={deniedCount(policy, { kind: "user", id: u.id })} />}
                onClick={() => onPick({ kind: "user", id: u.id })}
            />
        );
    };
    return (
        <div className="space-y-2">
            {policy.users.length >= SEARCH_FROM && <SearchBox value={query} onChange={setQuery} label={t("members.searchPeople")} />}
            {query.trim() && <p className="px-2.5 text-xs text-muted-foreground tabular-nums">{`${people.length}/${policy.users.length}`}</p>}
            <ListControls pager={pager} />
            {people.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("access.noMatch")}</p>}
            <div className="space-y-0.5">
                {pinned && <div className="border-b border-border/70 pb-0.5">{row(pinned, true)}</div>}
                {slice.map((u) => row(u))}
            </div>
            <Pagination pager={pager} compact className="justify-center pt-1" />
        </div>
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
    onInfo,
    onPick,
}: {
    policy: AccessPolicy;
    subject: Subject;
    saving: boolean;
    onGrant: (feature: string, value: GrantValue) => void;
    onInfo: (feature: string | null) => void;
    onPick: (s: Subject) => void;
}) {
    const { t } = useI18n();
    const group = subject.kind === "group" ? policy.groups.find((g) => g.id === subject.id) ?? null : null;
    const person = subject.kind === "user" ? policy.users.find((u) => u.id === subject.id) ?? null : null;
    const admin = !!person?.is_superuser;

    const title = subject.kind === "everyone" ? t("access.everyone") : group ? group.name : person?.username ?? "";
    const icon = subject.kind === "everyone" ? <Globe /> : group ? <BadgeCheck /> : admin ? <Shield /> : <User />;
    const description =
        subject.kind === "everyone"
            ? t("access.everyoneHint")
            : group
              ? group.description || t("access.groupHint")
              : admin
                ? person?.sso_admin
                    ? `${t("access.adminAlways")} ${t("access.adminViaSso", { provider: person.sso_admin })}`
                    : t("access.adminAlways")
                : t("access.userHint");

    return (
        <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 shadow-card sm:p-5">
            <SectionHeading
                as="h2"
                icon={icon}
                title={title}
                description={description}
                action={
                    group ? (
                        <Button asChild variant="outline" size="sm">
                            <Link href={`/tunnels/admin/roles?role=${group.id}`}>
                                <BadgeCheck size={14} /> {t("access.editOnGroups")}
                            </Link>
                        </Button>
                    ) : undefined
                }
            />

            {group && (
                <div className="space-y-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                        <Chip><Users aria-hidden />{t("access.memberCount", { count: group.members.length })}</Chip>
                        <span className="text-muted-foreground">{t("access.groupMembersHere")}</span>
                    </p>
                    {(group.sso_members?.length ?? 0) > 0 && <p className="text-xs text-muted-foreground">{t("access.ssoMembersHint")}</p>}
                </div>
            )}
            {person && !admin && (
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">{t("access.inGroups")}</span>
                    {person.groups.length === 0 && <span className="text-muted-foreground">{t("access.noGroupsForUser")}</span>}
                    {policy.groups.filter((g) => person.groups.includes(g.id)).map((g) => (
                        <button key={g.id} type="button" onClick={() => onPick({ kind: "group", id: g.id })} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <Chip className="hover:bg-muted/70"><BadgeCheck aria-hidden />{g.name}</Chip>
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
