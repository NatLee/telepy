/**
 * 指令速查頁「第一次使用的設定」清單的狀態：照相依順序的四步——登記金鑰 → 裝置在線 → 金鑰裝到裝置 → ~/.ssh/config。
 * 前三步由伺服器資料即時判斷（金鑰數、線上狀態、裝置金鑰清單），只有 ~/.ssh/config 看不到，由使用者自己勾
 * （每條隧道 × 目標帳號記在 localStorage）。第一個沒完成的步驟就是「下一步」。
 * 用 telepy 跑時，「你這台電腦」那項是裝好 telepy 並登入（有 CLI 登入就算；看不到時自己勾），排第一個。
 * State of the command sheet's first-time setup checklist: four steps in dependency order — register a key →
 * device online → key on the device → ~/.ssh/config. The first three are derived live from server data (key
 * count, online state, the device key list); only ~/.ssh/config is invisible to us, so the user ticks it (per
 * tunnel × account, in localStorage). The first unfinished step is the "next" one. With the telepy way, the
 * computer's item is "telepy installed and signed in" (done with a CLI sign-in on record, else ticked by hand), first.
 */
import { useCallback, useMemo, useState } from "react";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import type { ConnectMode } from "@/lib/forwardRecipes";
import type { KeyTarget } from "@/types/keys";
import { configDoneKey, markKeys, readConfigDone, writeConfigDone, type ConfigDone } from "@/lib/configDone";
import { EMPTY_PLAN, keyPlan, planKeyCount, reachInList } from "@/lib/bulkSshConfig";

export type SetupStepId = "key" | "online" | "deviceKey" | "config";
/** done / todo；working = Telepy 正在處理（等裝置寫入）；error = 寫入失敗；loading = 還在讀。 */
export type SetupStepState = "done" | "todo" | "working" | "error" | "loading";

export interface SetupStep {
    id: SetupStepId;
    state: SetupStepState;
}


interface Args {
    tunnelId: number | null;
    /** 目前選的目標帳號（沒有時 null）。/ The selected target account, if any. */
    username: string | null;
    /** 頁面一開始抓的個人金鑰數；裝置金鑰清單載入後改用它的 my_keys。/ Initial key count; my_keys wins once loaded. */
    keyCount: number | null;
    online: boolean;
    mode: ConnectMode;
    /** `telepy login` 過的電腦（null = 還在讀）。/ Computers the CLI signed in from (null = loading). */
    cliSignIns?: string[] | null;
}

const CLI_DONE_KEY = "telepy.cheatsheetCliDone";

function readCliDone(): boolean {
    try {
        return localStorage.getItem(CLI_DONE_KEY) === "1";
    } catch {
        return false;
    }
}

export function useSetupChecklist({ tunnelId, username, keyCount, online, mode, cliSignIns = [] }: Args) {
    const deviceKeys = useDeviceKeys(tunnelId);
    const { data } = deviceKeys;

    // 頁面在清單載入前只顯示轉圈，所以這裡直接讀 localStorage 不會造成 hydration 不一致。
    // The page shows a spinner until its data loads, so reading localStorage up front can't cause a hydration mismatch.
    const [configDone, setConfigDone] = useState<ConfigDone>(readConfigDone);
    // 用 token 登入的 CLI 看不出來：讓人自己勾「telepy 好了」。/ A token sign-in can't be seen: a hand tick.
    const [cliDone, setCliDone] = useState<boolean>(readCliDone);
    const configKey = tunnelId !== null && username ? configDoneKey(tunnelId, username) : null;

    const markConfig = useCallback(
        (done: boolean) => {
            if (mode === "telepy") {
                setCliDone(done);
                try {
                    localStorage.setItem(CLI_DONE_KEY, done ? "1" : "0");
                } catch { /* 忽略 / ignore */ }
                return;
            }
            if (!configKey) return;
            setConfigDone((prev) => {
                const next = markKeys(prev, [configKey], done);
                writeConfigDone(next);
                return next;
            });
        },
        [configKey, mode]
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

    const computer: SetupStep =
        mode === "telepy"
            ? { id: "config", state: cliSignIns === null ? "loading" : cliSignIns.length > 0 || cliDone ? "done" : "todo" }
            : { id: "config", state: mode === "direct" || (configKey !== null && configDone[configKey]) ? "done" : "todo" };
    const rest: SetupStep[] = [
        { id: "key", state: keys === null ? "loading" : keys > 0 ? "done" : "todo" },
        { id: "online", state: online ? "done" : "todo" },
        { id: "deviceKey", state: deviceKeyState },
    ];
    // telepy 要先裝好才談得上其他；~/.ssh/config 是最後一步。/ telepy comes first; ~/.ssh/config is the last step.
    const steps: SetupStep[] = mode === "telepy" ? [computer, ...rest] : [...rest, computer];
    const done = steps.filter((s) => s.state === "done").length;
    const current = steps.find((s) => s.state !== "done")?.id ?? null;
    /**
     * 把我的金鑰放到「目前這個帳號」要做的事（不是我在這台能用的每個帳號）。
     * What putting my keys into the selected account takes (not every account I may use here).
     */
    const plan = useMemo(() => {
        const id = data?.account_ids.find((a) => a.username === username)?.id;
        if (!data || !username || id === undefined) return EMPTY_PLAN;
        return keyPlan(reachInList(myKeys), myKeys.filter((k) => !k.expired).map((k) => k.id), [{ username, username_id: id }]);
    }, [data, myKeys, username]);

    return {
        steps,
        done,
        total: steps.length,
        current,
        keys,
        allowed,
        myKeys,
        keyTargets,
        /** 會放上去的金鑰數（0 = 沒事可做）。/ Keys the add button would place (0 = nothing to do). */
        keysToPlace: planKeyCount(plan),
        role: data?.tunnel.role ?? null,
        deviceKeysLoaded: data !== null,
        busy: deviceKeys.busy,
        addKeys: () => deviceKeys.placeMine(plan),
        markConfig,
        /** telepy 有沒有被看到登入過（不是自己勾的）。/ Whether a CLI sign-in was seen (not ticked by hand). */
        cliSeen: (cliSignIns?.length ?? 0) > 0,
        cliSignIns: cliSignIns ?? [],
    };
}

export type SetupChecklist = ReturnType<typeof useSetupChecklist>;
