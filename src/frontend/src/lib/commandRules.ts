/**
 * 指令規則的純函式：終端機 binary frame 的解析、核准清單的合併、倒數、狀態標籤與歷史篩選。
 * Pure helpers for command rules: parsing the terminal's binary frames, merging the approval list, countdowns,
 * status labels and the history filter.
 */
import type { TranslationKey } from "../locales/en.ts";
import type { CommandRequest, CommandRule, MatchedRule, RequestStatus, RuleAction, RuleInput, RuleVia, RuleWho, TerminalCommandNotice } from "../types/commandRules.ts";

export const DEFAULT_RULE: RuleInput = { action: "block", kind: "command", pattern: "", who: "everyone", via: "all", note: "", enabled: true };

export function ruleToInput(r: CommandRule): RuleInput {
    return { action: r.action, kind: r.kind, pattern: r.pattern, who: r.who, via: r.via, note: r.note, enabled: r.enabled };
}

export const ACTION_KEY: Record<RuleAction, TranslationKey> = { block: "commands.action.block", approve: "commands.action.approve" };
export const WHO_KEY: Record<RuleWho, TranslationKey> = { everyone: "commands.who.everyone", sharees: "commands.who.sharees" };
export const VIA_KEY: Record<RuleVia, TranslationKey> = { all: "commands.via.all", terminal: "commands.via.terminal", agents: "commands.via.agents" };

export const STATUS_KEY: Record<RequestStatus, TranslationKey> = {
    blocked: "commands.status.blocked",
    pending: "commands.status.pending",
    approved: "commands.status.approved",
    denied: "commands.status.denied",
    cancelled: "commands.status.cancelled",
    expired: "commands.status.expired",
};

export type Tone = "neutral" | "success" | "warning" | "danger";

export const STATUS_TONE: Record<RequestStatus, Tone> = {
    blocked: "danger",
    pending: "warning",
    approved: "success",
    denied: "danger",
    cancelled: "neutral",
    expired: "neutral",
};

/**
 * `/ws/terminal/` 的 binary frame：`pong`（量延遲）或指令規則通知；其他（壞掉的 JSON）= null。
 * A binary frame from `/ws/terminal/`: a `pong` (latency) or a command notice; anything else is null.
 */
export function parseTerminalFrame(data: ArrayBuffer | Uint8Array): "pong" | TerminalCommandNotice | null {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const text = new TextDecoder().decode(bytes);
    if (text === "pong") return "pong";
    try {
        const v = JSON.parse(text) as { type?: string; state?: string };
        return v && v.type === "command" && typeof v.state === "string" ? (v as TerminalCommandNotice) : null;
    } catch {
        return null;
    }
}

/**
 * 核准中心要不要顯示這筆：我能核准、還在等，而且不是我自己在網頁終端機打的（那個在終端機上方就能處理）。
 * Whether the approval center shows a request: I can approve it, it is pending, and it is not my own web terminal
 * command (the terminal's banner handles that one).
 */
export function showsInCenter(req: CommandRequest, me: number | undefined, approverIds: number[] | undefined): boolean {
    if (me === undefined || req.status !== "pending") return false;
    const decides = req.can_decide ?? (approverIds ?? []).includes(me);
    return decides && !(req.user.id === me && req.source === "terminal");
}

/** 新申請進來（同 id 取代），新的在前。/ Add a request (replacing the same id), newest first. */
export function upsertRequest(list: CommandRequest[], req: CommandRequest): CommandRequest[] {
    return [req, ...list.filter((r) => r.id !== req.id)].sort((a, b) => b.id - a.id);
}

/** 已決定的申請拿掉。/ Drop a request that was decided. */
export function dropRequest(list: CommandRequest[], id: number): CommandRequest[] {
    return list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : list;
}

