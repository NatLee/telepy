/**
 * Tapi 的帳號設定（`tapi_color` / `tapi_daily`）放在自己的小 store，不經過 auth context：
 * 以前存一次就重抓整份 profile、換掉 `user` 物件，整頁（通道清單幾十列）跟著重畫，再加上兩趟來回都等完才變色，
 * 點色票像是卡住。現在點下去馬上換（樂觀更新），只有畫 Tapi 的元件重畫；送出依序排隊、連點只送最後一次，
 * 回應以伺服器為準，失敗就退回上一次確認的值。profile 進來時（登入、其他原因重抓）由 UserSettingsSync 種回來。
 * Tapi's account settings (`tapi_color` / `tapi_daily`) live in their own small store instead of the auth
 * context. Saving used to refetch the whole profile and replace the `user` object, so the whole page (dozens of
 * tunnel rows) re-rendered, and nothing changed until both round trips were done — picking a colour felt stuck.
 * Now a click shows at once (optimistic), only components that draw Tapi re-render, saves go out in order with
 * rapid clicks coalesced into one, the server's answer wins, and a failure goes back to the last confirmed value.
 * The profile seeds it (sign-in, other refetches) through UserSettingsSync. 不依賴 React。/ No React.
 */

export interface TapiPrefs {
    /** 十字髮夾顏色；空 = 還沒找到 Tapi，`daily` = 每天換。/ Clip colour; empty = not found yet, `daily` = rotates. */
    color: string;
    /** 看完片尾名單了沒（解鎖「每天換一個」）。/ Credits watched (unlocks the daily colour). */
    daily: boolean;
}

export interface TapiPatch {
    tapi_color?: string;
    tapi_daily?: boolean;
}

/** 送出一次修改；回伺服器存好的值，失敗回 null。/ Sends one patch; the stored values, or null on failure. */
export type TapiSender = (patch: TapiPatch) => Promise<TapiPrefs | null>;

const EMPTY: TapiPrefs = { color: "", daily: false };

function apply(prefs: TapiPrefs, patch: TapiPatch): TapiPrefs {
    return {
        color: patch.tapi_color ?? prefs.color,
        daily: patch.tapi_daily ?? prefs.daily,
    };
}

function same(a: TapiPrefs, b: TapiPrefs): boolean {
    return a.color === b.color && a.daily === b.daily;
}

/** 一個 store（測試各自建一個；畫面用下面的共用那個）。/ One store (tests make their own; the UI uses the shared one). */
export function createTapiStore() {
    let shown: TapiPrefs = EMPTY;
    let confirmed: TapiPrefs = EMPTY;
    let pending: TapiPatch | null = null;
    let running = false;
    let waiters: ((ok: boolean) => void)[] = [];
    const listeners = new Set<() => void>();

    const set = (next: TapiPrefs) => {
        if (same(next, shown)) return;
        shown = next;
        listeners.forEach((l) => l());
    };

    async function pump(send: TapiSender) {
        running = true;
        let ok = true;
        while (pending) {
            const patch = pending;
            pending = null;
            const answer = await send(patch).catch(() => null);
            if (answer) confirmed = answer;
            else {
                ok = false;
                // 這一筆沒存到：之後排隊的也不送了，畫面回到伺服器上的值。/ Not saved: drop what queued after it too.
                pending = null;
            }
        }
        running = false;
        set(confirmed);
        const done = waiters;
        waiters = [];
        done.forEach((w) => w(ok));
    }

    return {
        get: (): TapiPrefs => shown,
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** 伺服器上的值（profile）；送出中就不蓋掉畫面。/ The server's values (profile); ignored while saving. */
        seed(prefs: TapiPrefs) {
            if (running || pending) return;
            confirmed = prefs;
            set(prefs);
        },
        /** 登出：回到空的。/ Signed out: back to empty. */
        reset() {
            pending = null;
            confirmed = EMPTY;
            set(EMPTY);
        },
        /** 馬上顯示，排隊送出；全部送完後回 true / false。/ Shows at once, queues the send; resolves with success. */
        save(patch: TapiPatch, send: TapiSender): Promise<boolean> {
            pending = { ...pending, ...patch };
            set(apply(shown, patch));
            const result = new Promise<boolean>((resolve) => waiters.push(resolve));
            if (!running) void pump(send);
            return result;
        },
    };
}

export const tapiStore = createTapiStore();
