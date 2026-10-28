/**
 * 指令規則與核准申請的型別（對應 `/api/command-rules`、`/api/command-requests` 與終端機的 binary 通知）。
 * Types for command rules, approval requests and the terminal's binary notices.
 */

/** 擋下 / 要核准 / 允許（例外：只豁免同範圍的規則）。/ block, approve, or allow (an exception within its own scope). */
export type RuleAction = "block" | "approve" | "allow";
export type RuleKind = "command" | "regex";
/** everyone / sharees（ADMIN 以下）/ me（只有寫規則的人自己，個人規則才有）。/ me = only the rule's author (personal rules only). */
export type RuleWho = "everyone" | "sharees" | "me";
export type RuleVia = "all" | "terminal" | "agents";
/** site = 管理員的全站規則；personal = 某個人自己的。/ site = admins' site-wide rule; personal = someone's own. */
export type RuleScope = "site" | "personal";
/** 紀錄裡的範圍：多了 self（「只有我」）與升級前的 tunnel。/ The scope in records: also self ("only me") and the pre-upgrade tunnel. */
export type RecordScope = RuleScope | "self" | "tunnel";

/** 規則套用的一條隧道（`applies`：自己的個人規則才有，這裡算不算數）。/ A tunnel a rule covers. */
export interface RuleTunnel {
    id: number;
    name: string;
    applies?: boolean;
}

export interface CommandRule {
    id: number;
    scope: RuleScope;
    /** 個人規則的主人。/ The owner of a personal rule. */
    owner: UserBrief | null;
    /** 是我的個人規則。/ My own personal rule. */
    mine: boolean;
    /** 所有隧道（個人：我管的 / 我能用的全部）；否則只有 `tunnels`。/ Every tunnel; otherwise only `tunnels`. */
    all_tunnels: boolean;
    tunnels: RuleTunnel[];
    /** 我看不到的隧道有幾條。/ Covered tunnels I can't see. */
    hidden_tunnels: number;
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
    /** 新增時：personal（預設）/ site（管理員）。/ On create: personal (default) or site (admins). */
    scope?: RuleScope;
    action: RuleAction;
    kind: RuleKind;
    pattern: string;
    who: RuleWho;
    via: RuleVia;
    note: string;
    enabled: boolean;
    approver_ids: number[];
    all_tunnels: boolean;
    tunnel_ids: number[];
}

/** 規則表單的隧道選項（`manage` = 我是 owner / ADMIN）。/ A tunnel choice (`manage` = I own or administer it). */
export interface TunnelChoice {
    id: number;
    name: string;
    manage?: boolean;
}

/** `GET /api/command-rules`。 */
export interface RulesList {
    mine: CommandRule[];
    site: CommandRule[];
    can_edit_site: boolean;
    limit: number;
    tunnels: TunnelChoice[];
    /** 個人規則可以指定的核准人。/ Who a personal rule may name. */
    approver_candidates: UserBrief[];
    /** 管理員才有（任何啟用中的帳號）。/ Admins only (any active account). */
    site_approver_candidates: UserBrief[];
    /** 管理員才有。/ Admins only. */
    site_tunnels: TunnelChoice[] | null;
}

export interface TunnelRules {
    tunnel: { id: number; name: string };
    /** 這裡算數的個人規則（owner / Admin 寫的與我自己的）。/ Personal rules in force here. */
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
    scope: RecordScope;
    /** 個人規則的主人（終端機通知、試跑結果）。/ The personal rule's owner (terminal notices, the tester). */
    owner?: UserBrief | null;
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

/** 一個範圍（全站 / 個人）的結果。/ One scope's outcome (site-wide / personal). */
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
    personal?: ScopeVerdict;
    /** 升級前的後端。/ A pre-upgrade backend. */
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
