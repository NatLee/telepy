/**
 * 「我的金鑰」每把金鑰身上的小籤與裝置狀態（列表與卡片共用，純函式，`keyBadges.test.ts` 有測試）。
 * 籤一律排成可以換行的一行、文字不截斷；這裡只決定有哪些、順序（要注意的在前），以及裝置金鑰籤的
 * 說法：一條隧道寫名稱，好幾條寫數量（名稱在滑過的提示裡），所以籤再多也不會擠掉其他資訊。
 * The chips on each of "your keys" and the per-device state (shared by the list and the cards; pure, tested in
 * `keyBadges.test.ts`). Chips always sit on one wrapping line and are never cut; this only decides which ones,
 * their order (what needs attention first) and how the device-key chip reads: one tunnel by name, several by
 * count (the names go in the hover text), so however many there are they never push other information out.
 */
import type { KeyTarget, UserKey } from "../types/keys";
import { expiryState } from "./keyExpiry.ts";

export type KeyBadge =
    /** 已到期 / 7 天內到期。/ Expired / expiring within a week. */
    | { kind: "expired" | "expiring"; at: string }
    /** 也是你某幾條隧道的裝置金鑰。/ Also the device key of some of your tunnels. */
    | { kind: "device"; names: string[] }
    /** 所在的金鑰群組。/ Its key group. */
    | { kind: "group"; name: string };

/**
 * 一把金鑰的籤（類型籤另外畫在名稱旁）。`withExpiry` = 版面沒有自己的到期欄位時把到期狀態也做成籤。
 * A key's chips (the type badge sits by the name). `withExpiry` adds the expiry state as a chip when the layout
 * has no expiry field of its own.
 */
export function keyBadges(key: Pick<UserKey, "expires_at" | "device_of">, groupName: string | null, withExpiry: boolean, now: number = Date.now()): KeyBadge[] {
    const out: KeyBadge[] = [];
    const state = expiryState(key.expires_at, now);
    if (withExpiry && key.expires_at && (state === "expired" || state === "soon")) out.push({ kind: state === "expired" ? "expired" : "expiring", at: key.expires_at });
    const names = (key.device_of ?? []).map((d) => d.name).filter(Boolean);
    if (names.length) out.push({ kind: "device", names });
    if (groupName) out.push({ kind: "group", name: groupName });
    return out;
}

/** 裝置金鑰籤：一條寫名稱、好幾條寫數量。/ The device-key chip: one tunnel by name, several by count. */
export function deviceBadgeText(names: string[]): { one: string } | { count: number } {
    return names.length === 1 ? { one: names[0] } : { count: names.length };
}

/** 金鑰在一台裝置上的狀態：全部帳號都裝好 / 有帳號出錯 / 還在排隊。/ A key on one device: all installed / some failed / still queued. */
export type DeviceState = "installed" | "error" | "pending";

export function deviceState(targets: Pick<KeyTarget, "status">[]): DeviceState {
    if (targets.some((t) => t.status === "error")) return "error";
    if (targets.length > 0 && targets.every((t) => t.status === "installed")) return "installed";
    return "pending";
}

/** 卡片先列出幾台裝置，其餘收成「還有 N 台」。/ Devices a card names before folding the rest into "N more". */
export const CARD_DEVICES_SHOWN = 4;

/**
 * 卡片上的裝置：出錯的在前、排隊的其次、裝好的最後（要處理的先看到），同狀態照名稱；超過上限的收起來。
 * The devices on a card: failed first, then queued, then installed (what needs a look comes first), by name within
 * a state; the rest past the limit fold away.
 */
export function cardDevices<T extends { name: string; state: DeviceState }>(devices: T[], shown = CARD_DEVICES_SHOWN): { shown: T[]; more: T[] } {
    const rank: Record<DeviceState, number> = { error: 0, pending: 1, installed: 2 };
    const sorted = [...devices].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    // 只多一台時直接列出來，不要「還有 1 台」。/ Exactly one over: list it instead of "1 more".
    const cut = sorted.length > shown + 1 ? shown : sorted.length;
    return { shown: sorted.slice(0, cut), more: sorted.slice(cut) };
}
