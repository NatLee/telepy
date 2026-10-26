/**
 * 指令規則與核准申請的型別（對應 `/api/command-rules`、`/api/command-requests` 與終端機的 binary 通知）。
 * Types for command rules, approval requests and the terminal's binary notices.
 */

/** 擋下 / 要核准 / 允許（例外：只豁免同範圍的規則）。/ block, approve, or allow (an exception within its own scope). */
export type RuleAction = "block" | "approve" | "allow";
export type RuleKind = "command" | "regex";
export type RuleWho = "everyone" | "sharees";
export type RuleVia = "all" | "terminal" | "agents";
export type RuleScope = "site" | "tunnel";

export interface CommandRule {
    id: number;
    tunnel_id: number | null;
    scope: RuleScope;
    action: RuleAction;
    kind: RuleKind;
    pattern: string;
    who: RuleWho;
    via: RuleVia;
    note: string;
    enabled: boolean;
    /** 「要核准」規則指定的核准人；空 = 擁有者 + Admin。/ The approvers an approve rule names; empty = owner + Admins. */
    approver_ids: number[];
    approvers: UserBrief[];
    created_at: string;
    updated_at: string;
}

export interface UserBrief {
    id: number;
    username: string;
}

export interface RuleInput {
    action: RuleAction;
    kind: RuleKind;
    pattern: string;
    who: RuleWho;
    via: RuleVia;
    note: string;
    enabled: boolean;
    approver_ids: number[];
}

export interface SiteRules {
    rules: CommandRule[];
    can_edit: boolean;
    /** 管理員才有（任何啟用中的帳號）。/ Admins only (any active account). */
    approver_candidates: UserBrief[];
}

export interface TunnelRules {
    tunnel: { id: number; name: string };
    rules: CommandRule[];
    site_rules: CommandRule[];
    can_edit: boolean;
    can_edit_site: boolean;
    /** 擁有者與 Admin sharee（能改規則的人才有）。/ The owner and Admin sharees (editors only). */
    approver_candidates: UserBrief[];
}

/** 比對到的規則（終端機通知、試跑結果）。/ A matched rule (terminal notices, the tester). */
export interface MatchedRule {
    id: number | null;
    scope: RuleScope;
    action?: RuleAction;
    kind: RuleKind;
    pattern: string;
    note: string;
    who?: RuleWho;
    via?: RuleVia;
    /** 規則指定的核准人（紀錄裡 = 當時能決定的人）。/ The rule's approvers (in a record: who could decide). */
    approver_ids?: number[];
}

export type RequestStatus = "blocked" | "pending" | "approved" | "denied" | "cancelled" | "expired";

export interface CommandRequest {
    id: number;
    tunnel_id: number;
    tunnel_name: string | null;
    user: { id: number; username: string };
    source: "terminal" | "agent";
    client: string | null;
    account: string;
    lan_host: string | null;
    command: string;
    rule: MatchedRule;
    status: RequestStatus;
    created_at: string;
    expires_at: string | null;
    decided_by: string | null;
    decided_at: string | null;
    reason: string;
    used: boolean;
    can_decide?: boolean;
    can_cancel?: boolean;
}

/** 一個範圍（全站 / 隧道）的結果。/ One scope's outcome. */
export interface ScopeVerdict {
    /** 符合的擋下 / 要核准規則（被豁免時也列出）。/ The block / approve rule that matched (listed even when exempted). */
    hit: MatchedRule | null;
    /** 豁免這個範圍的允許規則。/ The allow rule that exempts this scope. */
    allowed_by: MatchedRule | null;
    exempted: boolean;
}

export interface CheckVerdict {
    action: "allow" | RuleAction;
    rule: MatchedRule | null;
    /** 放行是因為這條允許規則。/ Allowed thanks to this allow rule. */
    allowed_by?: MatchedRule | null;
    site?: ScopeVerdict;
    tunnel?: ScopeVerdict;
    /** 要核准時誰決定（`default` = 擁有者 + Admin）。/ Who decides (`default` = owner + Admins). */
    approvers?: { default: boolean; users: UserBrief[] } | null;
}

export interface CheckResult {
    commands: { program: string; args: string[] }[];
    for_approvers: CheckVerdict;
    for_sharees: CheckVerdict;
    you_approve: boolean;
    draft?: { matches: boolean; error: string | null };
}

/** 終端機的指令規則通知（binary JSON frame）。/ The terminal's command notice (a binary JSON frame). */
export type TerminalCommandNotice =
    | { type: "command"; state: "blocked" | "error"; command: string; rule: MatchedRule }
    | { type: "command"; state: "pending"; command: string; rule: MatchedRule; request: CommandRequest; can_decide: boolean }
    | { type: "command"; state: "approved" | "denied" | "cancelled" | "expired"; request_id: number; by: string | null; reason: string | null };
