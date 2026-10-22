/**
 * 指令速查頁「第一次使用的設定」清單的狀態：照相依順序的四步——登記金鑰 → 裝置在線 → 金鑰裝到裝置 → ~/.ssh/config。
 * 前三步由伺服器資料即時判斷（金鑰數、線上狀態、裝置金鑰清單），只有 ~/.ssh/config 看不到，由使用者自己勾
 * （每條隧道 × 目標帳號記在 localStorage）。第一個沒完成的步驟就是「下一步」。
 * State of the command sheet's first-time setup checklist: four steps in dependency order — register a key →
 * device online → key on the device → ~/.ssh/config. The first three are derived live from server data (key
 * count, online state, the device key list); only ~/.ssh/config is invisible to us, so the user ticks it (per
 * tunnel × account, in localStorage). The first unfinished step is the "next" one.
 */
import { useCallback, useMemo, useState } from "react";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import type { ConnectMode } from "@/lib/forwardRecipes";
import type { KeyTarget } from "@/types/keys";

export type SetupStepId = "key" | "online" | "deviceKey" | "config";
/** done / todo；working = Telepy 正在處理（等裝置寫入）；error = 寫入失敗；loading = 還在讀。 */
export type SetupStepState = "done" | "todo" | "working" | "error" | "loading";

export interface SetupStep {
    id: SetupStepId;
    state: SetupStepState;
}

const CONFIG_STORAGE_KEY = "telepy.cheatsheetConfigDone";

function readConfigDone(): Record<string, true> | null {
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v === "object" ? v : null;
    } catch {
        return null;
    }
}

interface Args {
    tunnelId: number | null;
    /** 目前選的目標帳號（沒有時 null）。/ The selected target account, if any. */
    username: string | null;
    /** 頁面一開始抓的個人金鑰數；裝置金鑰清單載入後改用它的 my_keys。/ Initial key count; my_keys wins once loaded. */
    keyCount: number | null;
    online: boolean;
    mode: ConnectMode;
}

export function useSetupChecklist({ tunnelId, username, keyCount, online, mode }: Args) {
    const deviceKeys = useDeviceKeys(tunnelId);
    const { data } = deviceKeys;

    // 頁面在清單載入前只顯示轉圈，所以這裡直接讀 localStorage 不會造成 hydration 不一致。
    // The page shows a spinner until its data loads, so reading localStorage up front can't cause a hydration mismatch.
    const [configDone, setConfigDone] = useState<Record<string, true>>(() => readConfigDone() ?? {});
    const configKey = tunnelId !== null && username ? `${tunnelId}:${username}` : null;

    const markConfig = useCallback(
        (done: boolean) => {
            if (!configKey) return;
            setConfigDone((prev) => {
                const next = { ...prev };
                if (done) next[configKey] = true;
                else delete next[configKey];
                try {
                    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
                } catch { /* 忽略 / ignore */ }
                return next;
            });
        },
        [configKey]
    );

    const myKeys = useMemo(() => data?.my_keys ?? [], [data]);
    const keys = data ? myKeys.length : keyCount;
    const allowed = data ? (username !== null && data.accounts.includes(username)) : username !== null;

    /** 我的金鑰 id → 在目前帳號上的狀態（不在清單上就沒有）。/ My key id → its state in the selected account. */
    const keyTargets = useMemo(() => {
        const map = new Map<number, KeyTarget | null>();
        for (const e of data?.entries ?? []) {
            if (!e.mine) continue;
            map.set(e.user_key_id, e.targets.find((tg) => tg.username === username) ?? null);
        }
        return map;
    }, [data, username]);

    const deviceKeyState: SetupStepState = (() => {
        if (!data) return deviceKeys.loading ? "loading" : "todo";
        const targets = [...keyTargets.values()].filter((tg): tg is KeyTarget => tg !== null);
        if (targets.some((tg) => tg.status === "installed")) return "done";
        if (targets.some((tg) => tg.status === "pending")) return "working";
        if (targets.some((tg) => tg.status === "error")) return "error";
        return "todo";
    })();

    const steps: SetupStep[] = [
        { id: "key", state: keys === null ? "loading" : keys > 0 ? "done" : "todo" },
        { id: "online", state: online ? "done" : "todo" },
        { id: "deviceKey", state: deviceKeyState },
        { id: "config", state: mode === "direct" || (configKey !== null && configDone[configKey]) ? "done" : "todo" },
    ];
    const done = steps.filter((s) => s.state === "done").length;
    const current = steps.find((s) => s.state !== "done")?.id ?? null;
    /** 還沒加進這台裝置清單的我的金鑰。/ My keys that are not on this device's list yet. */
    const missingKeyIds = myKeys.filter((k) => !k.in_list).map((k) => k.id);

    return {
        steps,
        done,
        total: steps.length,
        current,
        keys,
        allowed,
        myKeys,
        keyTargets,
        missingKeyIds,
        role: data?.tunnel.role ?? null,
        deviceKeysLoaded: data !== null,
        busy: deviceKeys.busy,
        addKeys: () => deviceKeys.addAllMine(missingKeyIds),
        markConfig,
    };
}

export type SetupChecklist = ReturnType<typeof useSetupChecklist>;
