/**
 * 停用帳號會切掉什麼（純函式，`accountDisable.test.ts`）：後端 `GET /api/user/users/{id}/disable-preview` 的預估、
 * 停用後回應裡 `disabled` 的實際結果，畫成「帳號 ─ 瀏覽器 ─ 進行中的 session ─ API token ─ 已連接的 app ─ 裝置金鑰」。
 * 瀏覽器被登出、session 結束（不會回來）；token 與 app 只是暫停；Telepy 裝在裝置上的金鑰被拿掉（離線的等它回來），
 * 清單留著，三者重新啟用帳號都會回來。
 * What disabling an account cuts (pure): the preview's estimate and, afterwards, the `disabled` report, drawn as
 * account ─ browsers ─ live sessions ─ API tokens ─ connected apps ─ device keys. Browsers are signed out and sessions
 * end (for good); tokens and apps are only suspended; keys Telepy installed on devices are removed (offline devices
 * when they reconnect) while the key lists stay, so all three come back when the account is enabled again.
 */
import type { SpotState } from "./flow.ts";

/** Telepy 替他裝在裝置上的金鑰：幾台裝置（其中幾台離線）、幾個帳號。/ Keys Telepy installed for them on devices. */
export interface DeviceKeyImpact {
    devices: number;
    accounts: number;
    offline_devices: number;
}

export interface DisableImpact {
    web_sessions: number;
    live_sessions: number;
    agent_sessions: number;
    api_tokens: number;
    connected_apps: number;
    device_keys: DeviceKeyImpact;
}

const FIELDS = ["web_sessions", "live_sessions", "agent_sessions", "api_tokens", "connected_apps"] as const;

function count(o: Record<string, unknown>, k: string): number {
    return typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.max(0, Math.floor(o[k] as number)) : 0;
}

/** 後端的 JSON → 數字（缺的欄位 = 0；不是物件 = null）。/ The backend JSON → counts (missing = 0; not an object = null). */
export function parseImpact(v: unknown): DisableImpact | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const k = (o.device_keys && typeof o.device_keys === "object" ? o.device_keys : {}) as Record<string, unknown>;
    const out = Object.fromEntries(FIELDS.map((f) => [f, count(o, f)])) as unknown as DisableImpact;
    out.device_keys = { devices: count(k, "devices"), accounts: count(k, "accounts"), offline_devices: Math.min(count(k, "offline_devices"), count(k, "devices")) };
    return out;
}

export type CutId = "browsers" | "sessions" | "tokens" | "apps" | "keys";
/** 這一類會怎樣：登出 / 結束 / 暫停 / 從裝置拿掉；沒有東西 = none。/ What happens to it. */
export type CutOutcome = "signedOut" | "ended" | "suspended" | "removed" | "none";

export interface CutSpot {
    id: CutId;
    count: number;
    outcome: CutOutcome;
    /** 重新啟用帳號後會不會回來。/ Whether it comes back when the account is enabled again. */
    comesBack: boolean;
    state: SpotState;
}

/**
 * 圖上的四個節點。預估（done = false）：有東西的標成「會被切」（failed，紅），沒有的待命；做完（done）：有東西的打勾。
 * The four nodes. Preview: anything there is marked as about to be cut (failed, red), empty ones wait; done: ticked.
 */
export function cutSpots(i: DisableImpact, done: boolean): CutSpot[] {
    const spot = (id: CutId, count: number, outcome: Exclude<CutOutcome, "none">, comesBack: boolean): CutSpot => ({
        id,
        count,
        outcome: count > 0 ? outcome : "none",
        comesBack,
        state: count === 0 ? "waiting" : done ? "ok" : "failed",
    });
    return [
        spot("browsers", i.web_sessions, "signedOut", false),
        spot("sessions", i.live_sessions + i.agent_sessions, "ended", false),
        spot("tokens", i.api_tokens, "suspended", true),
        spot("apps", i.connected_apps, "suspended", true),
        spot("keys", i.device_keys.devices, "removed", true),
    ];
}

/** 什麼都沒有可切（只是不能再登入）。/ Nothing to cut (they just can't sign in any more). */
export function nothingToCut(i: DisableImpact): boolean {
    return FIELDS.every((k) => i[k] === 0) && i.device_keys.devices === 0;
}

/** 裝置金鑰那一句要怎麼說：沒有 / 全部在線 / 有幾台離線。/ Which device-key sentence: none / all online / some offline. */
export type KeysLine = "none" | "online" | "someOffline";

export function keysLine(i: DisableImpact): KeysLine {
    if (i.device_keys.devices === 0) return "none";
    return i.device_keys.offline_devices > 0 ? "someOffline" : "online";
}
