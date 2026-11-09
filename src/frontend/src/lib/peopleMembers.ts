/**
 * 成員編輯（角色、管理員維護的群組、個人群組）與管理區人 / 角色 / 群組清單的純函式：找人（多個字都要有、不分
 * 大小寫）、「一次貼上好幾個」的解析、草稿與伺服器之間的增減（delta 路由只送這個，兩個管理員同時改也不會互相
 * 蓋掉）、清單排序、選中的那一筆在別頁時釘在最上面，以及使用者頁的角色 / 群組篩選。有測試。
 * Pure helpers for the member editors (roles, admin-kept groups, personal groups) and the admin people / role /
 * group lists: finding people (every word, case-insensitive), parsing "paste several", the delta between a draft and
 * the server (all the delta routes get, so two admins editing at once never overwrite each other), sorting, pinning
 * the selected row when it sits on another page, and the Users page's role / group filters. Tested.
 */

export interface MemberPerson {
    id: number;
    username: string;
    email: string;
    first_name?: string;
    last_name?: string;
    is_active?: boolean;
    is_superuser?: boolean;
}

function words(query: string): string[] {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 帳號、email、名、姓裡要有每一個字（不分大小寫）。/ Every word in the username, email, first or last name. */
export function personMatches(p: MemberPerson, query: string): boolean {
    const w = words(query);
    if (w.length === 0) return true;
    const hay = [p.username, p.email, p.first_name ?? "", p.last_name ?? ""].join("\n").toLowerCase();
    return w.every((x) => hay.includes(x));
}

/**
 * 加人的搜尋：符合、還不是成員的人，帳號完全相同的排第一、開頭相同的其次，其餘照帳號排；最多 `limit` 個。
 * The add search: matching people who aren't members yet — an exact username first, then prefixes, then the rest by
 * username; at most `limit`.
 */
export function addCandidates<T extends MemberPerson>(people: readonly T[], query: string, exclude: ReadonlySet<number>, limit = 8): T[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rank = (p: T) => {
        const u = p.username.toLowerCase();
        if (u === q || p.email.toLowerCase() === q) return 0;
        if (u.startsWith(q)) return 1;
        return 2;
    };
    return people
        .filter((p) => !exclude.has(p.id) && personMatches(p, query))
        .sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username))
        .slice(0, limit);
}

