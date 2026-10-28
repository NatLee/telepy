/**
 * Webhook 的型別（`/api/webhooks`）。/ Webhook types (`/api/webhooks`).
 */

export type WebhookScope = "user" | "site";
/** 全站 webhook 的模式：enforced = 沒人能退出；default = 隧道的 owner / ADMIN 可以把自己的隧道退出。
 *  A site webhook's mode: enforced = nobody opts out; default = tunnel owners / ADMINs may opt their tunnels out. */
export type WebhookMode = "enforced" | "default";

/** 一筆退出（給管理員看）。active = 退的人現在還管那條隧道（不管了就不算）。
 *  One opt-out (for admins). active = whoever opted out still manages the tunnel (otherwise it doesn't count). */
export interface WebhookOptOut {
    tunnel_id: number;
    tunnel_name: string | null;
    by: string | null;
    at: string;
    active: boolean;
}

/** 摘要裡：這個 webhook 涵蓋的、我管的一條隧道。/ In a summary: one tunnel I manage that the webhook covers. */
export interface ManagedTunnel {
    id: number;
    name: string;
    /** 有現在的管理者退出了。/ A current manager opted it out. */
    opted_out: boolean;
    /** 退出它的人（現在還管它的）。/ Who opted it out (still managing it). */
    by: string[];
    /** 我退的。/ I opted it out. */
    mine: boolean;
}
export type WebhookFormat = "auto" | "json" | "slack" | "discord" | "google_chat" | "teams" | "telegram" | "ntfy";
export type WebhookLanguage = "en" | "zh-TW" | "ja";
export type EventGroup = "status" | "device" | "sharing" | "commands" | "sessions" | "account" | "keys" | "admin";
export type EventAudience = "tunnel" | "managers" | "managers_others" | "share_parties" | "you" | "agent_and_owner" | "site";

export interface CatalogEvent {
    event: string;
    group: EventGroup;
    audience: EventAudience;
    /** 狀態事件：套用延遲。/ A status event: the delay applies. */
    status: boolean;
    /** 跟某條隧道有關：套用隧道篩選。/ About a tunnel: the tunnel filter applies. */
    tunnel: boolean;
    severity: "info" | "ok" | "warning";
}

export interface WebhookHeader {
    name: string;
    value: string;
}

export interface WebhookLast {
    status: "ok" | "failed";
    at: string | null;
    http_status: number | null;
    error: string;
}

export interface Webhook {
    id: number;
    scope: WebhookScope;
    name: string;
    url: string;
    host: string;
    format: WebhookFormat;
    format_resolved: WebhookFormat | null;
    language: WebhookLanguage;
    events: string[];
    all_tunnels: boolean;
    tunnels: { id: number; name: string | null }[];
    delay: number;
    enabled: boolean;
    paused_reason: "failing" | null;
    failures: number;
    last: WebhookLast | null;
    headers: WebhookHeader[];
    /** 自訂 header 解不開（伺服器換了 SECRET_KEY），要重新輸入。/ The custom headers can't be opened any more. */
    headers_unreadable: boolean;
    created_by: string | null;
    /** 全站的才有；舊後端沒有。/ Site webhooks only; missing from older backends. */
    mode?: WebhookMode | null;
    optouts?: WebhookOptOut[];
    created_at: string;
    updated_at: string;
}

export interface WebhookPolicy {
    personal_enabled: boolean;
    private_targets: boolean;
    max: number;
    used: number;
    pause_after: number;
    per_minute: number;
}

/** 全站 webhook 的摘要，每個登入者都拿得到（沒有網址、header、密鑰）。
 *  A redacted site-wide webhook every signed-in user gets (no URL, headers or secret). */
export interface SiteWebhookSummary {
    id: number;
    /** 沒取名（= 網址的主機）時非管理員拿到 null。/ null for non-admins when it was left unnamed (= the URL's host). */
    name: string | null;
    /** 實際的送出格式（auto 已依網址判斷）。/ The effective format (auto resolved from the URL). */
    service: WebhookFormat | null;
    events: string[];
    all_tunnels: boolean;
    /** 選的隧道裡我看得到的，依名稱排序。/ Picked tunnels I can see, by name. */
    tunnels: { id: number; name: string }[];
    /** 選的隧道裡我看不到的數量。/ Picked tunnels I can't see. */
    hidden_tunnels: number;
    enabled: boolean;
    paused: boolean;
    /** 舊後端沒有（= default、沒有退出）。/ Missing from older backends (= default, no opt-outs). */
    mode?: WebhookMode;
    my_optout?: number[];
    managed?: ManagedTunnel[];
}

export interface WebhookList {
    mine: Webhook[];
    site: Webhook[] | null;
    /** 舊後端沒有。/ Missing from older backends. */
    site_summary?: SiteWebhookSummary[];
    catalog: { personal: CatalogEvent[]; site: CatalogEvent[] | null };
    policy: WebhookPolicy;
    can_manage_site: boolean;
    /** 全站 webhook 能限定的隧道（只給管理員）。/ Every tunnel, for site-wide webhooks (admins only). */
    site_tunnels: { id: number; name: string }[] | null;
    public_url: string | null;
}

export interface WebhookInput {
    scope?: WebhookScope;
    name: string;
    url: string;
    format: WebhookFormat;
    language: WebhookLanguage;
    events: string[];
    all_tunnels: boolean;
    tunnel_ids: number[];
    delay: number;
    enabled: boolean;
    headers: WebhookHeader[];
    /** 只有全站的會送。/ Sent for site webhooks only. */
    mode?: WebhookMode;
}

export interface WebhookDelivery {
    id: number;
    event: string;
    message_id: string;
    at: string;
    status: "ok" | "failed" | "skipped" | "sending";
    http_status: number | null;
    error: string;
    attempts: number;
    duration_ms: number;
    test: boolean;
    body: string;
    redelivered_from: number | null;
    can_redeliver: boolean;
}

export interface WebhookTestResult {
    ok: boolean;
    http_status: number | null;
    error: string | null;
    duration_ms: number;
}
