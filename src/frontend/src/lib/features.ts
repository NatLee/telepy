/**
 * 功能權限（誰可以用哪些 Telepy 功能）的純函式：功能清單、解析（跟後端 `features.rs` 同一套規則）、profile 檢查。
 * 跟隧道分享是兩件事：分享決定「哪些隧道」（VIEW / EDIT / ADMIN + 允許的帳號），這裡決定「哪些工具」。
 * 解析順序：管理員永遠全部都有 → 使用者自己的設定（最終端）→ 群組（任何一個拒絕就拒絕，否則任何一個允許）→ 所有人 → 預設。
 * Pure helpers for feature permissions: the feature list, resolution (the same rules as the backend's `features.rs`)
 * and the profile check. Orthogonal to tunnel sharing. Order: admins have everything → the user's own setting (the
 * leaf) → their groups (a deny in any group wins, else an allow) → everyone → the default.
 */

export type FeatureId =
    | "tunnels.create"
    | "tunnels.share"
    | "terminal"
    | "toolbox"
    | "files"
    | "remote_browser"
    | "remote_desktop"
    | "network"
    | "keys.personal"
    | "recordings.manage"
    | "command_rules.manage"
    | "webhooks.personal"
    | "mcp.connect"
    | "api.docs";

/** i18n key 的字尾（`access.f.<k>` / `access.f.<k>Hint`）。順序 = 矩陣的列順序（跟後端一樣）。
 *  The i18n key stem per feature; order = matrix row order (same as the backend). */
export const FEATURES: readonly { id: FeatureId; key: string }[] = [
    { id: "tunnels.create", key: "tunnelsCreate" },
    { id: "tunnels.share", key: "tunnelsShare" },
    { id: "terminal", key: "terminal" },
    { id: "toolbox", key: "toolbox" },
    { id: "files", key: "files" },
    { id: "remote_browser", key: "remoteBrowser" },
    { id: "remote_desktop", key: "remoteDesktop" },
    { id: "network", key: "network" },
    { id: "keys.personal", key: "keysPersonal" },
    { id: "recordings.manage", key: "recordings" },
    { id: "command_rules.manage", key: "commandRules" },
    { id: "webhooks.personal", key: "webhooks" },
    { id: "mcp.connect", key: "mcp" },
    { id: "api.docs", key: "apiDocs" },
];

export function featureKey(id: string): string {
    return FEATURES.find((f) => f.id === id)?.key ?? "unknown";
}

/** profile 能不能用這個功能。管理員 / 舊後端（沒有 `features`）= 可以。/ Whether the profile may use a feature. */
export function hasFeature(profile: { is_superuser?: boolean; features?: string[] } | null | undefined, id: FeatureId): boolean {
    if (!profile) return false;
    if (profile.is_superuser) return true;
    if (!Array.isArray(profile.features)) return true;
    return profile.features.includes(id);
}

/** 整頁屬於某個功能的路徑（被關掉就顯示說明而不是頁面）。/ Pages that belong to one feature (a notice replaces them when off). */
const PAGE_FEATURES: readonly [string, FeatureId][] = [
    ["/tunnels/create", "tunnels.create"],
    ["/tunnels/terminal", "terminal"],
    ["/tunnels/network", "network"],
    ["/tunnels/desktop", "remote_desktop"],
    ["/tunnels/recordings", "recordings.manage"],
    ["/tunnels/commands", "command_rules.manage"],
    ["/tunnels/webhooks", "webhooks.personal"],
    ["/tunnels/mcp", "mcp.connect"],
];

export function featureForPath(pathname: string | null | undefined): FeatureId | null {
    if (!pathname) return null;
    const hit = PAGE_FEATURES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
    return hit ? hit[1] : null;
}

// ---------------------------------------------------------------- the admin policy (GET /api/access)

export type Grants = Partial<Record<string, boolean>>;

export interface AccessGroup {
    id: number;
    name: string;
    description: string;
    created_at: string;
    members: number[];
    grants: Grants;
}

export interface AccessUser {
    id: number;
    username: string;
    email: string;
    is_superuser: boolean;
    is_active: boolean;
    groups: number[];
    grants: Grants;
}

export interface AccessPolicy {
    features: { id: string; default: boolean }[];
    everyone: Grants;
    groups: AccessGroup[];
    users: AccessUser[];
}

export type Subject = { kind: "everyone" } | { kind: "group"; id: number } | { kind: "user"; id: number };
export type GrantValue = "allow" | "deny" | "inherit";
export type Layer = "superuser" | "user" | "group" | "everyone" | "default";

/** 一層的設定：允許 / 拒絕 / 沒設定（null）。/ One layer's setting: allow / deny / not set (null). */
export interface Step {
    layer: Exclude<Layer, "superuser">;
    value: boolean | null;
    groupId?: number;
    name?: string;
}

export interface Resolution {
    allowed: boolean;
    from: Layer;
    groupId?: number;
    /** 由下往上：預設 → 所有人 → 各群組 → 使用者。/ Bottom-up: default → everyone → groups → user. */
    steps: Step[];
    /** 決定結果的那一步（`steps` 的索引；管理員 = -1）。/ Index of the deciding step (-1 for admins). */
    decided: number;
}

const val = (g: Grants | undefined, f: string): boolean | null => (g && typeof g[f] === "boolean" ? (g[f] as boolean) : null);

