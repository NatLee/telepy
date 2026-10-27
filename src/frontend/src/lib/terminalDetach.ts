/**
 * 網頁終端機斷線保留（detach / 重新接上）的純函式，`terminalDetach.test.ts` 有測試。
 * - 保留時間 = 三層取最窄：你的選擇（`terminal_detach_secs`）、站台上限（`terminal_detach_max_secs`，0 = 關閉）、
 *   這台裝置的政策（`terminal_detach_policy`：user / never）。與後端 `terminal_detach::effective` 一致。
 * - 伺服器在 auth 後先送 binary `{type:"shell", id, resumed, offset, reset, detach:{secs, by}}`；瀏覽器記住 id 與
 *   看過的輸出位置（UTF-16 單位 = 字串長度），斷線後帶 `resume` + `offset` 接回。
 * - 每個分頁的 shell id 存在 sessionStorage（依隧道 + 帳號 [+ 區網主機]），重新整理後接回同幾個 shell。
 * - 時間軸圖（`detachTimeline`）：連著 ─ 斷線 ─ 保留 N 秒 ─ 接回（繼續）| 時間到（結束）。
 * Pure helpers for keeping a web terminal's shell across a dropped socket: the three-layer policy (mirrors the
 * backend's `terminal_detach::effective`), the shell frame, which close codes are worth resuming, the per-tab
 * sessionStorage list of shell ids, and the timeline diagram's states.
 */

/** 個人可以選的保留秒數（0 = 斷線就結束）。/ The grace times a user can pick (0 = end at once). */
export const DETACH_CHOICES = [0, 60, 300, 900, 1800, 3600] as const;
export type DetachChoice = (typeof DETACH_CHOICES)[number];

export type DetachPolicy = "user" | "never";
/** 實際保留時間是哪一層決定的。/ Which layer decided the grace time. */
export type DetachDecider = "user" | "site" | "tunnel";

export interface DetachGrace {
    secs: number;
    by: DetachDecider;
}

export function isDetachChoice(v: unknown): v is DetachChoice {
    return typeof v === "number" && (DETACH_CHOICES as readonly number[]).includes(v);
}

export function isDetachPolicy(v: unknown): v is DetachPolicy {
    return v === "user" || v === "never";
}

/** 三層取最窄（後端 `terminal_detach::effective` 的鏡像）。/ The narrowest layer wins (mirrors the backend). */
export function effectiveDetach(userSecs: number, siteMax: number, policy: DetachPolicy = "user"): DetachGrace {
    if (policy === "never") return { secs: 0, by: "tunnel" };
    if (siteMax <= 0) return { secs: 0, by: "site" };
    if (userSecs <= 0) return { secs: 0, by: "user" };
    if (userSecs > siteMax) return { secs: siteMax, by: "site" };
    return { secs: userSecs, by: "user" };
}

/** 偏好設定裡這個選項能不能選（超過站台上限的關掉；0 永遠可以）。/ Whether a choice is selectable under the ceiling. */
export function detachChoiceAllowed(secs: number, siteMax: number): boolean {
    return secs === 0 || (siteMax > 0 && secs <= siteMax);
}

/** 伺服器在 auth 之後送的 shell frame。/ The shell frame the server sends after auth. */
export interface ShellFrame {
    type: "shell";
    id: string;
    resumed: boolean;
    /** 接下來的文字從整個輸出的哪裡開始（UTF-16）。/ Where the following text starts in the whole output. */
    offset: number;
    /** 先清空畫面再補（重新整理過或看過的已被擠出緩衝）。/ Clear the screen before the replay. */
    reset: boolean;
    detach: DetachGrace;
}

const DECIDERS: DetachDecider[] = ["user", "site", "tunnel"];

/** 解析 shell frame（binary frame 的文字）；不是就回 null。/ Parse a shell frame from a binary frame's text. */
export function parseShellFrame(text: string): ShellFrame | null {
    try {
        const v = JSON.parse(text) as Record<string, unknown>;
        if (!v || v.type !== "shell" || typeof v.id !== "string" || !v.id) return null;
        const d = (v.detach ?? {}) as Record<string, unknown>;
        const by = DECIDERS.includes(d.by as DetachDecider) ? (d.by as DetachDecider) : "user";
        return {
            type: "shell",
            id: v.id,
            resumed: v.resumed === true,
            offset: typeof v.offset === "number" && v.offset >= 0 ? v.offset : 0,
            reset: v.reset === true,
            detach: { secs: typeof d.secs === "number" && d.secs > 0 ? d.secs : 0, by },
        };
    } catch {
        return null;
    }
}

/** 4015：要接回的 shell 已經不在了。/ The shell to resume is gone. */
export const SHELL_GONE_CLOSE_CODE = 4015;
/** 4016：這個 shell 在別的視窗接回去了。/ The shell was resumed in another window. */
export const SHELL_TAKEN_CLOSE_CODE = 4016;

/**
 * 「斷線」的關閉碼：網路 / 代理 / 伺服器重啟。1000 / 1005（shell 結束、伺服器正常關）與所有 4xxx（權限、被結束、登出 4010、
 * 裝置離線）都不算 —— 那些是結束，不是斷線。
 * Close codes that mean a drop (network, proxy, server restart). 1000 / 1005 (the shell exited) and every 4xxx
 * (permissions, ended, signed out 4010, device offline) are ends, not drops.
 */
const DROP_CODES = new Set([1001, 1006, 1011, 1012, 1013, 1014]);

