/**
 * 指令規則的純函式：終端機 binary frame 的解析、核准清單的合併、倒數、狀態標籤與歷史篩選。
 * Pure helpers for command rules: parsing the terminal's binary frames, merging the approval list, countdowns,
 * status labels and the history filter.
 */
import type { TranslationKey } from "../locales/en.ts";
import type { CheckResult, CheckVerdict, CommandRequest, CommandRule, MatchedRule, RequestStatus, RuleAction, RuleInput, RuleScope, RuleVia, RuleWho, ScopeVerdict, TerminalCommandNotice, TunnelChoice } from "../types/commandRules.ts";

export const DEFAULT_RULE: RuleInput = { action: "block", kind: "command", pattern: "", who: "everyone", via: "all", note: "", enabled: true, approver_ids: [], all_tunnels: true, tunnel_ids: [], mode: "default", approval_timeout: null };

/** 新規則的起點：選了一條隧道就先只套用它。/ A new rule's starting point: limited to the tunnel on screen, if any. */
export function newRuleInput(tunnelId: number | null): RuleInput {
    return tunnelId ? { ...DEFAULT_RULE, all_tunnels: false, tunnel_ids: [tunnelId] } : DEFAULT_RULE;
}

export function ruleToInput(r: CommandRule): RuleInput {
    return {
        action: r.action,
        kind: r.kind,
        pattern: r.pattern,
        who: r.who,
        via: r.via,
        note: r.note,
        enabled: r.enabled,
        approver_ids: r.approver_ids ?? [],
        all_tunnels: r.all_tunnels ?? true,
        tunnel_ids: (r.tunnels ?? []).map((x) => x.id),
        mode: r.mode ?? "default",
        approval_timeout: r.approval_timeout ?? null,
    };
}

/** 等待時間的說法（「5 分鐘」「1 小時」），照語言。/ A wait in words ("5 minutes", "1 hour"), per locale. */
export function formatWait(secs: number, locale: string): string {
    const [n, unit] = secs % 86400 === 0 ? [secs / 86400, "day"] : secs % 3600 === 0 ? [secs / 3600, "hour"] : secs % 60 === 0 ? [secs / 60, "minute"] : [secs, "second"];
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(n);
}

/** 規則自己的核准等待可以選的（秒）；超過網站上限的不列。/ Approval waits a rule may pick (s), within the site ceiling. */
export function timeoutChoices(max: number): number[] {
    return [60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400].filter((s) => s <= max);
}

/** 看一條隧道時：「在這條隧道上關掉」切換後我的關掉清單（`null` = 不再關掉任何地方）。我原本關掉全部時，換成我管的其餘隧道。
 *  On one tunnel: my "off" list after flipping "off on this tunnel" (`null` = off nowhere). When I had it off on all my
 *  tunnels, turning this one back on keeps it off on the rest of the tunnels I manage. */
export function flipOffHere(
    current: { all_tunnels: boolean; tunnels: { id: number }[] } | null,
    tunnelId: number,
    managed: number[],
    off: boolean,
): { all_tunnels: boolean; tunnel_ids: number[] } | null {
    const base = current ? (current.all_tunnels ? managed : current.tunnels.map((x) => x.id)) : [];
    const ids = off ? [...new Set([...base, tunnelId])] : base.filter((id) => id !== tunnelId);
    if (current?.all_tunnels && off) return { all_tunnels: true, tunnel_ids: [] };
    return ids.length === 0 ? null : { all_tunnels: false, tunnel_ids: ids.sort((a, b) => a - b) };
}

