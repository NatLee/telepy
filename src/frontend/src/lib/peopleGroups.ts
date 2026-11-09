/**
 * 兩種人的群組：組織群組（管理員 / 單一登入 / SCIM 管，用在功能權限；打開「可以分享」才會出現在分享視窗）與
 * 個人群組（每個人自己做，只有自己看得到，只用來分享通道）。這裡是資料的解析、搜尋與「這個改變會讓誰多 / 少哪些
 * 通道」的整理。純函式，有測試。
 * Two kinds of people groups: organization groups (admins / single sign-on / SCIM; used for feature permissions,
 * shown in share dialogs only once "Can be shared" is on) and personal groups (anyone makes them, only they see them,
 * used only for sharing tunnels). Parsing, search and the "who gains / loses which tunnels" summary. Pure, tested.
 */

export type GroupPermission = "view" | "edit" | "admin";

const PERMS: GroupPermission[] = ["view", "edit", "admin"];

function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}
function ids(v: unknown): number[] {
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
}
function perm(v: unknown): GroupPermission {
    return PERMS.includes(v as GroupPermission) ? (v as GroupPermission) : "view";
}

/* ── 組織群組的分享 / An organization group's shares ───────────── */

export interface OrgGroupShare {
    id: number;
    tunnel_id: number;
    tunnel_name: string;
    owner: string;
    permission_type: GroupPermission;
    /** 經由這筆拿到存取的人數。/ Members holding access through it. */
    through: number;
    expires_at: string | null;
}

/** `GET /api/access` 的群組多了 `shareable` / `shares`；舊後端沒有 = 不能分享、沒有分享。
 *  The policy's groups gain `shareable` / `shares`; an older backend = not shareable, no shares. */
export function orgSharing(group: unknown): { shareable: boolean; shares: OrgGroupShare[] } {
    const g = obj(group);
    const shares = Array.isArray(g.shares) ? g.shares : [];
    return {
        shareable: g.shareable === true,
        shares: shares
            .map(obj)
            .filter((s) => typeof s.id === "number")
            .map((s) => ({
                id: num(s.id),
                tunnel_id: num(s.tunnel_id),
                tunnel_name: str(s.tunnel_name) || `#${num(s.tunnel_id)}`,
                owner: str(s.owner),
                permission_type: perm(s.permission_type),
                through: num(s.through),
                expires_at: typeof s.expires_at === "string" ? s.expires_at : null,
            })),
    };
}

/** SCIM 建的群組：說明是「Managed by … (SCIM)」。/ A group SCIM made: its description says "Managed by … (SCIM)". */
export function scimManaged(description: string): boolean {
    return /\(SCIM\)\s*$/.test(description);
}

/** 一個群組在功能權限上設了幾個允許、幾個拒絕。/ How many allows and denies a group sets on Feature access. */
export function ruleCounts(grants: Partial<Record<string, boolean>> | null | undefined): { allow: number; deny: number } {
    let allow = 0;
    let deny = 0;
    for (const v of Object.values(grants ?? {})) {
        if (v === true) allow += 1;
        else if (v === false) deny += 1;
    }
    return { allow, deny };
}

/* ── 個人群組 / Personal groups ────────────────────────────────── */

export interface PersonalGroupShare {
    id: number;
    tunnel_id: number;
    tunnel_name: string;
    /** 你已經看不到這條通道（後端不給名字；`tunnel_name` 是編號）。/ You can no longer see the tunnel (no name; `tunnel_name` is its id). */
    hidden: boolean;
    permission_type: GroupPermission;
    /** false = 暫停（群組主人已經不管這條通道）。/ false = paused (the group's owner no longer manages the tunnel). */
    active: boolean;
}

/** 我所在的群組裡、分享給它而我看得到的一條通道。/ A tunnel shared with a group I'm in, that I can see. */
export interface MemberOfTunnel {
    id: number;
    name: string;
    permission_type: GroupPermission;
    /** 我是經由這個群組拿到的（否則是自己的分享或別的群組）。/ I hold it through this group (else my own share or another group). */
    through: boolean;
}

/** 我所在的群組：別人的個人群組（可以退出），或開放分享的組織群組（唯讀）。/ A group I'm in. */
export interface MemberOfGroup {
    id: number;
    name: string;
    description: string;
    kind: "org" | "personal";
    /** 個人群組的主人；組織群組 = null。/ A personal group's owner; null for organization groups. */
    owner: string | null;
    /** 組織群組的成員由公司帳號同步。/ An organization group whose members are synced from company accounts. */
    synced: boolean;
    tunnels: MemberOfTunnel[];
}