export function isDropCode(code: number): boolean {
    return DROP_CODES.has(code);
}

/** 還值得接回嗎：斷線的關閉碼、伺服器說會留、而且還在保留時間內。/ Worth resuming: a drop, a kept shell, within its time. */
export function canResume(code: number, grace: DetachGrace | null, droppedAt: number, now: number): boolean {
    return isDropCode(code) && !!grace && grace.secs > 0 && now < droppedAt + grace.secs * 1000;
}

/** 剩幾秒（不小於 0）。/ Seconds left (never negative). */
export function remainingSecs(droppedAt: number, secs: number, now: number): number {
    return Math.max(0, Math.ceil((droppedAt + secs * 1000 - now) / 1000));
}

/** 重連間隔：0.5 s 起每次加倍，最多 5 s（保留時間有限，不用 30 s 的長退避）。/ Retry delay: 0.5 s doubling up to 5 s. */
export function reconnectDelay(attempt: number): number {
    return Math.min(5000, 500 * 2 ** Math.max(0, attempt));
}

// ---------------------------------------------------------------- sessionStorage：分頁的 shell id / per-tab shell ids

export const MAX_STORED_SHELLS = 6;

/** 一組（隧道、帳號 [、區網主機與登入]）的 key。/ The storage key for one tunnel + account [+ LAN host and login]. */
export function shellStoreKey(tunnelId: string | number, account: string, lanHost?: string | number | null, lanUser?: string | null): string {
    const base = `telepy.shells.${tunnelId}.${account}`;
    return lanHost ? `${base}.lan${lanHost}.${lanUser ?? ""}` : base;
}

const ID_RE = /^[A-Za-z0-9]{1,64}$/;

/** 讀存著的清單（壞掉的值當沒有）。/ Parse a stored list; garbage reads as empty. */
export function parseShellList(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw) as unknown;
        if (!Array.isArray(v)) return [];
        const ids = v.filter((x): x is string => typeof x === "string" && ID_RE.test(x));
        return [...new Set(ids)].slice(0, MAX_STORED_SHELLS);
    } catch {
        return [];
    }
}

export function withShell(list: string[], id: string): string[] {
    if (!ID_RE.test(id)) return list;
    return [...list.filter((x) => x !== id), id].slice(-MAX_STORED_SHELLS);
}

export function withoutShell(list: string[], id: string): string[] {
    return list.filter((x) => x !== id);
}

/** sessionStorage 讀寫（無痕 / 被擋時當沒有）。/ sessionStorage access; unavailable = nothing stored. */
export function loadShells(key: string): string[] {
    try {
        return parseShellList(sessionStorage.getItem(key));
    } catch {
        return [];
    }
}

export function updateShells(key: string, fn: (list: string[]) => string[]): void {
    try {
        const next = fn(parseShellList(sessionStorage.getItem(key)));
        if (next.length) sessionStorage.setItem(key, JSON.stringify(next));
        else sessionStorage.removeItem(key);
    } catch {
        /* sessionStorage 不可用 / unavailable */
    }
}

// ---------------------------------------------------------------- 時間軸圖 / timeline diagram

/** 圖上這次要表現的狀態。preview = 偏好設定裡的說明。/ What the diagram shows; preview = the explainer in Preferences. */
export type DetachPhase = "preview" | "connected" | "detached" | "resumed" | "ended";
export type StepState = "done" | "active" | "waiting" | "skipped" | "failed";
export type StepId = "connected" | "drop" | "kept" | "resume" | "end";

export interface TimelineStep {
    id: StepId;
    state: StepState;
}

/**
 * 時間軸每一段的狀態：連著 ─ 斷線 ─ 保留（0 秒 = 跳過）─ 接回 | 時間到。
 * Each step's state: connected ─ drop ─ kept (skipped at 0 s) ─ resume | time's up.
 */
export function detachTimeline(phase: DetachPhase, secs: number): TimelineStep[] {
    const keeps = secs > 0;
    const s = (connected: StepState, drop: StepState, kept: StepState, resume: StepState, end: StepState): TimelineStep[] => [
        { id: "connected", state: connected },
        { id: "drop", state: drop },
        { id: "kept", state: keeps ? kept : "skipped" },
        { id: "resume", state: keeps ? resume : "skipped" },
        { id: "end", state: end },
    ];
    switch (phase) {
        case "preview":
            return s("done", "waiting", "waiting", "waiting", "waiting");
        case "connected":
            return s("active", "waiting", "waiting", "waiting", "waiting");
        case "detached":
            return s("done", "done", "active", "waiting", "waiting");
        case "resumed":
            return s("done", "done", "done", "done", "skipped");
        case "ended":
            return s("done", "done", "done", "skipped", "failed");
    }
}

/** 三層設定，給說明對話框列出來（哪一層決定的會被標出來）。/ The three layers, for the dialog (the decider is marked). */
export interface DetachLayer {
    layer: DetachDecider;
    /** user / site：秒數；tunnel：政策（null = 不知道是哪台裝置）。/ Seconds, or the policy (null = no device in view). */
    value: number | DetachPolicy | null;
    decides: boolean;
}

export function detachLayers(userSecs: number, siteMax: number, policy: DetachPolicy | null): DetachLayer[] {
    const { by } = effectiveDetach(userSecs, siteMax, policy ?? "user");
    return [
        { layer: "user", value: userSecs, decides: by === "user" },
        { layer: "site", value: siteMax, decides: by === "site" },
        { layer: "tunnel", value: policy, decides: by === "tunnel" },
    ];
}
