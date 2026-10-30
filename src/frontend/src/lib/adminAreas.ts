/**
 * 管理區的分區。以前側欄的管理區是十條平的連結（網站設定、伺服器狀態、稽核日誌、全站即時連線…），網站設定頁
 * 裡又藏著使用者與功能權限兩個分頁；現在分成五區，有好幾頁的區在側欄只佔一行，進到那區才展開子頁，頁面標題下
 * 也有同一排分頁（側欄收合時靠它切換）。網址都沒變。
 * The admin section's areas. The sidebar used to list ten flat links and the site settings page hid users and
 * feature access as two more tabs; now there are five areas. An area with several pages takes one sidebar row and
 * expands its sub-pages while you're inside it, and the page header carries the same tabs (what a collapsed
 * sidebar relies on). No URL changed.
 */
import type { TranslationKey } from "../locales/en.ts";

export type AdminAreaId = "people" | "settings" | "rules" | "activity" | "health";

export interface AdminPage {
    /** 側欄子項、頁內分頁與麵包屑用的短名字。/ The short name for the sidebar sub-item, the page tabs and the breadcrumb. */
    key: TranslationKey;
    href: string;
}

export interface AdminArea {
    id: AdminAreaId;
    key: TranslationKey;
    /** 第一頁 = 點側欄那一行會去的地方。/ The first page is where the sidebar row goes. */
    pages: readonly AdminPage[];
}

export const ADMIN_AREAS: readonly AdminArea[] = [
    {
        // 人：帳號（停用、角色、重設兩步驟）與每個人能用哪些功能。/ People: accounts and which features each may use.
        id: "people",
        key: "nav.areaPeople",
        pages: [
            { key: "settings.tabUsers", href: "/tunnels/admin/users" },
            { key: "access.manageTitle", href: "/tunnels/admin/access" },
        ],
    },
    // 整站的開關與上限，左側再依帳號 / 功能 / 伺服器分組。/ Site-wide switches and limits, grouped on the page itself.
    { id: "settings", key: "nav.settings", pages: [{ key: "nav.settings", href: "/tunnels/settings" }] },
    {
        // 套用到每個人的規則與通知預設。/ Rules and notification defaults that apply to everyone.
        id: "rules",
        key: "nav.areaRules",
        pages: [
            { key: "nav.commands", href: "/tunnels/admin/commands" },
            { key: "settings.groupNotify", href: "/tunnels/admin/notifications" },
            { key: "nav.webhooks", href: "/tunnels/admin/webhooks" },
        ],
    },
    {
        // 每個人的紀錄與正在進行的連線（個人頁只有自己的）。/ Everyone's records and live connections (personal pages show only yours).
        id: "activity",
        key: "nav.areaActivity",
        pages: [
            { key: "nav.adminLogs", href: "/tunnels/admin/logs" },
            { key: "nav.sessions", href: "/tunnels/admin/sessions" },
            { key: "nav.recordings", href: "/tunnels/admin/recordings" },
            { key: "nav.activity", href: "/tunnels/admin/activity" },
            { key: "nav.areaApiActivity", href: "/tunnels/admin/api-activity" },
        ],
    },
    { id: "health", key: "nav.adminHealth", pages: [{ key: "nav.adminHealth", href: "/tunnels/admin/health" }] },
];

/** 這一頁或它下面的頁。`/tunnels/admin/activity` 不會吃到 `/tunnels/admin/activity-x`。/ The page or one below it, never a longer sibling. */
export function onPage(pathname: string, href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
}

/** 目前網址在哪一區的哪一頁；不在管理區 = null。/ The area and page for a path; null outside the admin section. */
export function adminAreaOf(pathname: string): { area: AdminArea; page: AdminPage } | null {
    for (const area of ADMIN_AREAS) {
        const page = area.pages.find((p) => onPage(pathname, p.href));
        if (page) return { area, page };
    }
    return null;
}

/**
 * 以前網站設定頁的 `?tab=users` / `?tab=access[&user=]` 現在在哪（書籤、舊連結）；其他分頁 = null。
 * Where the settings page's old `?tab=users` / `?tab=access[&user=]` live now (bookmarks, old links); null otherwise.
 */
export function movedSettingsTab(tab: string | null, user: string | null): string | null {
    if (tab === "users") return "/tunnels/admin/users";
    if (tab === "access") {
        const id = Number(user);
        return Number.isInteger(id) && id > 0 ? `/tunnels/admin/access?user=${id}` : "/tunnels/admin/access";
    }
    return null;
}
