/**
 * 網站設定頁的分頁與分組。設定依 key 前綴分頁；沒有前綴的 key 在 `KEY_HOMES` 寫明放哪一頁——以前它們全掉進
 * 「帳號與註冊」，所以那頁混著 LAN 掃描、裝置公網 IP 查詢和錄影保留天數。測試會讀後端的設定清單，新設定沒有
 * 家就失敗，不會再默默落到第一頁。
 * The site settings page's tabs and groups. Settings go to a tab by key prefix; keys without a feature prefix are
 * placed explicitly in `KEY_HOMES` — they all used to fall into "Account & registration", which is how LAN
 * discovery, the device IP lookup and recording retention ended up there. The test reads the backend's list, so a
 * new setting without a home fails instead of quietly landing on the first tab.
 */
import type { TranslationKey } from "../locales/en.ts";

export type SiteTabId = "general" | "signin" | "commands" | "desktop" | "browser" | "devices" | "ai" | "notify";
export type SiteTabGroupId = "accounts" | "features";

/** 左側欄的分組（手機上是下拉選單的 optgroup）。/ The rail's groups (optgroups of the phone select). */
export const SITE_TAB_GROUPS: readonly { id: SiteTabGroupId; key: TranslationKey; tabs: readonly SiteTabId[] }[] = [
    { id: "accounts", key: "settings.railAccounts", tabs: ["general", "signin"] },
    { id: "features", key: "settings.railFeatures", tabs: ["commands", "desktop", "browser", "devices", "ai", "notify"] },
];

export const SITE_TAB_IDS: readonly SiteTabId[] = SITE_TAB_GROUPS.flatMap((g) => g.tabs);

/** 沒有功能前綴的 key 各自的家。/ Homes for keys without a feature prefix. */
const KEY_HOMES: Record<string, SiteTabId> = {
    allow_registration: "general",
    valid_register_domains: "general",
    // 個人 SSH 金鑰的效期：帳號的事。/ Personal SSH key lifetime: an account matter.
    user_key_max_days: "general",
    lan_scan_enabled: "devices",
    device_ip_lookup_url: "devices",
    // 終端機錄影檔留幾天。/ How long terminal recordings are kept.
    recording_retention_days: "commands",
};

const PREFIX_HOMES: readonly [string, SiteTabId][] = [
    ["signin_", "signin"],
    ["mfa_", "signin"],
    ["remote_browser_", "browser"],
    ["desktop_", "desktop"],
    ["ai_", "ai"],
    ["notify_", "notify"],
    ["command_", "commands"],
    ["terminal_", "commands"],
];

/** 這個 key 明確的家；沒寫到 = null。/ The key's declared home, or null when none is declared. */
export function declaredTab(key: string): SiteTabId | null {
    if (key in KEY_HOMES) return KEY_HOMES[key];
    return PREFIX_HOMES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? null;
}

/** 這個 key 顯示在哪一頁；新後端多出來、前端還不認得的放第一頁，總比看不到好。/ Where a key shows; unknown ones go to the first tab rather than nowhere. */
export function siteTabOf(key: string): SiteTabId {
    return declaredTab(key) ?? "general";
}

/** `?tab=` 的值；不認得 = 第一頁。/ The `?tab=` value; anything unknown is the first tab. */
export function parseSiteTab(raw: string | null): SiteTabId {
    return SITE_TAB_IDS.find((id) => id === raw) ?? "general";
}

/** 這一頁在哪一組。/ The group a tab sits in. */
export function groupOfTab(tab: SiteTabId): SiteTabGroupId {
    return SITE_TAB_GROUPS.find((g) => g.tabs.includes(tab))!.id;
}