/** 到期還有幾秒（沒有期限 = null，過了 = 0）。/ Seconds until `expires` (null without one, 0 once past). */
export function secondsLeft(expires: string | null | undefined, now: number = Date.now()): number | null {
    if (!expires) return null;
    const at = Date.parse(expires);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.round((at - now) / 1000));
}

/** `4:05`、`1:02:03`。/ A countdown clock. */
export function countdown(secs: number): string {
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type HistoryFilter = "all" | "pending" | "blocked" | "approved" | "notRun";

/** 歷史篩選：「沒跑」= 拒絕、逾時、撤回。/ The history filter; "not run" = denied, expired or withdrawn. */
export function matchesFilter(req: CommandRequest, f: HistoryFilter): boolean {
    switch (f) {
        case "all":
            return true;
        case "notRun":
            return req.status === "denied" || req.status === "expired" || req.status === "cancelled";
        default:
            return req.status === f;
    }
}

export function countByFilter(list: CommandRequest[]): Record<HistoryFilter, number> {
    const out: Record<HistoryFilter, number> = { all: 0, pending: 0, blocked: 0, approved: 0, notRun: 0 };
    for (const r of list) {
        for (const f of Object.keys(out) as HistoryFilter[]) if (matchesFilter(r, f)) out[f] += 1;
    }
    return out;
}

/** 常見的規則，給「新增規則」一鍵帶入。/ Common rules, one click away in the add dialog. */
export const RULE_PRESETS: { action: RuleAction; kind: "command" | "regex"; pattern: string }[] = [
    { action: "block", kind: "command", pattern: "rm -rf /" },
    { action: "block", kind: "command", pattern: "mkfs*" },
    { action: "block", kind: "command", pattern: "dd of=/dev/*" },
    { action: "approve", kind: "command", pattern: "sudo" },
    { action: "approve", kind: "command", pattern: "reboot" },
    { action: "approve", kind: "command", pattern: "shutdown" },
    { action: "approve", kind: "command", pattern: "systemctl stop" },
    { action: "block", kind: "regex", pattern: "curl .*\\|\\s*(ba)?sh" },
];

/** 終端機上方提示列的狀態。/ The state of the banner above a terminal. */
export interface HoldBanner {
    state: "pending" | "blocked" | "error" | "approved" | "denied" | "cancelled" | "expired";
    command: string;
    rule: MatchedRule | null;
    requestId: number | null;
    expiresAt: string | null;
    /** 我自己就能核准（owner / ADMIN）。/ I can approve it myself (owner / ADMIN). */
    canDecide: boolean;
    by: string | null;
    reason: string | null;
}

/**
 * 收到一則終端機通知後的提示列：結果通知沒有指令與規則，從同一筆申請的上一個狀態帶過來。
 * The banner after a terminal notice; outcome notices carry no command or rule, so they come from the same request's
 * previous state.
 */
export function nextBanner(prev: HoldBanner | null, n: TerminalCommandNotice): HoldBanner {
    switch (n.state) {
        case "blocked":
        case "error":
            return { state: n.state, command: n.command, rule: n.rule, requestId: null, expiresAt: null, canDecide: false, by: null, reason: null };
        case "pending":
            return { state: "pending", command: n.command, rule: n.rule, requestId: n.request.id, expiresAt: n.request.expires_at, canDecide: n.can_decide, by: null, reason: null };
        default: {
            const same = prev && prev.requestId === n.request_id ? prev : null;
            return {
                state: n.state,
                command: same?.command ?? "",
                rule: same?.rule ?? null,
                requestId: n.request_id,
                expiresAt: null,
                canDecide: false,
                by: n.by,
                reason: n.reason || null,
            };
        }
    }
}

/** 自己會消失的狀態與時間（毫秒）；null = 等使用者關。/ States that fade on their own (ms); null = until closed. */
export function bannerLifetime(state: HoldBanner["state"]): number | null {
    switch (state) {
        case "approved":
        case "cancelled":
            return 4000;
        case "pending":
            return null;
        default:
            return 15000;
    }
}