/** 一條規則在各層的樣子（「誰說了算」圖）。/ A rule at each layer (the "who decides" diagram). */
export interface RuleLayers {
    /** 第一層：全站（強制 / 允許覆寫）或某人的個人規則。/ Layer 1: site-wide (locked or overridable) or someone's own. */
    source: { kind: "site"; locked: boolean } | { kind: "personal"; owner: string | null; mine: boolean };
    /** 第二層：隧道的擁有者 / Admin。/ Layer 2: the tunnel's owner / Admins. */
    tunnel:
        | { state: "na" }
        | { state: "locked" }
        | { state: "off"; by: string[] }
        | { state: "follows" }
        | { state: "mineAll" }
        | { state: "mineSome"; count: number }
        | { state: "mineNone"; canChange: boolean };
    /** 第三層：你自己（只有提醒能靜音）。/ Layer 3: you (only reminders can be muted). */
    me: { state: "na" } | { state: "locked" } | { state: "muted" } | { state: "follows" };
    result: "applies" | "off" | "muted" | "notHere" | "offOnMine";
}

/**
 * 一條規則經過各層之後怎樣：全站強制的誰都蓋不過；允許覆寫的，隧道的擁有者 / Admin 可以在自己的隧道關掉、提醒每個人可以
 * 替自己靜音；個人規則只有作者能改（別人只能靜音它的提醒）。`tunnelId` = 正在看的隧道（沒有 = 我所有的隧道）。
 * A rule through the layers: an enforced site rule can't be overridden; an overridable one can be turned off by a
 * tunnel's owner / Admins on their tunnels, and anyone may mute a reminder for themselves; a personal rule is changed
 * by its author only (others may only mute its reminders). `tunnelId` = the tunnel on screen (none = all of mine).
 */
export function ruleLayers(rule: CommandRule, here: { tunnelId: number | null; managesSome: boolean }): RuleLayers {
    const site = rule.scope === "site";
    const locked = site && rule.mode === "enforced";
    const source: RuleLayers["source"] = site ? { kind: "site", locked } : { kind: "personal", owner: rule.owner?.username ?? null, mine: rule.mine };
    let tunnel: RuleLayers["tunnel"];
    if (!site || rule.action === "allow") tunnel = { state: "na" };
    else if (locked) tunnel = { state: "locked" };
    else if (here.tunnelId !== null) tunnel = (rule.off_here ?? []).length > 0 ? { state: "off", by: (rule.off_here ?? []).map((u) => u.username) } : { state: "follows" };
    else {
        const off = rule.my_override?.off ?? null;
        tunnel = !off ? { state: "mineNone", canChange: here.managesSome } : off.all_tunnels ? { state: "mineAll" } : { state: "mineSome", count: off.tunnels.length };
    }
    let me: RuleLayers["me"];
    if (rule.action !== "warn") me = { state: "na" };
    else if (locked) me = { state: "locked" };
    else me = rule.my_override?.muted ? { state: "muted" } : { state: "follows" };
    let result: RuleLayers["result"];
    if (here.tunnelId !== null && !coversTunnel(rule, here.tunnelId)) result = "notHere";
    else if (tunnel.state === "off") result = "off";
    else if (me.state === "muted") result = "muted";
    else if (tunnel.state === "mineAll") result = "offOnMine";
    else result = "applies";
    return { source, tunnel, me, result };
}

/**
 * 表單裡這條隧道能不能勾：全站規則與「只有我」= 都可以；管別人的個人規則 = 我是 owner / Admin 的才行（已經在規則裡的照樣
 * 留著，才拿得掉）。
 * Whether a tunnel can be ticked in the form: site rules and "only me" = any; a personal rule about other people =
 * only tunnels I own or administer (ones already on the rule stay tickable so they can be removed).
 */
export function tunnelPickable(t: TunnelChoice, who: RuleWho, site: boolean, already: boolean): boolean {
    return site || who === "me" || already || t.manage !== false;
}

/** 表單送出前：管別人的規則勾了不能管的隧道就拿掉（換成「管別人」時）。/ Drop unmanaged tunnels when the rule is about other people. */
export function pickableIds(ids: number[], tunnels: TunnelChoice[], who: RuleWho, site: boolean, kept: number[]): number[] {
    const byId = new Map(tunnels.map((t) => [t.id, t]));
    return ids.filter((id) => {
        const t = byId.get(id);
        return t ? tunnelPickable(t, who, site, kept.includes(id)) : kept.includes(id);
    });
}

