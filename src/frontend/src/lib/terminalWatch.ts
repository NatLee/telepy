/**
 * 看別人的網頁終端機（唯讀，可申請一起打字）的純邏輯：解析 `/ws/terminal-watch/` 與 `/ws/terminal/` 的 binary frame、
 * 控制權狀態、說明圖每一站的狀態。`terminalWatch.test.ts` 有測試。
 * Pure helpers for watching a web terminal (read-only, with a request to type): parsing the binary frames of
 * `/ws/terminal-watch/` and `/ws/terminal/`, the control state, and the explainer diagram's spot states.
 */
import type { SpotState } from "./flow.ts";

/** 4015：shell 已經不在了（結束了、時間到），原因 `ended` / `shell_gone`。/ The shell is gone. */
export const WATCH_GONE_CLOSE_CODE = 4015;

export interface WatcherInfo {
    /** 看的人那條連線的 id（presence id）。/ The watching connection's id. */
    id: number;
    username: string;
    since: string;
    /** 現在能打字。/ May type now. */
    control: boolean;
    /** 想打字、等你決定。/ Asked to type; waiting for you. */
    requested: boolean;
}

/** `{type:"watchers"}`：誰在看、誰能打字。/ Who watches and who may type. */
export interface WatchersFrame {
    type: "watchers";
    watchers: WatcherInfo[];
    control: number | null;
}

/** 觀看開始（或跟不上後重來）的第一個 frame。/ The first frame of a watch (or of a rejoin). */
export interface WatchStart {
    type: "watch";
    shell: string;
    you: number;
    user: { id: number; username: string };
    tunnel: { id: number; name: string };
    account: string;
    lan_host: string | null;
    size: { cols: number; rows: number };
    detached: boolean;
    can_force: boolean;
    recorded: boolean;
    watchers: WatchersFrame;
    reset: boolean;
}

export type WatchEvent =
    | WatchStart
    | WatchersFrame
    | { type: "resize"; cols: number; rows: number }
    | { type: "detached"; detached: boolean }
    | { type: "command"; state: string; command?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function asWatchers(v: unknown): WatchersFrame | null {
    if (!isObj(v) || v.type !== "watchers" || !Array.isArray(v.watchers)) return null;
    const watchers = v.watchers.filter(isObj).map((w) => ({
        id: Number(w.id),
        username: String(w.username ?? ""),
        since: String(w.since ?? ""),
        control: w.control === true,
        requested: w.requested === true,
    }));
    return { type: "watchers", watchers, control: typeof v.control === "number" ? v.control : null };
}

/** 解析看的人那條 socket 的 binary frame（`pong` 與壞掉的 JSON = null）。/ Parse a binary frame of the watch socket. */
export function parseWatchEvent(text: string): WatchEvent | null {
    if (text === "pong") return null;
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isObj(v)) return null;
    switch (v.type) {
        case "watchers":
            return asWatchers(v);
        case "watch": {
            const watchers = asWatchers(v.watchers) ?? { type: "watchers", watchers: [], control: null };
            const size = isObj(v.size) ? v.size : {};
            const user = isObj(v.user) ? v.user : {};
            const tunnel = isObj(v.tunnel) ? v.tunnel : {};
            return {
                type: "watch",
                shell: String(v.shell ?? ""),
                you: Number(v.you),
                user: { id: Number(user.id), username: String(user.username ?? "") },
                tunnel: { id: Number(tunnel.id), name: String(tunnel.name ?? "") },
                account: String(v.account ?? ""),
                lan_host: typeof v.lan_host === "string" ? v.lan_host : null,
                size: { cols: Number(size.cols) || 80, rows: Number(size.rows) || 24 },
                detached: v.detached === true,
                can_force: v.can_force === true,
                recorded: v.recorded === true,
                watchers,
                reset: v.reset === true,
            };
        }
        case "resize":
            return Number(v.cols) > 0 && Number(v.rows) > 0 ? { type: "resize", cols: Number(v.cols), rows: Number(v.rows) } : null;
        case "detached":
            return { type: "detached", detached: v.detached === true };
        case "command":
            return typeof v.state === "string" ? { type: "command", state: v.state, command: typeof v.command === "string" ? v.command : undefined } : null;
        default:
            return null;
    }
}

/** 被看的人那條 `/ws/terminal/` 的 `watchers` frame（其他 = null）。/ The watchers frame on the watched user's socket. */
export function parseWatchersFrame(text: string): WatchersFrame | null {
    try {
        return asWatchers(JSON.parse(text));
    } catch {
        return null;
    }
}

