/**
 * 多台裝置一次寫進 ~/.ssh/config（`GET /tunnels/server/config`）的純函式：把後端的 config 依裝置拆開、挑出勾選的、
 * 從金鑰矩陣判斷「我的金鑰進不進得去」。不碰 React。
 * Pure helpers for the bulk ~/.ssh/config (`GET /tunnels/server/config`): split the backend's config per device,
 * pick the ticked ones, and tell from the key matrix whether my keys get in. No React.
 */
import { parseStanzas, type ConfigStanza } from "./sshConfig.ts";
import type { DeviceKeys, KeyDevice } from "../types/keys.ts";

export type BulkAccounts = "default" | "all";

export interface BulkConfigHost {
    alias: string;
    username: string;
    username_id: number;
}

export interface BulkConfigTunnel {
    id: number;
    name: string;
    reverse_port: number;
    hosts: BulkConfigHost[];
    usernames: { id: number; username: string }[];
    /** 隧道的預設帳號（我能用時）。/ The tunnel's default account, when I may use it. */
    default_username_id?: number | null;
    /** 這台的帳號是 `pick` 指定的。/ This device's accounts came from `pick`. */
    picked?: boolean;
}

export interface BulkConfigData {
    config: string;
    server: { alias: string; host: string; port: string; legacy_alias?: string };
    accounts: BulkAccounts;
    /** 我的裝置別名前綴（個人設定，空 = 不加）。/ My device alias prefix (personal setting; empty = none). */
    alias_prefix?: string;
    tunnels: BulkConfigTunnel[];
    skipped: { id: number; name: string; reason: "no_accounts" }[];
    known_hosts: string;
    known_hosts_path: string;
    transport: "ssh" | "auto" | "websocket";
    ws_url: string;
    ws_client_url: string;
    ws_client_path: string;
}

export interface SplitConfig {
    server: ConfigStanza | null;
    /** 裝置 id → 它的 Host 區塊（照後端的順序）。/ Device id → its stanzas, in the backend's order. */
    byTunnel: Map<number, ConfigStanza[]>;
}

/** 依 `tunnels[].hosts` 的別名把 config 拆成伺服器區塊 + 每台的區塊。/ Split the config by the aliases in `tunnels[].hosts`. */
export function splitBulkConfig(data: Pick<BulkConfigData, "config" | "server" | "tunnels">): SplitConfig {
    const owner = new Map<string, number>();
    for (const t of data.tunnels) for (const h of t.hosts) owner.set(h.alias, t.id);
    const byTunnel = new Map<number, ConfigStanza[]>();
    let server: ConfigStanza | null = null;
    for (const s of parseStanzas(data.config)) {
        if (s.alias === data.server.alias) {
            server = s;
            continue;
        }
        const id = owner.get(s.alias);
        if (id === undefined) continue;
        byTunnel.set(id, [...(byTunnel.get(id) ?? []), s]);
    }
    return { server, byTunnel };
}

/** 勾選的裝置的區塊，照清單順序（= 依名稱）。/ The ticked devices' stanzas in list order (= by name). */
export function pickStanzas(split: SplitConfig, order: number[], selected: ReadonlySet<number>): ConfigStanza[] {
    return order.filter((id) => selected.has(id)).flatMap((id) => split.byTunnel.get(id) ?? []);
}

/**
 * 我的金鑰在一台裝置上的狀態（只看 config 要用的帳號）：ready = 每個帳號都裝好了；installing = 在清單上、還在裝；
 * error = 有帳號失敗；missing = 有帳號不在清單上；unknown = 矩陣裡沒有這台（還沒載入）。
 * My keys on one device, for the accounts the config uses: ready = installed everywhere; installing = listed, on its
 * way; error = an account failed; missing = an account is not covered by the list; unknown = not in the matrix yet.
 */
export type DeviceAccess = "ready" | "installing" | "error" | "missing" | "unknown";

