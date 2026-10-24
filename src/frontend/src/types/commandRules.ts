/**
 * 指令規則與核准申請的型別（對應 `/api/command-rules`、`/api/command-requests` 與終端機的 binary 通知）。
 * Types for command rules, approval requests and the terminal's binary notices.
 */

export type RuleAction = "block" | "approve";
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
    created_at: string;
    updated_at: string;
}

export interface RuleInput {
    action: RuleAction;
    kind: RuleKind;
    pattern: string;
    who: RuleWho;
    via: RuleVia;
    note: string;
    enabled: boolean;
}

export interface TunnelRules {
    tunnel: { id: number; name: string };
    rules: CommandRule[];
    site_rules: CommandRule[];
    can_edit: boolean;
    can_edit_site: boolean;
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

export interface CheckVerdict {
    action: "allow" | RuleAction;
    rule: MatchedRule | null;
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