/** 貼上的文字 → 帳號或 email（逗號、分號、空白、換行分開；去掉重複，不分大小寫）。/ Pasted text → usernames or emails. */
export function parsePaste(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[\s,;]+/)) {
        // 「Name <a@b.c>」這種寫法：只留角括號裡的。/ "Name <a@b.c>": keep what is inside the brackets.
        const token = raw.replace(/^[<"'(]+|[>"')]+$/g, "").trim();
        if (!token) continue;
        const key = token.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(token);
    }
    return out;
}

export interface PasteResult {
    /** 找到、還不是成員的人（照貼上的順序）。/ Found and not members yet (in pasted order). */
    found: number[];
    /** 找到但已經是成員。/ Found but already members. */
    already: string[];
    /** 找不到的字。/ Tokens that matched nobody. */
    missing: string[];
}

/** 用帳號或 email 對照（不分大小寫）。/ Match each token against usernames and emails (case-insensitive). */
export function resolvePaste(tokens: readonly string[], people: readonly MemberPerson[], members: ReadonlySet<number>): PasteResult {
    const byName = new Map<string, MemberPerson>();
    for (const p of people) {
        byName.set(p.username.toLowerCase(), p);
        if (p.email) {
            const e = p.email.toLowerCase();
            if (!byName.has(e)) byName.set(e, p);
        }
    }
    const found: number[] = [];
    const already: string[] = [];
    const missing: string[] = [];
    const taken = new Set<number>();
    for (const tok of tokens) {
        const p = byName.get(tok.toLowerCase());
        if (!p) missing.push(tok);
        else if (members.has(p.id)) already.push(p.username);
        else if (!taken.has(p.id)) {
            taken.add(p.id);
            found.push(p.id);
        }
    }
    return { found, already, missing };
}

/** 伺服器上的成員 → 草稿的增減（delta 路由的 body）。/ Server members → the draft's delta (the delta routes' body). */
export function memberDelta(before: readonly number[], after: readonly number[]): { add: number[]; remove: number[] } {
    const b = new Set(before);
    const a = new Set(after);
    return { add: after.filter((id) => !b.has(id)), remove: before.filter((id) => !a.has(id)) };
}

/** 現在的成員套上增減（預覽的 body：整份名單）。/ Current members with a delta applied (the preview body: the whole list). */
export function applyDelta(members: readonly number[], delta: { add?: readonly number[]; remove?: readonly number[] }): number[] {
    const remove = new Set(delta.remove ?? []);
    const out = members.filter((id) => !remove.has(id));
    const have = new Set(out);
    for (const id of delta.add ?? []) {
        if (!remove.has(id) && !have.has(id)) {
            have.add(id);
            out.push(id);
        }
    }
    return out;
}

/**
 * 成員清單的列：伺服器上的成員加上草稿新加的；草稿拿掉的還留著（劃掉、可以復原）。新加的排最前面，其餘照帳號。
 * Member list rows: the server's members plus the draft's additions; removed ones stay (struck through, undoable).
 * Additions first, the rest by username.
 */
export function memberRows<T extends MemberPerson>(base: readonly number[], draft: readonly number[], byId: ReadonlyMap<number, T>): { id: number; person: T | null; state: "kept" | "added" | "removed" }[] {
    const inDraft = new Set(draft);
    const inBase = new Set(base);
    const rows = [
        ...draft.filter((id) => !inBase.has(id)).map((id) => ({ id, state: "added" as const })),
        ...base.map((id) => ({ id, state: inDraft.has(id) ? ("kept" as const) : ("removed" as const) })),
    ].map((r) => ({ ...r, person: byId.get(r.id) ?? null }));
    const name = (r: { id: number; person: T | null }) => r.person?.username ?? `#${r.id}`;
    return rows.sort((a, b) => Number(a.state !== "added") - Number(b.state !== "added") || name(a).localeCompare(name(b)));
}

/* ── 清單排序 / List sorting ─────────────────────────────────── */

export type GroupSort = "name" | "members";
export const GROUP_SORTS: readonly GroupSort[] = ["name", "members"];

/** 名稱（不分大小寫）或人數（多的在前，同數照名稱）。/ By name, or by member count (most first, then by name). */
export function sortGroups<T extends { name: string; members: readonly number[] }>(items: readonly T[], by: GroupSort): T[] {
    const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return [...items].sort(by === "members" ? (a, b) => b.members.length - a.members.length || byName(a, b) : byName);
}

/**
 * 選中的那一筆不在這一頁時要釘在最上面嗎（它在搜尋結果裡、但不在這頁的切片）。
 * Whether the selected item must be pinned on top: it is in the result but not on this page's slice.
 */
export function pinnedItem<T extends { id: number }>(shown: readonly T[], slice: readonly T[], current: number | null): T | null {
    if (current === null || slice.some((x) => x.id === current)) return null;
    return shown.find((x) => x.id === current) ?? null;
}

/* ── 使用者頁：角色 / 群組篩選 / The Users page's role / group filters ── */

/** 篩選值：任何（不篩）、沒有任何一個、或某一個的 id。/ A filter value: any (no filter), none, or one id. */
export type MemberFilter = "any" | "none" | number;

export interface Membership {
    roles: number[];
    groups: number[];
}

/** 每個人在哪些角色、哪些群組（從各自的成員清單反查）。/ Which roles and groups each person is in (from the member lists). */
export function membershipIndex(roles: readonly { id: number; members: readonly number[] }[], groups: readonly { id: number; members: readonly number[] }[]): Map<number, Membership> {
    const out = new Map<number, Membership>();
    const get = (id: number) => {
        let m = out.get(id);
        if (!m) {
            m = { roles: [], groups: [] };
            out.set(id, m);
        }
        return m;
    };
    for (const r of roles) for (const u of r.members) get(u).roles.push(r.id);
    for (const g of groups) for (const u of g.members) get(u).groups.push(g.id);
    return out;
}

function passes(ids: readonly number[], f: MemberFilter): boolean {
    if (f === "any") return true;
    if (f === "none") return ids.length === 0;
    return ids.includes(f);
}

/** 角色與群組篩選都要過。/ Passes both the role and the group filter. */
export function inMembership(m: Membership | undefined, role: MemberFilter, group: MemberFilter): boolean {
    return passes(m?.roles ?? [], role) && passes(m?.groups ?? [], group);
}

/** 篩選值 ↔ 字串（`<select>` / 網址）。/ A filter value ↔ a string. */
export function filterValue(v: string): MemberFilter {
    if (v === "none") return "none";
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : "any";
}

/** 篩選的那個角色 / 群組被刪了就回到「任何」。/ Back to "any" when the filtered role / group is gone. */
export function liveFilter(f: MemberFilter, ids: readonly number[]): MemberFilter {
    return typeof f === "number" && !ids.includes(f) ? "any" : f;
}

/**
 * 勾選：這一頁全選 / 全不選。`page` = 這頁的 id；全都勾了就全部拿掉，否則全部加上。
 * Ticking a page: when every id on it is selected they all go, otherwise they are all added.
 */
export function togglePage(selected: ReadonlySet<number>, page: readonly number[]): Set<number> {
    const next = new Set(selected);
    const all = page.length > 0 && page.every((id) => next.has(id));
    for (const id of page) {
        if (all) next.delete(id);
        else next.add(id);
    }
    return next;
}

/** 只留還在搜尋結果裡的勾選（篩選變了，看不到的不該被批次改到）。/ Keep only selections still in the result. */
export function keepVisible(selected: ReadonlySet<number>, visible: readonly number[]): Set<number> {
    const v = new Set(visible);
    return new Set([...selected].filter((id) => v.has(id)));
}

/** 批次加入：誰會真的被加（還不是成員）；批次移除：誰真的在裡面。/ Who a bulk add / remove really touches. */
export function bulkTouches(members: readonly number[], selected: readonly number[], op: "add" | "remove"): number[] {
    const m = new Set(members);
    return selected.filter((id) => (op === "add" ? !m.has(id) : m.has(id)));
}