export function deviceAccess(device: KeyDevice | undefined, usernames: string[]): DeviceAccess {
    if (!device || usernames.length === 0) return "unknown";
    const ids = new Map(device.account_list.map((a) => [a.username, a.id]));
    const per = usernames.map((name): DeviceAccess => {
        const statuses = device.keys.flatMap((k) => k.targets.filter((t) => t.username === name).map((t) => t.status));
        if (statuses.includes("installed")) return "ready";
        if (statuses.includes("error")) return "error";
        if (statuses.includes("pending")) return "installing";
        // 在清單上但還沒讀過裝置：只要清單涵蓋這個帳號就算「在裝」。只經由金鑰群組的那把 `accounts` 是 null，
        // 要看群組自己的帳號名稱。/ Listed but not read yet: covered = on its way. A group-only key has `accounts: null`,
        // so its groups' own account names decide.
        const id = ids.get(name);
        const covered = device.keys.some(
            (k) =>
                ((k.direct ?? true) && (k.accounts === null || (id !== undefined && k.accounts.includes(id)))) ||
                (k.groups ?? []).some((g) => g.accounts === null || g.accounts.includes(name))
        );
        return covered ? "installing" : "missing";
    });
    if (per.every((s) => s === "ready")) return "ready";
    if (per.includes("error")) return "error";
    if (per.includes("missing")) return "missing";
    return "installing";
}

/**
 * 我的一把金鑰怎麼到這台的帳號：直接在清單上（`accounts` = 只裝到這些帳號 id，null = 我能用的全部）或經由金鑰群組
 * （每個授予的帳號名稱，null = 全部）。
 * How one of my keys reaches this device's accounts: listed directly (`accounts` = chosen ids, null = every account
 * I may use) or through key groups (each grant's account names, null = all).
 */
export interface KeyReach {
    id: number;
    direct: boolean;
    accounts: number[] | null;
    groups: (string[] | null)[];
}

/**
 * 「把我的金鑰加上去」要做的事——只裝到 config 用的帳號，不是我在這台能用的每個帳號。`add` = 還沒直接在清單上的
 * 金鑰，一次加進來、只裝到 `addAccounts`；`widen` = 直接在清單上但帳號不夠的，改成原本的 + 缺的；`accounts` = 至少
 * 會多一把金鑰的帳號（提示上列的那些）。
 * What "add my keys" does — only into the accounts the config uses, never every account I may use there. `add` =
 * keys not listed directly, added limited to `addAccounts`; `widen` = listed directly with too few accounts, widened
 * to theirs + the missing ones; `accounts` = the accounts that gain at least one key (what the hint lists).
 */
export interface KeyPlan {
    add: number[];
    addAccounts: number[];
    widen: { keyId: number; accounts: number[] }[];
    accounts: { id: number; username: string }[];
}

export const EMPTY_PLAN: KeyPlan = { add: [], addAccounts: [], widen: [], accounts: [] };

export function planIsEmpty(plan: KeyPlan): boolean {
    return plan.add.length === 0 && plan.widen.length === 0;
}

/** 計畫會動到幾把金鑰。/ How many keys the plan touches. */
export function planKeyCount(plan: KeyPlan): number {
    return plan.add.length + plan.widen.length;
}