function featureDefault(policy: AccessPolicy, f: string): boolean {
    return policy.features.find((x) => x.id === f)?.default ?? true;
}

/** 這個對象自己在這個功能上的設定（矩陣格子的值）。/ The subject's own setting for a feature (the matrix cell). */
export function cellValue(policy: AccessPolicy, subject: Subject, f: string): GrantValue {
    let g: Grants | undefined;
    if (subject.kind === "everyone") g = policy.everyone;
    else if (subject.kind === "group") g = policy.groups.find((x) => x.id === subject.id)?.grants;
    else g = policy.users.find((x) => x.id === subject.id)?.grants;
    const v = val(g, f);
    return v === null ? "inherit" : v ? "allow" : "deny";
}

/**
 * 解析一個對象的一個功能。使用者 = 真正的有效值；群組 / 所有人 = 「沿用」時拿到的值（群組成員在沒有其他設定時拿到的）。
 * 群組依 id 排序，跟後端一樣，所以「從哪個群組來」兩邊一致。
 * Resolves one feature for a subject. For a user it is the effective value; for a group / everyone it is what
 * "inherit" yields (what a member gets with nothing else set). Groups in id order, like the backend.
 */
export function resolveFeature(policy: AccessPolicy, subject: Subject, f: string): Resolution {
    const steps: Step[] = [
        { layer: "default", value: featureDefault(policy, f) },
        { layer: "everyone", value: val(policy.everyone, f) },
    ];
    let userValue: boolean | null = null;
    let groups: AccessGroup[] = [];
    if (subject.kind === "group") {
        groups = policy.groups.filter((g) => g.id === subject.id);
    } else if (subject.kind === "user") {
        const u = policy.users.find((x) => x.id === subject.id);
        if (u?.is_superuser) {
            return { allowed: true, from: "superuser", steps, decided: -1 };
        }
        groups = policy.groups.filter((g) => u?.groups.includes(g.id)).sort((a, b) => a.id - b.id);
        userValue = val(u?.grants, f);
    }
    for (const g of groups) steps.push({ layer: "group", value: val(g.grants, f), groupId: g.id, name: g.name });
    if (subject.kind === "user") steps.push({ layer: "user", value: userValue });

    const pick = (i: number): Resolution => ({ allowed: steps[i].value as boolean, from: steps[i].layer, groupId: steps[i].groupId, steps, decided: i });
    const userIdx = steps.findIndex((s) => s.layer === "user");
    if (userIdx >= 0 && steps[userIdx].value !== null) return pick(userIdx);
    const deny = steps.findIndex((s) => s.layer === "group" && s.value === false);
    if (deny >= 0) return pick(deny);
    const allow = steps.findIndex((s) => s.layer === "group" && s.value === true);
    if (allow >= 0) return pick(allow);
    if (steps[1].value !== null) return pick(1);
    return pick(0);
}

/** 這個對象有幾個功能被關掉（清單上的小標）。/ How many features end up off for a subject (the list badge). */
export function deniedCount(policy: AccessPolicy, subject: Subject): number {
    return FEATURES.filter((f) => !resolveFeature(policy, subject, f.id).allowed).length;
}

/** 這個對象自己設了幾個（不是沿用）。/ How many settings the subject has of its own. */
export function overrideCount(policy: AccessPolicy, subject: Subject): number {
    return FEATURES.filter((f) => cellValue(policy, subject, f.id) !== "inherit").length;
}

/** PUT /api/access/grants 的 body。/ The body of PUT /api/access/grants. */
export function grantBody(subject: Subject, feature: string, value: GrantValue) {
    return { subject: subject.kind, id: subject.kind === "everyone" ? null : subject.id, feature, value };
}

/** 以名稱 / email 找人（不分大小寫）。/ Find people by name or email (case-insensitive). */
export function filterUsers(users: AccessUser[], query: string): AccessUser[] {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
}

/** 路徑圖一格的狀態：decides = 結果由它決定；overridden = 有設定但被後面那層蓋掉；unset = 沒設定。
 *  One diagram cell: decides = this layer decided; overridden = set but a later layer won; unset = not set. */
export type CellState = "decides" | "overridden" | "unset";

export interface LaneCell {
    value: boolean | null;
    state: CellState;
}

export interface Lane {
    default: LaneCell;
    everyone: LaneCell;
    groups: (LaneCell & { groupId: number; name: string })[];
    user: LaneCell;
    allowed: boolean;
    superuser: boolean;
}

/** 解析結果 → 「預設 → 所有人 → 群組 → 這個人 → 結果」那條線上每一格的狀態。/ A resolution → the cells of lane A. */
export function laneFor(res: Resolution): Lane {
    const cell = (i: number): LaneCell => {
        const s = res.steps[i];
        if (!s) return { value: null, state: "unset" };
        return { value: s.value, state: i === res.decided ? "decides" : s.value === null ? "unset" : "overridden" };
    };
    const userIdx = res.steps.findIndex((s) => s.layer === "user");
    return {
        default: cell(0),
        everyone: cell(1),
        groups: res.steps.flatMap((s, i) => (s.layer === "group" ? [{ ...cell(i), groupId: s.groupId ?? 0, name: s.name ?? "" }] : [])),
        user: userIdx >= 0 ? cell(userIdx) : { value: null, state: "unset" },
        allowed: res.allowed,
        superuser: res.from === "superuser",
    };
}
