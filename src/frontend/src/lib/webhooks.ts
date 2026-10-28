/**
 * Webhook 的純函式：事件的翻譯 key 與分組、網址認服務（跟後端同一套規則）、事件預設組合、表單預設值、狀態判斷與錯誤碼對照。
 * Pure helpers for webhooks: event translation keys and groups, recognising the service from a URL (same rules as
 * the backend), event presets, form defaults, the card state and error-code mapping.
 */
import type { TranslationKey } from "../locales/en.ts";
import type { CatalogEvent, EventAudience, EventGroup, SiteWebhookSummary, Webhook, WebhookFormat, WebhookHeader, WebhookInput, WebhookLanguage, WebhookScope } from "../types/webhooks.ts";

/** 每個事件的名稱與一句說明。/ Each event's name and one-line explanation. */
export const EVENT_KEYS: Record<string, { label: TranslationKey; hint: TranslationKey }> = {
    "tunnel.offline": { label: "webhooks.ev.tunnelOffline", hint: "webhooks.ev.tunnelOfflineHint" },
    "tunnel.online": { label: "webhooks.ev.tunnelOnline", hint: "webhooks.ev.tunnelOnlineHint" },
    "tunnel.degraded": { label: "webhooks.ev.tunnelDegraded", hint: "webhooks.ev.tunnelDegradedHint" },
    "tunnel.recovered": { label: "webhooks.ev.tunnelRecovered", hint: "webhooks.ev.tunnelRecoveredHint" },
    "tunnel.ip_changed": { label: "webhooks.ev.tunnelIpChanged", hint: "webhooks.ev.tunnelIpChangedHint" },
    "tunnel.host_key_changed": { label: "webhooks.ev.tunnelHostKeyChanged", hint: "webhooks.ev.tunnelHostKeyChangedHint" },
    "device.claim_attempt": { label: "webhooks.ev.deviceClaimAttempt", hint: "webhooks.ev.deviceClaimAttemptHint" },
    "tunnel.device_warning": { label: "webhooks.ev.tunnelDeviceWarning", hint: "webhooks.ev.tunnelDeviceWarningHint" },
    "share.received": { label: "webhooks.ev.shareReceived", hint: "webhooks.ev.shareReceivedHint" },
    "share.ended": { label: "webhooks.ev.shareEnded", hint: "webhooks.ev.shareEndedHint" },
    "access.requested": { label: "webhooks.ev.accessRequested", hint: "webhooks.ev.accessRequestedHint" },
    "access.decided": { label: "webhooks.ev.accessDecided", hint: "webhooks.ev.accessDecidedHint" },
    "command.approval_requested": { label: "webhooks.ev.commandApprovalRequested", hint: "webhooks.ev.commandApprovalRequestedHint" },
    "command.approval_decided": { label: "webhooks.ev.commandApprovalDecided", hint: "webhooks.ev.commandApprovalDecidedHint" },
    "command.blocked": { label: "webhooks.ev.commandBlocked", hint: "webhooks.ev.commandBlockedHint" },
    "session.started": { label: "webhooks.ev.sessionStarted", hint: "webhooks.ev.sessionStartedHint" },
    "session.watched": { label: "webhooks.ev.sessionWatched", hint: "webhooks.ev.sessionWatchedHint" },
    "mcp.session_opened": { label: "webhooks.ev.mcpSessionOpened", hint: "webhooks.ev.mcpSessionOpenedHint" },
    "mcp.session_closed": { label: "webhooks.ev.mcpSessionClosed", hint: "webhooks.ev.mcpSessionClosedHint" },
    "account.sign_in": { label: "webhooks.ev.accountSignIn", hint: "webhooks.ev.accountSignInHint" },
    "account.sign_in_new_device": { label: "webhooks.ev.accountSignInNewDevice", hint: "webhooks.ev.accountSignInNewDeviceHint" },
    "account.sign_in_failed": { label: "webhooks.ev.accountSignInFailed", hint: "webhooks.ev.accountSignInFailedHint" },
    "key.expiring": { label: "webhooks.ev.keyExpiring", hint: "webhooks.ev.keyExpiringHint" },
    "key.expired": { label: "webhooks.ev.keyExpired", hint: "webhooks.ev.keyExpiredHint" },
    "user.created": { label: "webhooks.ev.userCreated", hint: "webhooks.ev.userCreatedHint" },
    "webhook.test": { label: "webhooks.ev.test", hint: "webhooks.ev.testHint" },
};

