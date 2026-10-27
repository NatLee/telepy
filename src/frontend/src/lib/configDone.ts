/**
 * 「我已經把 config 加好了」：Telepy 看不到筆電的 ~/.ssh/config，所以由使用者自己勾，記在 localStorage
 * （每條隧道 × 帳號一筆，`<隧道>:<帳號>`）。指令速查的設定清單與 SSH config 對話框（單台、多台）共用同一份。
 * "I've added it to my config": Telepy can't see the laptop's ~/.ssh/config, so the person ticks it, kept in
 * localStorage per tunnel × account (`<tunnel>:<account>`). The command sheet's checklist and both SSH config
 * dialogs share it.
 */

export const CONFIG_DONE_KEY = "telepy.cheatsheetConfigDone";

export type ConfigDone = Record<string, true>;

export const configDoneKey = (tunnelId: number, username: string) => `${tunnelId}:${username}`;

export function readConfigDone(): ConfigDone {
    try {
        const raw = localStorage.getItem(CONFIG_DONE_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

/** 把這些 key 標成做好 / 沒做（純函式）。/ Mark these keys done or not (pure). */
export function markKeys(current: ConfigDone, keys: string[], done: boolean): ConfigDone {
    const next = { ...current };
    for (const k of keys) {
        if (done) next[k] = true;
        else delete next[k];
    }
    return next;
}

export function writeConfigDone(value: ConfigDone): void {
    try {
        localStorage.setItem(CONFIG_DONE_KEY, JSON.stringify(value));
    } catch { /* localStorage 不可用 / unavailable */ }
}

/** 這些 key 全都做好了嗎（空 = 沒有）。/ Whether every key is done (none = no). */
export function allDone(current: ConfigDone, keys: string[]): boolean {
    return keys.length > 0 && keys.every((k) => current[k]);
}