export function keyPlan(listed: KeyReach[], myKeyIds: number[], hosts: { username: string; username_id: number }[]): KeyPlan {
    if (hosts.length === 0) return EMPTY_PLAN;
    const byId = new Map(listed.map((k) => [k.id, k]));
    const configIds = [...new Set(hosts.map((h) => h.username_id))].sort((a, b) => a - b);
    const plan: KeyPlan = { add: [], addAccounts: configIds, widen: [], accounts: [] };
    const gaining = new Set<number>();
    for (const id of myKeyIds) {
        const k = byId.get(id);
        const reaches = (h: { username: string; username_id: number }) =>
            !!k &&
            ((k.direct && (k.accounts === null || k.accounts.includes(h.username_id))) ||
                k.groups.some((g) => g === null || g.includes(h.username)));
        const lacking = hosts.filter((h) => !reaches(h));
        if (lacking.length === 0) continue;
        for (const h of lacking) gaining.add(h.username_id);
        // 直接在清單上（帳號有限）就加寬；沒在清單上或只經由群組來 = 直接加一筆。
        // Listed directly (limited) → widen; not listed, or only through groups → add a direct entry.
        if (k?.direct && k.accounts !== null) {
            const accounts = [...new Set([...k.accounts, ...lacking.map((h) => h.username_id)])].sort((a, b) => a - b);
            plan.widen.push({ keyId: id, accounts });
        } else plan.add.push(id);
    }
    plan.accounts = hosts.filter((h) => gaining.has(h.username_id)).map((h) => ({ id: h.username_id, username: h.username }));
    return plan;
}

/** 金鑰矩陣裡一台的金鑰 → `KeyReach`。/ The key matrix's keys for one device. */
export function reachOnDevice(device: KeyDevice | undefined): KeyReach[] {
    return (device?.keys ?? []).map((k) => ({
        id: k.user_key_id,
        direct: k.direct ?? true,
        accounts: k.accounts,
        groups: (k.groups ?? []).map((g) => g.accounts),
    }));
}

/** 單台裝置清單的 `my_keys` → `KeyReach`。/ One device's `my_keys`. */
export function reachInList(myKeys: DeviceKeys["my_keys"]): KeyReach[] {
    return myKeys.map((k) => ({ id: k.id, direct: k.in_list, accounts: k.accounts, groups: (k.via_groups ?? []).map((g) => g.accounts) }));
}

/** 我在這台能用、但這次不會裝金鑰的帳號（照帳號順序）。/ Accounts I may use here that this leaves alone. */
export function untouchedAccounts(allowed: string[], used: string[]): string[] {
    const set = new Set(used);
    return allowed.filter((a) => !set.has(a));
}

export type AccessCounts = Record<DeviceAccess, number>;

export function countAccess(states: DeviceAccess[]): AccessCounts {
    const out: AccessCounts = { ready: 0, installing: 0, error: 0, missing: 0, unknown: 0 };
    for (const s of states) out[s] += 1;
    return out;
}

/** 對話框打開時先勾哪些：通道頁有篩選時 = 畫面上那些（能放的），否則全部。/ The first selection. */
export function initialSelection(eligible: number[], shownOnPage: number[] | null): Set<number> {
    if (!shownOnPage) return new Set(eligible);
    const shown = new Set(shownOnPage);
    const picked = eligible.filter((id) => shown.has(id));
    return new Set(picked.length > 0 ? picked : eligible);
}

/** 換一個帳號的勾選（照帳號清單的順序）；最後一個不取消。/ Toggle one account, kept in list order; never untick the last. */
export function toggleAccount(current: number[], id: number, order: number[]): number[] {
    if (current.includes(id)) return current.length > 1 ? current.filter((x) => x !== id) : current;
    const next = new Set([...current, id]);
    return order.filter((x) => next.has(x));
}

/** 單台一開始勾哪個帳號：隧道的預設帳號（能用時），否則第一個。/ The single config's first pick: the default, else the first. */
export function firstAccount(ids: number[], defaultId: number | null | undefined): number[] {
    if (ids.length === 0) return [];
    return [defaultId != null && ids.includes(defaultId) ? defaultId : ids[0]];
}

/** 逐台帳號 → 後端的 `pick` 參數（`<隧道>:<帳號>.<帳號>,…`，依隧道 id 排序，空的不送）。/ Per-device picks → `pick`. */
export function pickParam(picks: Record<number, number[]>): string {
    return Object.entries(picks)
        .filter(([, ids]) => ids.length > 0)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([t, ids]) => `${t}:${ids.join(".")}`)
        .join(",");
}
