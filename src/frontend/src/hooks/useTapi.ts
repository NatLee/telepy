"use client";

/**
 * Tapi（彩蛋吉祥物）的外觀：十字髮夾的顏色跟著帳號（`tapi_color`：空 = 還沒找到 Tapi、`daily` = 每天換一個），
 * 節日換裝跟著日期（lib/festivals）。帳號設定放在 lib/tapiStore（不經過 auth context），存的時候馬上換、只有 Tapi 重畫。
 * Tapi's look: the clip colour follows the account (`tapi_color`: empty = not found yet, `daily` = a new one every
 * day) and the festive outfit follows the date (lib/festivals). The account settings live in lib/tapiStore (not
 * the auth context), so a save shows at once and only Tapi re-renders.
 */
import { useCallback, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { festivalOn, type Festival } from "@/lib/festivals";
import { clipHex, clipName, unixDay, type TapiLook } from "@/lib/mascot";
import { tapiStore, type TapiPatch, type TapiPrefs } from "@/lib/tapiStore";

// 一天算一次（getSnapshot 每次 render 都會被叫）。/ Computed once per day (getSnapshot runs on every render).
let festivalCache: { day: string; key: string } | null = null;
function festivalKey(): string {
    const now = new Date();
    const day = now.toDateString();
    if (festivalCache?.day !== day) {
        const f = festivalOn(now);
        festivalCache = { day, key: f ? (f.kind === "birthday" ? `birthday:${f.age}` : f.kind) : "" };
    }
    return festivalCache.key;
}
const noSubscribe = () => () => {};

/** 今天的節日（伺服器端 render 時是 null）。/ Today's festival (null while server rendering). */
export function useFestival(enabled = true): Festival | null {
    const key = useSyncExternalStore(noSubscribe, () => (enabled ? festivalKey() : ""), () => "");
    if (key === "lunarNewYear" || key === "halloween") return { kind: key };
    if (key.startsWith("birthday:")) return { kind: "birthday", age: Number(key.slice(9)) };
    return null;
}

export interface TapiState extends TapiLook {
    /** 存的選擇（空 = 還沒找到 Tapi）。/ The stored choice (empty = not found yet). */
    choice: string;
    unlocked: boolean;
    dailyUnlocked: boolean;
    /** 讓 Tapi 偶爾自己來串門子。/ Let Tapi drop by now and then. */
    visits: boolean;
    /** 存設定（畫面馬上換；失敗會退回並回 false）。/ Save (shown at once; a failure reverts and resolves false). */
    save: (patch: TapiPatch) => Promise<boolean>;
}

const EMPTY_PREFS: TapiPrefs = { color: "", daily: false, visits: true };

/** 送到 /api/user/settings，回存好的值。/ Posts to /api/user/settings and returns what was stored. */
async function sendTapi(patch: TapiPatch): Promise<TapiPrefs | null> {
    const res = await apiFetch("/api/user/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { tapi_color?: unknown; tapi_daily?: unknown; tapi_visits?: unknown } | null;
    if (!data || typeof data.tapi_color !== "string") return null;
    return { color: data.tapi_color, daily: data.tapi_daily === true, visits: data.tapi_visits !== false };
}

export function useTapi(): TapiState {
    const festival = useFestival();
    const prefs = useSyncExternalStore(tapiStore.subscribe, tapiStore.get, () => EMPTY_PREFS);
    const save = useCallback((patch: TapiPatch) => tapiStore.save(patch, sendTapi), []);
    return {
        clip: clipHex(clipName(prefs.color, unixDay())),
        festival: festival?.kind ?? null,
        choice: prefs.color,
        unlocked: prefs.color !== "",
        dailyUnlocked: prefs.daily,
        visits: prefs.visits,
        save,
    };
}
