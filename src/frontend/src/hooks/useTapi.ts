"use client";

/**
 * Tapi（彩蛋吉祥物）的外觀：十字髮夾的顏色跟著帳號（`tapi_color`：空 = 還沒找到 Tapi、`daily` = 每天換一個），
 * 節日換裝跟著日期（lib/festivals）。存設定後重抓 profile，各處一起換。
 * Tapi's look: the clip colour follows the account (`tapi_color`: empty = not found yet, `daily` = a new one every
 * day) and the festive outfit follows the date (lib/festivals). Saving refetches the profile so every Tapi updates.
 */
import { useCallback, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { festivalOn, type Festival } from "@/lib/festivals";
import { clipHex, clipName, unixDay, type TapiLook } from "@/lib/mascot";

// 一天算一次（getSnapshot 每次 render 都會被叫）。/ Computed once per day (getSnapshot runs on every render).
let festivalCache: { day: string; key: string } | null = null;
function festivalKey(): string {
    const now = new Date();
    const day = now.toDateString();
    if (festivalCache?.day !== day) {
        const f = festivalOn(now);
        festivalCache = { day, key: f ? (f.kind === "birthday" ? `birthday:${f.age}` : "lunarNewYear") : "" };
    }
    return festivalCache.key;
}
const noSubscribe = () => () => {};

/** 今天的節日（伺服器端 render 時是 null）。/ Today's festival (null while server rendering). */
export function useFestival(enabled = true): Festival | null {
    const key = useSyncExternalStore(noSubscribe, () => (enabled ? festivalKey() : ""), () => "");
    if (key === "lunarNewYear") return { kind: "lunarNewYear" };
    if (key.startsWith("birthday:")) return { kind: "birthday", age: Number(key.slice(9)) };
    return null;
}

export interface TapiState extends TapiLook {
    /** 存的選擇（空 = 還沒找到 Tapi）。/ The stored choice (empty = not found yet). */
    choice: string;
    unlocked: boolean;
    dailyUnlocked: boolean;
    /** 存設定並重抓 profile。/ Save and refetch the profile. */
    save: (patch: { tapi_color?: string; tapi_daily?: boolean }) => Promise<boolean>;
}

export function useTapi(): TapiState {
    const { user, fetchUserProfile } = useAuth();
    const festival = useFestival();
    const choice = user?.tapi_color ?? "";
    const save = useCallback(
        async (patch: { tapi_color?: string; tapi_daily?: boolean }) => {
            try {
                const res = await apiFetch("/api/user/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
                if (res.ok) await fetchUserProfile();
                return res.ok;
            } catch {
                return false;
            }
        },
        [fetchUserProfile],
    );
    return {
        clip: clipHex(clipName(choice, unixDay())),
        festival: festival?.kind ?? null,
        choice,
        unlocked: choice !== "",
        dailyUnlocked: !!user?.tapi_daily,
        save,
    };
}
