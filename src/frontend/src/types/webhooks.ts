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

export interface WebhookList {
    mine: Webhook[];
    site: Webhook[] | null;
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