export interface PersonalGroup {
    id: number;
    name: string;
    description: string;
    members: number[];
    member_names: string[];
    shares: PersonalGroupShare[];
    created_at: string;
}

export interface PickableUser {
    id: number;
    username: string;
    email: string;
}

export interface PersonalGroupList {
    groups: PersonalGroup[];
    /** 我所在的群組。/ The groups I'm in. */
    member_of: MemberOfGroup[];
    users: PickableUser[];
    /** 至少管得到一條通道的分享；否則不能放成員。/ Manages sharing on at least one tunnel; otherwise no members can be added. */
    can_share: boolean;
    limit: number;
    max_members: number;
}

export const EMPTY_PERSONAL: PersonalGroupList = { groups: [], member_of: [], users: [], can_share: true, limit: 50, max_members: 200 };

/** `GET /api/user/groups` → 型別（缺欄位給安全預設）。/ The answer → typed (safe defaults). */
export function parsePersonalGroups(v: unknown): PersonalGroupList & { created_id: number | null } {
    const o = obj(v);
    const groups = Array.isArray(o.groups) ? o.groups : [];
    const users = Array.isArray(o.users) ? o.users : [];
    return {
        groups: groups
            .map(obj)
            .filter((g) => typeof g.id === "number")
            .map((g) => ({
                id: num(g.id),
                name: str(g.name),
                description: str(g.description),
                members: ids(g.members),
                member_names: Array.isArray(g.member_names) ? g.member_names.filter((n): n is string => typeof n === "string") : [],
                shares: (Array.isArray(g.shares) ? g.shares : [])
                    .map(obj)
                    .filter((s) => typeof s.id === "number")
                    .map((s) => ({
                        id: num(s.id),
                        tunnel_id: num(s.tunnel_id),
                        tunnel_name: str(s.tunnel_name) || `#${num(s.tunnel_id)}`,
                        hidden: typeof s.tunnel_name !== "string" || s.tunnel_name === "",
                        permission_type: perm(s.permission_type),
                        active: s.active !== false,
                    })),
                created_at: str(g.created_at),
            })),
        member_of: (Array.isArray(o.member_of) ? o.member_of : [])
            .map(obj)
            .filter((g) => typeof g.id === "number")
            .map((g) => ({
                id: num(g.id),
                name: str(g.name),
                description: str(g.description),
                kind: g.kind === "personal" ? ("personal" as const) : ("org" as const),
                owner: typeof g.owner === "string" ? g.owner : null,
                synced: g.synced === true,
                tunnels: (Array.isArray(g.tunnels) ? g.tunnels : [])
                    .map(obj)
                    .filter((x) => typeof x.id === "number")
                    .map((x) => ({ id: num(x.id), name: str(x.name) || `#${num(x.id)}`, permission_type: perm(x.permission_type), through: x.through === true })),
            })),
        users: users
            .map(obj)
            .filter((u) => typeof u.id === "number")
            .map((u) => ({ id: num(u.id), username: str(u.username) || `#${num(u.id)}`, email: str(u.email) })),
        can_share: o.can_share !== false,
        limit: typeof o.limit === "number" && o.limit > 0 ? o.limit : EMPTY_PERSONAL.limit,
        max_members: typeof o.max_members === "number" && o.max_members > 0 ? o.max_members : EMPTY_PERSONAL.max_members,
        created_id: typeof o.created_id === "number" ? o.created_id : null,
    };
}