/** 規則套用範圍的說法：所有隧道（哪一種）或列出的幾條。/ How a rule's reach reads: every tunnel (which kind) or the listed ones. */
export type Coverage =
    | { kind: "every"; whose: "site" | "managed" | "used" | "theirs" }
    | { kind: "some"; tunnels: { id: number; name: string; applies: boolean }[]; hidden: number };

export function ruleCoverage(r: CommandRule): Coverage {
    if (r.all_tunnels) {
        const whose = r.scope === "site" ? "site" : !r.mine ? "theirs" : r.who === "me" ? "used" : "managed";
        return { kind: "every", whose };
    }
    return { kind: "some", tunnels: (r.tunnels ?? []).map((x) => ({ id: x.id, name: x.name, applies: x.applies !== false })), hidden: r.hidden_tunnels ?? 0 };
}

/** 這條規則會不會套用到這條隧道（給「這條隧道上」的篩選）。/ Whether a rule covers a tunnel (for the per-tunnel filter). */
export function coversTunnel(r: CommandRule, tunnelId: number): boolean {
    return r.all_tunnels || (r.tunnels ?? []).some((x) => x.id === tunnelId);
}

/**
 * 比對到的規則是誰的：全站、我自己的（含「只有我」）、某人的，或說不出是誰的個人規則（舊紀錄）。
 * Whose rule matched: site-wide, mine (incl. "only me"), someone else's, or a personal rule of unknown author (old records).
 */
export function ruleSource(rule: Pick<MatchedRule, "scope" | "owner">, me: number | undefined): { key: TranslationKey; name?: string } {
    if (rule.scope === "site") return { key: "commands.matchedSiteRule" };
    if (rule.scope === "self" || (rule.owner && rule.owner.id === me)) return { key: "commands.matchedOwnRule" };
    if (rule.owner?.username) return { key: "commands.matchedRuleBy", name: rule.owner.username };
    return { key: "commands.matchedPersonalRule" };
}

export const ACTION_KEY: Record<RuleAction, TranslationKey> = { block: "commands.action.block", approve: "commands.action.approve", warn: "commands.action.warn", allow: "commands.action.allow" };
export const ACTION_TONE: Record<RuleAction, Tone> = { block: "danger", approve: "warning", warn: "neutral", allow: "success" };
export const WHO_KEY: Record<RuleWho, TranslationKey> = { everyone: "commands.who.everyone", sharees: "commands.who.sharees", me: "commands.who.me" };
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
    { action: "warn", kind: "command", pattern: "systemctl restart" },
    { action: "block", kind: "regex", pattern: "curl .*\\|\\s*(ba)?sh" },
];