export type ControlState = "none" | "requested" | "granted";

/** 我（看的人）現在的控制權狀態。/ My control state as a watcher. */
export function controlState(frame: WatchersFrame | null, you: number | null): ControlState {
    if (!frame || you === null) return "none";
    if (frame.control === you) return "granted";
    return frame.watchers.some((w) => w.id === you && w.requested) ? "requested" : "none";
}

/** 等被看的人決定的申請（給提示列）。/ Requests waiting for the watched user. */
export function pendingRequests(frame: WatchersFrame | null): WatcherInfo[] {
    return frame?.watchers.filter((w) => w.requested && !w.control) ?? [];
}

/** 正在一起打字的人。/ Who is typing along right now. */
export function controller(frame: WatchersFrame | null): WatcherInfo | null {
    if (!frame || frame.control === null) return null;
    return frame.watchers.find((w) => w.id === frame.control) ?? null;
}

/** 在看的人（同一個人開兩個視窗只算一次）。/ Distinct watcher names. */
export function watcherNames(frame: WatchersFrame | null): string[] {
    return [...new Set(frame?.watchers.map((w) => w.username) ?? [])];
}

/** 說明圖的情境。/ What the explainer shows. */
export type WatchPhase = "connecting" | "watching" | "requested" | "control" | "detached" | "ended" | "refused";

/** 由連線狀態推出情境。/ The phase from the connection state. */
export function watchPhase(s: { open: boolean; closeCode: number | null; detached: boolean; control: ControlState }): WatchPhase {
    if (s.closeCode !== null) return s.closeCode === 4004 || s.closeCode === 4008 ? "refused" : "ended";
    if (!s.open) return "connecting";
    if (s.detached) return "detached";
    if (s.control === "granted") return "control";
    if (s.control === "requested") return "requested";
    return "watching";
}

/** 說明圖每個點與每段線的狀態。/ The state of each node and link in the explainer diagram. */
export interface WatchSpots {
    theirBrowser: SpotState;
    telepy: SpotState;
    device: SpotState;
    yourBrowser: SpotState;
    /** 他們的瀏覽器 ─ Telepy。/ Their browser ─ Telepy. */
    theirLink: SpotState;
    /** Telepy ─ 裝置（一條 SSH 登入）。/ Telepy ─ device (one SSH login). */
    deviceLink: SpotState;
    /** Telepy ─ 你的瀏覽器（看）。/ Telepy ─ your browser (watching). */
    yourLink: SpotState;
    /** 你的按鍵會不會送出去。/ Whether your keys go through. */
    yourKeys: "off" | "asking" | "on";
}

export function watchSpots(phase: WatchPhase): WatchSpots {
    const ok: SpotState = "ok";
    const base: WatchSpots = { theirBrowser: ok, telepy: ok, device: ok, yourBrowser: ok, theirLink: ok, deviceLink: ok, yourLink: ok, yourKeys: "off" };
    switch (phase) {
        case "connecting":
            return { ...base, yourBrowser: "active", yourLink: "active" };
        case "watching":
            return base;
        case "requested":
            return { ...base, yourKeys: "asking", theirBrowser: "active" };
        case "control":
            return { ...base, yourKeys: "on" };
        // 他們斷線了，shell 照跑；你照樣看得到。/ They dropped; the shell runs on and you still watch.
        case "detached":
            return { ...base, theirBrowser: "waiting", theirLink: "failed" };
        case "ended":
            return { theirBrowser: "waiting", telepy: ok, device: "waiting", yourBrowser: "waiting", theirLink: "waiting", deviceLink: "waiting", yourLink: "waiting", yourKeys: "off" };
        case "refused":
            return { ...base, theirBrowser: "waiting", theirLink: "waiting", device: "waiting", deviceLink: "waiting", yourLink: "failed", yourBrowser: "failed" };
    }
}

/** 關閉碼 → 說明文字的 key 後綴（`watch.closed.<x>`）。/ Close code → the message key suffix. */
export function watchCloseReason(code: number, reason: string): "ended" | "gone" | "refused" | "stepUp" | "endedBy" | "signedOut" | "dropped" {
    if (code === WATCH_GONE_CLOSE_CODE) return reason === "ended" ? "ended" : "gone";
    if (code === 4004) return "refused";
    if (code === 4008) return "stepUp";
    if (code === 4009) return "endedBy";
    if (code === 4010) return "signedOut";
    return "dropped";
}