export const GROUP_ORDER: EventGroup[] = ["status", "device", "sharing", "commands", "sessions", "account", "keys", "admin"];
export const GROUP_KEY: Record<EventGroup, TranslationKey> = {
    status: "webhooks.group.status",
    device: "webhooks.group.device",
    sharing: "webhooks.group.sharing",
    commands: "webhooks.group.commands",
    sessions: "webhooks.group.sessions",
    account: "webhooks.group.account",
    keys: "webhooks.group.keys",
    admin: "webhooks.group.admin",
};
export const AUDIENCE_KEY: Record<EventAudience, TranslationKey> = {
    tunnel: "webhooks.audience.tunnel",
    managers: "webhooks.audience.managers",
    managers_others: "webhooks.audience.managersOthers",
    share_parties: "webhooks.audience.shareParties",
    you: "webhooks.audience.you",
    agent_and_owner: "webhooks.audience.agentAndOwner",
    site: "webhooks.audience.site",
};

export const FORMATS: WebhookFormat[] = ["auto", "slack", "discord", "google_chat", "teams", "telegram", "ntfy", "json"];
export const FORMAT_KEY: Record<WebhookFormat, TranslationKey> = {
    auto: "webhooks.format.auto",
    json: "webhooks.format.json",
    slack: "webhooks.format.slack",
    discord: "webhooks.format.discord",
    google_chat: "webhooks.format.googleChat",
    teams: "webhooks.format.teams",
    telegram: "webhooks.format.telegram",
    ntfy: "webhooks.format.ntfy",
};
/** 卡片上的短名稱（產品名不翻）。/ Short names for cards (product names stay as they are). */
export const FORMAT_SHORT: Record<WebhookFormat, string> = {
    auto: "Auto",
    json: "JSON",
    slack: "Slack",
    discord: "Discord",
    google_chat: "Google Chat",
    teams: "Teams",
    telegram: "Telegram",
    ntfy: "ntfy",
};

export const LANGUAGES: { value: WebhookLanguage; label: string }[] = [
    { value: "en", label: "English" },
    { value: "zh-TW", label: "繁體中文" },
    { value: "ja", label: "日本語" },
];

/** 狀態告警的延遲選項（秒）。/ Status alert delays (seconds). */
export const DELAY_CHOICES = [0, 30, 60, 300, 900, 3600];

