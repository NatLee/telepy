/**
 * Webhook 的型別（`/api/webhooks`）。/ Webhook types (`/api/webhooks`).
 */

export type WebhookScope = "user" | "site";
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