/** 終端機上方提示列的狀態。/ The state of the banner above a terminal. */
export interface HoldBanner {
    state: "pending" | "blocked" | "error" | "warned" | "approved" | "denied" | "cancelled" | "expired";
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
        case "warned":
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

// ---------------------------------------------------------------- the decision diagram

/** 一個範圍在圖上的狀態。/ What a scope shows on the diagram. */
export type ScopeStep =
    /** 沒有規則符合。/ No rule matched. */
    | "none"
    /** 擋下規則符合（而且算數）。/ A block rule matched and counts. */
    | "block"
    /** 要核准規則符合（而且算數）。/ An approve rule matched and counts. */
    | "approve"
    /** 提醒規則符合（照跑）。/ A reminder matched (the command still runs). */
    | "warn"
    /** 擋下 / 要核准符合，但被同範圍的允許規則豁免。/ Caught, but exempted by an allow of this scope. */
    | "exempted"
    /** 只有允許規則符合（沒東西可豁免）。/ Only an allow matched (nothing to exempt). */
    | "allowOnly";

export type Outcome = "allow" | "block" | "approve" | "warn";

/** 指令在圖上走過的路。/ The path a command took through the diagram. */
export interface DecisionPath {
    outcome: Outcome;
    site: ScopeStep;
    personal: ScopeStep;
    /** 決定的那條規則在哪個範圍（放行 = null）。/ Which scope's rule decided (null when allowed). */
    decidedBy: RuleScope | null;
    /** 決定的規則 / 豁免的允許規則。/ The deciding rule / the allow that exempted. */
    rule: MatchedRule | null;
    allowedBy: MatchedRule | null;
    /** 要核准時：誰決定（null = 不是要核准）。/ For approve: who decides (null otherwise). */
    approvers: { byDefault: boolean; names: string[] } | null;
    /** 每個範圍符合的擋下 / 要核准規則與豁免它的允許規則（畫在那個範圍的格子裡）。/ Per scope: the caught rule and the allow. */
    scopes: Record<RuleScope, { hit: MatchedRule | null; allowedBy: MatchedRule | null }>;
}

/** 攔到的規則在圖上是哪一道。/ The lane a caught rule lights. */
export function caughtAs(action: RuleAction | undefined): "block" | "approve" | "warn" | null {
    return action === "block" || action === "approve" || action === "warn" ? action : null;
}

function scopeStep(v: ScopeVerdict | undefined): ScopeStep {
    if (!v) return "none";
    if (v.hit && v.allowed_by) return "exempted";
    if (v.hit) return caughtAs(v.hit.action) ?? "approve";
    return v.allowed_by ? "allowOnly" : "none";
}

/** 紀錄 / 通知裡的範圍 → 圖上的兩格（self 與升級前的 tunnel 都算個人）。/ A record scope → one of the two boxes. */
export function boxOf(scope: MatchedRule["scope"] | undefined): RuleScope | null {
    if (!scope) return null;
    return scope === "site" ? "site" : "personal";
}

/**
 * 從 `/api/command-rules/check` 的一個結果算出圖上要亮的路：每個範圍怎麼了、哪個範圍的規則決定了結果、誰核准。
 * 舊格式（沒有 site / personal）就只亮決定的那個範圍。
 * The highlighted path from one check verdict: what each scope did, which scope's rule decided, who approves. An
 * older verdict (without site / personal) lights only the deciding scope.
 */
export function decisionPath(v: CheckVerdict): DecisionPath {
    const outcome: Outcome = v.action === "block" || v.action === "approve" || v.action === "warn" ? v.action : "allow";
    const decidedBy = outcome === "allow" ? null : boxOf(v.rule?.scope);
    const personalVerdict = v.personal ?? v.tunnel;
    let site: ScopeStep;
    let personal: ScopeStep;
    if (v.site || personalVerdict) {
        site = scopeStep(v.site);
        personal = scopeStep(personalVerdict);
    } else {
        const caught: ScopeStep = outcome === "allow" ? "none" : outcome;
        site = decidedBy === "site" ? caught : "none";
        personal = decidedBy === "personal" ? caught : "none";
    }
    const approvers = outcome === "approve" ? { byDefault: v.approvers?.default ?? true, names: (v.approvers?.users ?? []).map((u) => u.username) } : null;
    const scopeRefs = (scope: RuleScope, sv: ScopeVerdict | undefined) => ({
        hit: sv ? sv.hit : decidedBy === scope ? (v.rule ?? null) : null,
        allowedBy: sv ? sv.allowed_by : null,
    });
    return {
        outcome,
        site,
        personal,
        decidedBy,
        rule: v.rule ?? null,
        allowedBy: v.allowed_by ?? null,
        approvers,
        scopes: { site: scopeRefs("site", v.site), personal: scopeRefs("personal", personalVerdict) },
    };
}

/** 試跑結果裡要畫的那一個：你是核准的人就看你的，否則看被分享的人的。/ The verdict to draw: yours when you approve, else the sharees'. */
export function verdictToDraw(r: CheckResult): CheckVerdict {
    return r.you_approve ? r.for_approvers : r.for_sharees;
}