/** 從網址認服務；認不出來 = Telepy JSON，不是網址 = null。/ Recognise the service; unknown = JSON, not a URL = null. */
export function detectFormat(url: string): WebhookFormat | null {
    let u: URL;
    try {
        u = new URL(url.trim());
    } catch {
        return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (is("hooks.slack.com")) return "slack";
    if ((is("discord.com") || is("discordapp.com")) && u.pathname.startsWith("/api/webhooks/")) return "discord";
    if (host === "chat.googleapis.com") return "google_chat";
    if (is("webhook.office.com") || is("logic.azure.com") || is("powerplatform.com") || is("powerautomate.com")) return "teams";
    if (host === "api.telegram.org") return "telegram";
    if (host === "ntfy.sh" || host.startsWith("ntfy.")) return "ntfy";
    return "json";
}

/** 實際會用的格式（auto → 認出來的）。/ The format that will actually be used. */
export function effectiveFormat(format: WebhookFormat, url: string): WebhookFormat {
    return format === "auto" ? (detectFormat(url) ?? "json") : format;
}

export function urlLooksValid(url: string): boolean {
    return detectFormat(url) !== null;
}

/** 依目錄順序分組。/ Group the catalogue, in catalogue order. */
export function groupCatalog(catalog: CatalogEvent[]): { group: EventGroup; events: CatalogEvent[] }[] {
    return GROUP_ORDER.map((group) => ({ group, events: catalog.filter((e) => e.group === group) })).filter((g) => g.events.length > 0);
}

export type PresetId = "status" | "security" | "approvals" | "all";
export const PRESET_KEY: Record<PresetId, TranslationKey> = {
    status: "webhooks.preset.status",
    security: "webhooks.preset.security",
    approvals: "webhooks.preset.approvals",
    all: "webhooks.preset.all",
};
const PRESET_EVENTS: Record<Exclude<PresetId, "all">, string[]> = {
    status: ["tunnel.offline", "tunnel.online", "tunnel.degraded", "tunnel.recovered", "tunnel.device_warning"],
    security: ["tunnel.ip_changed", "tunnel.host_key_changed", "device.claim_attempt", "account.sign_in", "account.sign_in_new_device", "account.sign_in_failed", "key.expiring", "key.expired", "user.created"],
    approvals: ["access.requested", "command.approval_requested"],
};

/** 這個範圍有哪些預設組合（在目錄裡至少有一個事件的）。/ The presets that apply to a catalogue. */
export function presetsFor(catalog: CatalogEvent[]): PresetId[] {
    return (["status", "security", "approvals", "all"] as PresetId[]).filter((p) => presetEvents(p, catalog).length > 0);
}

export function presetEvents(id: PresetId, catalog: CatalogEvent[]): string[] {
    const names = catalog.map((e) => e.event);
    return id === "all" ? names : names.filter((n) => PRESET_EVENTS[id].includes(n));
}

export function sameEvents(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((x) => b.includes(x));
}

/** 依目錄順序排好、只留目錄裡有的。/ Sorted in catalogue order, unknown names dropped. */
export function orderEvents(events: string[], catalog: CatalogEvent[]): string[] {
    return catalog.map((e) => e.event).filter((n) => events.includes(n));
}

export function hasStatusEvent(events: string[], catalog: CatalogEvent[]): boolean {
    return catalog.some((e) => e.status && events.includes(e.event));
}

export function hasTunnelEvent(events: string[], catalog: CatalogEvent[]): boolean {
    return catalog.some((e) => e.tunnel && events.includes(e.event));
}

export function defaultInput(scope: WebhookScope, language: WebhookLanguage): WebhookInput {
    return { scope, name: "", url: "", format: "auto", language, events: PRESET_EVENTS.status, all_tunnels: true, tunnel_ids: [], delay: 60, enabled: true, headers: [] };
}

export function toInput(h: Webhook): WebhookInput {
    return {
        name: h.name,
        url: h.url,
        format: h.format,
        language: h.language,
        events: h.events,
        all_tunnels: h.all_tunnels,
        tunnel_ids: h.tunnels.map((t) => t.id),
        delay: h.delay,
        enabled: h.enabled,
        headers: h.headers.map((x) => ({ ...x })),
    };
}

/** 最多幾個自訂 header（跟後端一樣）。/ Custom headers per webhook (same as the backend). */
export const MAX_HEADERS = 10;
/** Telepy 自己設的、或會壞掉 HTTP 的 header（跟後端同一份）。/ Headers Telepy sets or that would break HTTP (same list as the backend). */
const RESERVED_HEADERS = [
    "host",
    "content-type",
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-authorization",
    "proxy-connection",
    "user-agent",
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
    "x-telepy-event",
];

/** 一個自訂 header 的問題（後端同樣規則）；沒問題回 null。全空的列不算（存的時候略過）。
 *  What is wrong with one custom header (same rules as the backend); null when fine. A blank row is ignored. */
export function headerProblem(h: WebhookHeader, all: WebhookHeader[]): TranslationKey | null {
    const name = h.name.trim();
    if (!name && !h.value) return null;
    if (!name || name.length > 64 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return "webhooks.headers.badName";
    if (RESERVED_HEADERS.includes(name.toLowerCase())) return "webhooks.headers.reserved";
    if (all.filter((x) => x.name.trim().toLowerCase() === name.toLowerCase()).length > 1) return "webhooks.headers.duplicate";
    if (!h.value || h.value.length > 2048 || !/^[\t\x20-\x7e]+$/.test(h.value)) return "webhooks.headers.badValue";
    return null;
}

/** 要存的 header：去掉全空的列、名稱去空白。/ The headers to save: blank rows dropped, names trimmed. */
export function headersToSave(list: WebhookHeader[]): WebhookHeader[] {
    return list.filter((h) => h.name.trim() || h.value).map((h) => ({ name: h.name.trim(), value: h.value }));
}

/** 介面語言 → webhook 語言。/ UI locale → webhook language. */
export function languageFor(locale: string): WebhookLanguage {
    return locale === "zh-TW" || locale === "ja" ? locale : "en";
}

export type HookState = "paused" | "off" | "failing" | "ok" | "never";

/** 卡片上的狀態：暫停（一直失敗）＞關閉＞最近一次失敗＞正常＞還沒送過。/ The card's state. */
export function hookState(h: Pick<Webhook, "enabled" | "paused_reason" | "last">): HookState {
    if (!h.enabled) return h.paused_reason ? "paused" : "off";
    if (!h.last) return "never";
    return h.last.status === "ok" ? "ok" : "failing";
}

/** 後端錯誤碼 → 翻譯 key。/ Backend error codes → translation keys. */
const ERROR_KEY: Record<string, TranslationKey> = {
    private_target: "webhooks.err.privateTarget",
    invalid_url: "webhooks.err.invalidUrl",
    unresolvable: "webhooks.err.unresolvable",
    no_events: "webhooks.err.noEvents",
    no_tunnels: "webhooks.err.noTunnels",
    limit: "webhooks.err.limit",
    personal_disabled: "webhooks.err.personalDisabled",
    admins_only: "webhooks.err.adminsOnly",
    secret_unreadable: "webhooks.err.secretUnreadable",
    not_redeliverable: "webhooks.err.notRedeliverable",
};

export function errorKey(code: unknown): TranslationKey | null {
    return typeof code === "string" ? (ERROR_KEY[code] ?? null) : null;
}

/** 送出的內容：JSON 就排好看，其他原樣。/ Pretty-print a JSON body; anything else as is. */
export function prettyBody(body: string): string {
    try {
        return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
        return body;
    }
}

/** 網址遮掉路徑裡像 token 的部分（卡片上顯示用；網址本身常常就是密碼）。/ Mask token-like path parts (URLs are often secrets). */
export function maskUrl(url: string): string {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return url;
    }
    const parts = u.pathname.split("/").map((p) => (p.length >= 12 || /\d{5,}/.test(p) ? `${p.slice(0, 3)}…` : p));
    const query = u.search ? "?…" : "";
    return `${u.host}${parts.join("/")}${query}`;
}

/** 依事件表的順序排（非管理員拿不到全站目錄），不認得的放最後。/ Events in the known order (non-admins get no site
 *  catalogue); unknown names last. */
export function knownEventOrder(events: string[]): string[] {
    const known = Object.keys(EVENT_KEYS);
    return [...known.filter((e) => events.includes(e)), ...events.filter((e) => !known.includes(e))];
}

export type SiteHookState = "on" | "paused" | "off";

/** 全站 webhook 摘要的狀態（暫停時 enabled 也是 false）。/ A site summary's state (paused ones are also not enabled). */
export function siteHookState(h: Pick<SiteWebhookSummary, "enabled" | "paused">): SiteHookState {
    if (h.paused) return "paused";
    return h.enabled ? "on" : "off";
}

export type SiteCoverage = { kind: "all" } | { kind: "some"; names: string[]; hidden: number } | { kind: "none"; hidden: number };

/** 這個全站 webhook 報哪些「我的」隧道。/ Which of my tunnels a site-wide webhook reports on. */
export function siteCoverage(h: Pick<SiteWebhookSummary, "all_tunnels" | "tunnels" | "hidden_tunnels">): SiteCoverage {
    if (h.all_tunnels) return { kind: "all" };
    const names = h.tunnels.map((t) => t.name);
    return names.length > 0 ? { kind: "some", names, hidden: h.hidden_tunnels } : { kind: "none", hidden: h.hidden_tunnels };
}

/** 開著的在前，再依名稱。/ Running ones first, then by name. */
export function sortSiteSummary(list: SiteWebhookSummary[]): SiteWebhookSummary[] {
    const rank: Record<SiteHookState, number> = { on: 0, paused: 1, off: 2 };
    return [...list].sort((a, b) => rank[siteHookState(a)] - rank[siteHookState(b)] || (a.name ?? "").localeCompare(b.name ?? "") || a.id - b.id);
}
