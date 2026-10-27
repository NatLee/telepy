/**
 * 網頁終端機的路徑圖（純函式）：階段、關閉碼 → 「卡在哪一段」與說明 key、每段的狀態。
 * 路徑：你的瀏覽器 ─web─ Telepy ─tunnel─ 裝置 ─reach─ shell（裝置自己的，或經裝置跳到的區網主機）。
 * 驅動終端機頁的 info 視覺說明（components/tunnels/TerminalFlow）。
 * Pure helpers for the web terminal's path diagram: phases, close code → the hop where it stopped plus the
 * explanation key, and the state of every spot. Path: browser ─web─ Telepy ─tunnel─ device ─reach─ shell
 * (on the device itself, or on a LAN host reached through it). Drives the terminal page's info diagram.
 */
import { statesAlong, type SpotState } from "./flow.ts";
import type { TranslationKey } from "@/locales/en";

export type TerminalPhase = "idle" | "connecting" | "connected" | "ended" | "failed";

export type TerminalSpot = "browser" | "web" | "telepy" | "tunnel" | "device" | "reach" | "target";

export const TERMINAL_SPOTS: readonly TerminalSpot[] = ["browser", "web", "telepy", "tunnel", "device", "reach", "target"];

export interface TerminalFailure {
    key: TranslationKey;
    vars?: Record<string, string | number>;
    at: TerminalSpot;
}

/**
 * WebSocket 關閉碼 → 失敗在哪一段。1000 / 1005（伺服器沒帶碼就關了 = shell 結束）= 正常結束（null）。
 * 區網主機的 4003 / 4004 意思不同（登入名 / 主機）。
 * Close code → where it stopped. 1000 / 1005 (closed without a code = the shell ended) = a normal end (null).
 * On a LAN host 4003 / 4004 mean the login name / the host instead of the device account / the tunnel.
 */
export function closeFailure(code: number, lan: boolean): TerminalFailure | null {
    switch (code) {
        case 1000:
        case 1005:
            return null;
        case 4001:
            return { key: "terminal.authFailedCard", at: "web" };
        case 4002:
            return { key: "terminal.notFoundCard", at: "telepy" };
        case 4003:
            return lan ? { key: "terminal.lanLoginInvalidCard", at: "target" } : { key: "terminal.invalidUsernameCard", at: "device" };
        case 4004:
            return lan ? { key: "terminal.lanHostMissingCard", at: "reach" } : { key: "terminal.permissionDeniedCard", at: "telepy" };
        case 4005:
            return { key: "terminal.flow.err.offline", at: "tunnel" };
        case 4006:
            return { key: "terminal.flow.err.noUsers", at: "device" };
        case 4007:
            return { key: "terminal.flow.err.enroll", at: "telepy" };
        case 4008:
            return { key: "stepUp.deniedCard", at: "telepy" };
        case 4009:
            return { key: "terminal.flow.err.ended", at: "telepy" };
        case 4010:
            return { key: "terminal.savedLoginCard", at: "telepy" };
        case 4012:
            return { key: "access.featureOffCard", at: "telepy" };
        case 1006:
            return { key: "terminal.flow.err.network", at: "web" };
    }
    return { key: "terminal.flow.err.generic", vars: { code }, at: "telepy" };
}

/** 分頁狀態 + 關閉碼 → 階段。/ A tab's status plus its close code → the phase. */
export function terminalPhase(status: "connecting" | "connected" | "closed" | null, closeCode: number | null | undefined, lan: boolean): { phase: TerminalPhase; failure: TerminalFailure | null } {
    if (status === null) return { phase: "idle", failure: null };
    if (status === "connecting") return { phase: "connecting", failure: null };
    if (status === "connected") return { phase: "connected", failure: null };
    const failure = closeFailure(closeCode ?? 1006, lan);
    return failure ? { phase: "failed", failure } : { phase: "ended", failure: null };
}

/**
 * 每段的狀態：連線中 = Telepy 到 shell 那幾段進行中；通了 = 全通；結束 = 全通但 shell 待命；失敗 = 那段標紅。
 * Spot states: connecting = the hops from Telepy to the shell are active; connected = all ok; ended = all ok but the
 * shell waits; failed = that spot red.
 */
export function terminalSpotStates(phase: TerminalPhase, failure: TerminalFailure | null): Record<TerminalSpot, SpotState> {
    if (phase === "idle") return statesAlong(TERMINAL_SPOTS, {});
    if (phase === "connected") return statesAlong(TERMINAL_SPOTS, { done: true });
    if (phase === "ended") return statesAlong(TERMINAL_SPOTS, { okUntil: "reach" });
    if (phase === "failed") return statesAlong(TERMINAL_SPOTS, { failedAt: failure?.at ?? "telepy" });
    return statesAlong(TERMINAL_SPOTS, { activeFrom: "web", activeTo: "target" });
}

/** 目前在做的那一步（0 = 還沒開始）。/ The step in progress (0 = not started). */
export function terminalStep(phase: TerminalPhase, failure: TerminalFailure | null, lan: boolean): number {
    const last = lan ? 4 : 3;
    if (phase === "idle") return 0;
    if (phase === "connected" || phase === "ended") return last;
    if (phase === "connecting") return 2;
    const at = failure?.at ?? "telepy";
    if (at === "web" || at === "telepy" || at === "device") return 1;
    if (at === "tunnel") return 2;
    return lan ? 3 : 3;
}
