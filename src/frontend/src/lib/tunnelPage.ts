/**
 * 通道頁面（`/tunnels/<id>`）的純函式：有哪些分頁、網址怎麼組、舊的詳細資訊分頁名稱對到哪裡，以及「總覽」上要提醒的事
 * （每一件帶它該去的分頁）。不碰 React。
 * Pure helpers for a tunnel's page (`/tunnels/<id>`): its tabs, how the URL is built, where the old details dialog's
 * tab names land, and what the overview should flag (each with the tab that deals with it). No React.
 */
import type { TranslationKey } from "../locales/en.ts";

/** 分頁，左側欄的順序。/ The tabs, in rail order. */
export const TUNNEL_TABS = ["overview", "connection", "device", "identity", "access", "sessions", "history", "settings"] as const;
export type TunnelTab = (typeof TUNNEL_TABS)[number];

/** 舊的詳細資訊對話框分頁名稱（書籤、舊連結）。/ The old details dialog's tab names (bookmarks, old links). */
const LEGACY_TABS: Record<string, TunnelTab> = { general: "settings", connections: "history" };

export function isTunnelTab(v: string | null | undefined): v is TunnelTab {
    return !!v && (TUNNEL_TABS as readonly string[]).includes(v);
}

/** `?tab=` → 分頁；不認得 = 總覽。/ `?tab=` → a tab; unknown = the overview. */
export function parseTunnelTab(raw: string | null | undefined): TunnelTab {
    if (isTunnelTab(raw)) return raw;
    return (raw && LEGACY_TABS[raw]) || "overview";
}

/** 網址裡的 id：只收正整數。/ The id in the URL: positive integers only. */
export function parseTunnelId(raw: string | string[] | null | undefined): number | null {
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (!s || !/^\d{1,12}$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
}

/** 通道頁面的網址；總覽不帶 `?tab=`。/ A tunnel page's URL; the overview carries no `?tab=`. */
export function tunnelPageUrl(id: number, tab?: TunnelTab | null): string {
    return !tab || tab === "overview" ? `/tunnels/${id}` : `/tunnels/${id}?tab=${tab}`;
}

/** `/tunnels/<數字>`（側欄把它算在「通道」底下）。/ `/tunnels/<digits>` (the sidebar counts it under Tunnels). */
export function isTunnelPagePath(pathname: string): boolean {
    return /^\/tunnels\/\d+\/?$/.test(pathname);
}

export type AttentionKind = "claimed" | "host_key" | "degraded" | "device_warning" | "extra_install" | "older_install" | "old_name" | "access_requests";

export interface AttentionItem {
    kind: AttentionKind;
    tab: TunnelTab;
    key: TranslationKey;
    tone: "danger" | "warning" | "info";
    count?: number;
}

export interface AttentionInput {
    hostKeyChanged?: boolean;
    deviceClaimed?: boolean;
    degraded?: boolean;
    /** 裝置資訊的警告數。/ How many device-facts warnings. */
    deviceWarnings?: number;
    extraInstall?: number;
    olderInstall?: number;
    /** 名稱符合 ssh 主機名稱的規則。/ The name follows the ssh host-name rule. */
    nameOk?: boolean;
    /** 等我決定的存取申請（擁有者 / Admin）。/ Access requests waiting for me. */
    accessRequests?: number;
}

/**
 * 總覽上的「需要處理」：最要緊的在前（機器是別人的 > 主機金鑰變了 > sshd 沒回應 > 裝置警告 > 多出來的服務 > 舊名稱的
 * 服務 > 舊的通道名稱 > 等我決定的申請），每件帶它該去的分頁。
 * The overview's "needs attention", most urgent first, each with the tab that deals with it.
 */
export function attentionItems(a: AttentionInput): AttentionItem[] {
    const out: AttentionItem[] = [];
    if (a.deviceClaimed) out.push({ kind: "claimed", tab: "identity", key: "tunnelPage.attn.claimed", tone: "danger" });
    else if (a.hostKeyChanged) out.push({ kind: "host_key", tab: "identity", key: "tunnelPage.attn.hostKey", tone: "danger" });
    if (a.degraded) out.push({ kind: "degraded", tab: "device", key: "tunnelPage.attn.degraded", tone: "warning" });
    if (a.deviceWarnings) out.push({ kind: "device_warning", tab: "device", key: "tunnelPage.attn.deviceWarning", tone: "warning", count: a.deviceWarnings });
    if (a.extraInstall) out.push({ kind: "extra_install", tab: "connection", key: "tunnelPage.attn.extraInstall", tone: "warning", count: a.extraInstall });
    else if (a.olderInstall) out.push({ kind: "older_install", tab: "connection", key: "tunnelPage.attn.olderInstall", tone: "info", count: a.olderInstall });
    if (a.nameOk === false) out.push({ kind: "old_name", tab: "settings", key: "tunnelPage.attn.oldName", tone: "info" });
    if (a.accessRequests) out.push({ kind: "access_requests", tab: "access", key: "tunnelPage.attn.accessRequests", tone: "info", count: a.accessRequests });
    return out;
}
