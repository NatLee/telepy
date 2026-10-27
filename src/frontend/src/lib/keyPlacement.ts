/**
 * 「一把金鑰會去哪」的純計算：我的金鑰 → 裝置的清單 → 擁有者能用的帳號 ∩ 金鑰選定的帳號 → 每個帳號的金鑰檔
 * （`~/.ssh/authorized_keys`；Windows 管理員是共用的 `administrators_authorized_keys`）。
 * 驅動金鑰頁說明與裝置面板的「金鑰去哪」圖（KeyPlacementFlow）。
 * Pure: where a key ends up — the list → the owner's allowed accounts ∩ the key's chosen accounts → each
 * account's key file (or the shared admin file on a Windows administrator). Drives the placement diagram.
 */
import type { DeviceAccount, ViewAccount } from "@/types/keys";

export const USER_FILE = "~/.ssh/authorized_keys";
export const ADMIN_FILE = "%ProgramData%\\ssh\\administrators_authorized_keys";

/** 圖上的一個帳號。/ One account on the diagram. */
export interface PlacementAccount {
    id: number | null;
    username: string;
    /** 金鑰檔。/ The key file. */
    file: string;
    windowsAdmin: boolean;
}

/** 金鑰在一個帳號上的去向。/ Where the key stands with one account. */
export type PlacementState = "placed" | "unchosen" | "notAllowed";

export interface Placement {
    account: PlacementAccount;
    /** 擁有者在這個帳號上有權限（上限）。/ The owner may use the account (the ceiling). */
    allowed: boolean;
    /** 金鑰選了這個帳號（null 選擇 = 全選）。/ The key chose it (a null choice = all). */
    chosen: boolean;
    state: PlacementState;
}

/**
 * `allowedIds`：擁有者能用的帳號 id（`"all"` = 每個帳號都能用，例如擁有者本人）；`chosen`：金鑰選定的 id，null = 全部。
 * 帳號順序照 `accounts`。沒有 id 的帳號（例如只有名字）用名字比對 `allowedNames`。
 * Owner's allowed account ids (`"all"` = every account), the key's chosen ids (null = all). Order follows `accounts`.
 */
export function placeKey(accounts: PlacementAccount[], allowedIds: number[] | "all", chosen: number[] | null): Placement[] {
    return accounts.map((account) => {
        const allowed = allowedIds === "all" || (account.id !== null && allowedIds.includes(account.id));
        const isChosen = chosen === null || (account.id !== null && chosen.includes(account.id));
        const state: PlacementState = !allowed ? "notAllowed" : isChosen ? "placed" : "unchosen";
        return { account, allowed, chosen: isChosen, state };
    });
}

export interface PlacementSummary {
    placed: number;
    unchosen: number;
    notAllowed: number;
    /** 用到的檔案（去重）。/ Distinct files written. */
    files: string[];
}

export function summarizePlacement(p: Placement[]): PlacementSummary {
    const files = new Set<string>();
    const s: PlacementSummary = { placed: 0, unchosen: 0, notAllowed: 0, files: [] };
    for (const x of p) {
        s[x.state]++;
        if (x.state === "placed") files.add(x.account.windowsAdmin ? x.account.file : `${x.account.username}:${x.account.file}`);
    }
    s.files = [...files];
    return s;
}

/**
 * 裝置面板的真實資料 → 圖上的帳號：`view.accounts`（有檔名與管理員旗標）優先，沒出現在那裡的允許帳號補上。
 * Real panel data → diagram accounts: `view.accounts` (with file / admin flag) first, then allowed accounts missing there.
 */
export function accountsFromDevice(view: ViewAccount[], allowed: DeviceAccount[]): PlacementAccount[] {
    const byName = new Map(allowed.map((a) => [a.username, a.id]));
    const out: PlacementAccount[] = view.map((a) => ({ id: byName.get(a.username) ?? null, username: a.username, file: a.file, windowsAdmin: a.windows_admin }));
    const seen = new Set(out.map((a) => a.username));
    for (const a of allowed) {
        if (!seen.has(a.username)) out.push({ id: a.id, username: a.username, file: USER_FILE, windowsAdmin: false });
    }
    return out;
}

/**
 * 說明用的例子，跟總覽圖同一台 pi-lab：bob 能用 ubuntu 與 deploy（不能用 root），他的 laptop 金鑰只選了 ubuntu。
 * The explainer's example, the same pi-lab as its overview: bob may use ubuntu and deploy (not root) and his
 * laptop key picked only ubuntu.
 */
export const EXAMPLE_ACCOUNTS: PlacementAccount[] = [
    { id: 1, username: "ubuntu", file: USER_FILE, windowsAdmin: false },
    { id: 2, username: "deploy", file: USER_FILE, windowsAdmin: false },
    { id: 3, username: "root", file: USER_FILE, windowsAdmin: false },
];
export const EXAMPLE_ALLOWED: number[] = [1, 2];
export const EXAMPLE_CHOSEN: number[] = [1];

/** 選擇的文字摘要用：選了幾個 / 共幾個；null = 全部。/ "N of M" for the picker button; null = all. */
export function chosenCount(chosen: number[] | null, allowed: DeviceAccount[]): { chosen: number; total: number; all: boolean } {
    const ids = new Set(allowed.map((a) => a.id));
    const n = chosen === null ? ids.size : chosen.filter((id) => ids.has(id)).length;
    return { chosen: n, total: ids.size, all: chosen === null };
}

/** 勾選框的下一個狀態：全選再取消一個 = 其餘；只剩一個時不能取消（用「移出清單」）；全部勾回 = null。 */
export function toggleChosen(chosen: number[] | null, allowed: DeviceAccount[], id: number, on: boolean): number[] | null {
    const all = allowed.map((a) => a.id);
    const current = chosen === null ? all : chosen.filter((x) => all.includes(x));
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    if (next.length === 0) return current;
    return all.every((x) => next.includes(x)) ? null : all.filter((x) => next.includes(x));
}
