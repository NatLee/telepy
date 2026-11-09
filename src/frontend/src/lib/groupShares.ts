/**
 * 分享給使用者群組（`/api/reverse/server/{id}/group-shares`）的資料、整理與說明圖的狀態。純函式，有測試。
 * Tunnels shared with user groups: the data, tidying and the info diagram's states. Pure, tested.
 */
import type { SpotState } from "./flow.ts";

export type SharePermission = "view" | "edit" | "admin";

/** org = 管理員維護的群組（管理員 / 單一登入 / SCIM 放成員；從不是角色）；personal = 某個人自己的個人群組。/ org = an admin-kept group (never a role); personal = someone's own. */
export type GroupKind = "org" | "personal";

export interface GroupShare {
    id: number;
    group_id: number;
    name: string;
    /** 群組有幾個人。/ How many people the group has. */
    members: number;
    /** 成員名稱（只給能管分享的人）。/ Member names (only for those who manage sharing). */
    member_names: string[] | null;
    /** 經由這筆拿到存取的人數。/ Members holding access through it. */
    through: number;
    /** 另有直接分享、照自己那筆的人數。/ Members with a direct share of their own. */
    direct: number;
    /** 經由另一個群組分享拿到的人數（那一筆給的權限比較高）。/ Members holding it through another group share. */
    elsewhere: number;
    /** 通道擁有者也在群組裡（他不需要分享）。/ The tunnel's owner is in the group (needs no share). */
    owner_in: boolean;
    permission_type: SharePermission;
    expires_at: string | null;
    shared_by: string | null;
    created_at: string;
    allowed_target_usernames: { id: number; username: string }[];
    kind: GroupKind;
    /** 個人群組的主人（管理員維護的群組 = null）。/ A personal group's owner (null for admin-kept groups). */
    owner: string | null;
    /** 看的人自己的個人群組。/ A personal group owned by the viewer. */
    mine: boolean;
    /** false = 暫停：個人群組的主人已經不管這條通道，成員經由它拿不到東西。/ false = paused. */
    active: boolean;
    /** 管理員維護的群組，成員由公司帳號（單一登入 / SCIM）同步。/ An admin-kept group whose members are synced from company accounts. */
    synced: boolean;
}

export interface GroupChoice {
    id: number;
    name: string;
    members: number;
    shared: boolean;
    kind: GroupKind;
    /** 成員由公司帳號同步（只有管理員維護的群組會是 true）。/ Members synced from company accounts (admin-kept groups only). */
    synced: boolean;
}

export interface GroupShareList {
    can_manage: boolean;
    shares: GroupShare[];
    groups: GroupChoice[];
}

const PERMS: SharePermission[] = ["view", "edit", "admin"];

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 後端的回答 → 型別（缺欄位就給安全的預設）。/ The backend's answer → typed (safe defaults for missing fields). */
export function parseGroupShares(v: unknown): GroupShareList {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const shares = Array.isArray(o.shares) ? o.shares : [];
    const groups = Array.isArray(o.groups) ? o.groups : [];
    return {
        can_manage: o.can_manage === true,
        shares: shares.map((s) => {
            const r = (s ?? {}) as Record<string, unknown>;
            const perm = PERMS.includes(r.permission_type as SharePermission) ? (r.permission_type as SharePermission) : "view";
            return {
                id: num(r.id),
                group_id: num(r.group_id),
                name: typeof r.name === "string" ? r.name : "",
                members: num(r.members),
                member_names: Array.isArray(r.member_names) ? r.member_names.filter((n): n is string => typeof n === "string") : null,
                through: num(r.through),
                direct: num(r.direct),
                elsewhere: num(r.elsewhere),
                owner_in: r.owner_in === true,
                permission_type: perm,
                expires_at: typeof r.expires_at === "string" ? r.expires_at : null,
                shared_by: typeof r.shared_by === "string" ? r.shared_by : null,
                created_at: typeof r.created_at === "string" ? r.created_at : "",
                allowed_target_usernames: Array.isArray(r.allowed_target_usernames)
                    ? r.allowed_target_usernames
                          .map((a) => (a ?? {}) as Record<string, unknown>)
                          .filter((a) => typeof a.id === "number")
                          .map((a) => ({ id: a.id as number, username: typeof a.username === "string" ? a.username : `#${a.id}` }))
                    : [],
                kind: r.kind === "personal" ? ("personal" as const) : ("org" as const),
                owner: typeof r.owner === "string" ? r.owner : null,
                mine: r.mine === true,
                active: r.active !== false,
                synced: r.synced === true,
            };
        }),
        groups: groups
            .map((g) => (g ?? {}) as Record<string, unknown>)
            .filter((g) => typeof g.id === "number")
            .map((g) => ({
                id: g.id as number,
                name: typeof g.name === "string" ? g.name : "",
                members: num(g.members),
                shared: g.shared === true,
                kind: g.kind === "personal" ? ("personal" as const) : ("org" as const),
                synced: g.synced === true,
            })),
    };
}