/** 名稱、說明或成員名稱有符合的群組（空白分開的字都要有）。/ Groups whose name, description or member names hold every word. */
export function filterNamedGroups<T extends { name: string; description: string; member_names?: string[] }>(groups: T[], query: string): T[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return groups;
    return groups.filter((g) => {
        const hay = [g.name, g.description, ...(g.member_names ?? [])].join("\n").toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/** 我所在的群組的搜尋：名稱、說明、主人、通道名稱（空白分開的字都要有）。/ Search the groups I'm in: name, description, owner, tunnel names. */
export function filterMemberOf(groups: MemberOfGroup[], query: string): MemberOfGroup[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return groups;
    return groups.filter((g) => {
        const hay = [g.name, g.description, g.owner ?? "", ...g.tunnels.map((x) => x.name)].join("\n").toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/** 名稱清單的搜尋（成員浮層用）。/ Search a list of names (the members popover). */
export function filterNames(names: string[], query: string): string[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return names;
    return names.filter((n) => words.every((w) => n.toLowerCase().includes(w)));
}

/** 太長的清單只列前 `max` 個，其餘折成「+N」。/ A long list shows the first `max`; the rest fold into "+N". */
export function foldList<T>(items: T[], max: number): { shown: T[]; more: number } {
    return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/* ── 誰維護成員 / Who keeps the members ───────────────────────── */

/**
 * 一般使用者只需要知道「群組的成員是誰在維護」：你、做這個群組的人、管理員，或從公司帳號同步。
 * 「組織群組 / 個人群組」這兩個詞只留在管理區。
 * All an ordinary user needs to know about a group is who keeps its members: you, the person who made it, admins,
 * or synced from company accounts. "Organization group" / "personal group" stay in the admin area.
 */
export type GroupKeeperKind = "you" | "owner" | "admins" | "synced";

export function groupKeeper(g: { kind: "org" | "personal"; mine?: boolean; synced?: boolean }): GroupKeeperKind {
    if (g.kind === "org") return g.synced ? "synced" : "admins";
    return g.mine ? "you" : "owner";
}

/** 群組名稱的檢查，跟後端一樣（1–64 字）。/ The name rule, as the backend (1–64 characters). */
export function nameProblem(name: string): "empty" | "long" | null {
    const n = name.trim();
    if (!n) return "empty";
    if ([...n].length > 64) return "long";
    return null;
}

/** 成員清單的差別。/ What changed in a member list. */
export function memberDiff(before: number[], after: number[]): { added: number; removed: number } {
    const b = new Set(before);
    const a = new Set(after);
    return { added: after.filter((id) => !b.has(id)).length, removed: before.filter((id) => !a.has(id)).length };
}

/* ── 影響預覽 / The impact preview ─────────────────────────────── */

export interface ImpactPerson {
    user_id: number;
    username: string;
    tunnels: { id: number; name: string }[];
}

export interface Impact {
    gain: ImpactPerson[];
    lose: ImpactPerson[];
    /** 會結束的群組分享。/ Group shares that would end. */
    shares: number;
}

function people(v: unknown): ImpactPerson[] {
    return (Array.isArray(v) ? v : [])
        .map(obj)
        .filter((p) => typeof p.user_id === "number")
        .map((p) => ({
            user_id: num(p.user_id),
            username: str(p.username) || `#${num(p.user_id)}`,
            tunnels: (Array.isArray(p.tunnels) ? p.tunnels : [])
                .map(obj)
                .filter((t) => typeof t.id === "number")
                .map((t) => ({ id: num(t.id), name: str(t.name) || `#${num(t.id)}` })),
        }))
        .filter((p) => p.tunnels.length > 0)
        .sort((a, b) => a.username.localeCompare(b.username));
}

/** `…/preview` 的回答 → 型別。/ The preview answer → typed. */
export function parseImpact(v: unknown): Impact {
    const o = obj(v);
    return { gain: people(o.gain), lose: people(o.lose), shares: num(o.shares) };
}

/** 沒有人多或少任何東西、也沒有分享會結束 = 不用問，直接存。/ Nobody gains or loses and no share ends = save without asking. */
export function impactEmpty(i: Impact): boolean {
    return i.gain.length === 0 && i.lose.length === 0 && i.shares === 0;
}

/** 摘要：幾個人多、幾個人少、牽涉幾條通道。/ The summary: people gaining, people losing, tunnels involved. */
export function impactSummary(i: Impact): { gainPeople: number; losePeople: number; tunnels: number; shares: number } {
    const tunnels = new Set<number>();
    for (const p of [...i.gain, ...i.lose]) p.tunnels.forEach((t) => tunnels.add(t.id));
    return { gainPeople: i.gain.length, losePeople: i.lose.length, tunnels: tunnels.size, shares: i.shares };
}

/** 一個人的通道名稱，太多時只列前幾個加「+N」。/ A person's tunnel names; past `max` the rest fold into "+N". */
export function tunnelList(p: ImpactPerson, max = 3): { names: string[]; more: number } {
    return { names: p.tunnels.slice(0, max).map((t) => t.name), more: Math.max(0, p.tunnels.length - max) };
}