/** 還沒分享過的群組（新增表單用）。/ Groups not shared yet (for the add form). */
export function pickableGroups(list: GroupShareList): GroupChoice[] {
    return list.groups.filter((g) => !g.shared);
}

/** 新增表單的選項：一張清單，自己做的群組在前，其他照名稱。選項裡的個人群組一定是看的人自己的。
 *  The add form's choices as one list: the groups you made first, then the rest, each by name. Personal choices
 *  are always the viewer's own. */
export function sortedChoices(list: GroupShareList): GroupChoice[] {
    const rank = (g: GroupChoice) => (g.kind === "personal" ? 0 : 1);
    return pickableGroups(list).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** 群組人數那一行的各段（只列有人的）。/ The parts of the member-count line (only non-empty ones). */
export function memberParts(share: GroupShare): ("direct" | "elsewhere" | "owner")[] {
    const out: ("direct" | "elsewhere" | "owner")[] = [];
    if (share.direct > 0) out.push("direct");
    if (share.elsewhere > 0) out.push("elsewhere");
    if (share.owner_in) out.push("owner");
    return out;
}

/** 說明圖各點的狀態：群組有人、分享在、有人經由它拿到。/ The diagram's states: the group has people, the share exists, someone holds it. */
export function groupShareSpots(share: GroupShare | null): { group: SpotState; share: SpotState; members: SpotState } {
    if (!share) return { group: "waiting", share: "waiting", members: "waiting" };
    if (!share.active) return { group: share.members > 0 ? "ok" : "waiting", share: "failed", members: "waiting" };
    return {
        group: share.members > 0 ? "ok" : "waiting",
        share: "ok",
        members: share.through > 0 || share.direct > 0 ? "ok" : "waiting",
    };
}

/** 同一個人有好幾個群組時：最高的權限、全部帳號、最晚的期限（任一不到期 = 不到期）——跟後端 `group_shares::wants` 一樣。
 * Several groups for one person: the highest permission, every account, the latest end (any without an end = none),
 * as the backend's `group_shares::wants`. */
export function mergeShares(shares: Pick<GroupShare, "permission_type" | "expires_at" | "allowed_target_usernames">[]): {
    permission: SharePermission;
    expiresAt: string | null;
    accounts: number[];
} | null {
    if (shares.length === 0) return null;
    let permission: SharePermission = "view";
    let expiresAt: string | null | undefined;
    const accounts = new Set<number>();
    for (const s of shares) {
        if (PERMS.indexOf(s.permission_type) > PERMS.indexOf(permission)) permission = s.permission_type;
        if (expiresAt === undefined) expiresAt = s.expires_at;
        else expiresAt = expiresAt === null || s.expires_at === null ? null : s.expires_at > expiresAt ? s.expires_at : expiresAt;
        s.allowed_target_usernames.forEach((a) => accounts.add(a.id));
    }
    return { permission, expiresAt: expiresAt ?? null, accounts: [...accounts].sort((a, b) => a - b) };
}
