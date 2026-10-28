/**
 * 站內通知偏好的純函式（與後端 `notify_prefs.rs` 同一套規則）：事件 × 管道（toast = 網頁內提示、desktop = 桌面通知），
 * 四層 —— 內建（開）→ 全站預設（管理員；可「強制」= 不准關）→ 我的預設 → 這條隧道的靜音。
 * 結果 = 強制 ? 開 : (靜音蓋到 ? 關 : 我的 ?? 全站 ?? 開)。另外：通知 `action` → 事件的對照表、矩陣格子的狀態、
 * 「怎麼運作」圖每一層的狀態。
 * Pure helpers for in-app notification preferences (same rules as the backend's `notify_prefs.rs`): event ×
 * channel, four layers — built-in (on) → site default (admins; may be enforced) → my default → a tunnel mute.
 * Effective = locked ? on : (a mute covers it ? off : mine ?? site ?? on). Also: the notification `action` →
 * event table, the matrix cell state and the state of each layer of the "How it works" diagram.
 */
import type { EventAudience, EventGroup } from "../types/webhooks.ts";

export type NotifyChannel = "toast" | "desktop";
export const NOTIFY_CHANNELS: NotifyChannel[] = ["toast", "desktop"];
export type MuteScope = "all" | "status";
export type NotifySource = "locked" | "muted" | "mine" | "site" | "builtin";
export type ChannelValues = Partial<Record<NotifyChannel, boolean | null>>;

export interface NotifyEvent {
    event: string;
    group: EventGroup;
    audience: EventAudience;
    /** 跟隧道有關（靜音適用）。/ About a tunnel (mutes apply). */
    tunnel: boolean;
    /** 上線 / 離線 / 降級 / 恢復。/ Online / offline / degraded / recovered. */
    status: boolean;
    channels: NotifyChannel[];
    /** 管理員強制：一定顯示。/ Enforced by an admin: always shown. */
    locked: boolean;
    /** 全站值（null = 內建開）。/ Site value (null = built-in on). */
    site: ChannelValues;
    /** 我的值（null = 跟全站）；全站預設頁沒有。/ My value (null = follow the site); absent on the admin page. */
    mine?: ChannelValues;
}

export interface NotifyMute {
    tunnel_id: number;
    tunnel_name: string;
    scope: MuteScope;
}

export interface NotifyPrefs {
    events: NotifyEvent[];
    mutes: NotifyMute[];
}

export function parsePrefs(data: unknown): NotifyPrefs | null {
    if (!data || typeof data !== "object") return null;
    const d = data as { events?: unknown; mutes?: unknown };
    if (!Array.isArray(d.events)) return null;
    return { events: d.events as NotifyEvent[], mutes: Array.isArray(d.mutes) ? (d.mutes as NotifyMute[]) : [] };
}

/** 靜音蓋不蓋得到這個事件（帳號事件不看隧道）。/ Whether a mute covers the event (account events ignore mutes). */
export function muteCovers(scope: MuteScope | null | undefined, ev: Pick<NotifyEvent, "tunnel" | "status">): boolean {
    if (!scope || !ev.tunnel) return false;
    return scope === "all" || ev.status;
}

/** 一格的結果與決定的那一層。/ One cell's result and the layer that decided it. */
export function resolveNotify(ev: NotifyEvent, channel: NotifyChannel, mute?: MuteScope | null): { on: boolean; source: NotifySource } {
    if (ev.locked) return { on: true, source: "locked" };
    if (muteCovers(mute, ev)) return { on: false, source: "muted" };
    const mine = ev.mine?.[channel];
    if (mine === true || mine === false) return { on: mine, source: "mine" };
    const site = ev.site[channel];
    if (site === true || site === false) return { on: site, source: "site" };
    return { on: true, source: "builtin" };
}

/**
 * 要不要提示：還沒載入、清單外的事件（例如只是刷新用的通知）、這事件沒有這個管道 = 照舊顯示。
 * Whether to show it: not loaded yet, an event outside the list (e.g. refresh-only notifications) or a channel the
 * event doesn't have = shown as before.
 */
export function shouldShow(prefs: NotifyPrefs | null, kind: string | null, channel: NotifyChannel, tunnelId?: number | null): boolean {
    if (!prefs || !kind) return true;
    const ev = prefs.events.find((e) => e.event === kind);
    if (!ev || !ev.channels.includes(channel)) return true;
    const mute = tunnelId == null ? null : prefs.mutes.find((m) => m.tunnel_id === tunnelId)?.scope ?? null;
    return resolveNotify(ev, channel, mute).on;
}

type Msg = { action?: string; tunnel_id?: unknown; status?: unknown; health?: unknown; watching?: unknown; [k: string]: unknown };

/**
 * 通知的 `action`（加上內容）→ 目錄裡的事件；只是讓頁面刷新的通知回 null（永遠不擋）。
 * A notification's `action` (and payload) → the catalogue event; refresh-only notifications give null (never gated).
 */
export function notificationKind(msg: Msg): string | null {
    switch (msg.action) {
        case "UPDATE-TUNNEL-STATUS":
            return msg.status === "connected" ? "tunnel.online" : "tunnel.offline";
        case "UPDATE-TUNNEL-HEALTH":
            return msg.health === "degraded" ? "tunnel.degraded" : msg.health === "online" ? "tunnel.recovered" : null;
        case "TUNNEL-IP-CHANGED":
            return "tunnel.ip_changed";
        case "HOST-KEY-CHANGED":
            return "tunnel.host_key_changed";
        case "DEVICE-CLAIM-ATTEMPT":
            return "device.claim_attempt";
        case "DEVICE-WARNING":
            return "tunnel.device_warning";
        case "TUNNEL-SHARED":
            return "share.received";
        case "TUNNEL-UNSHARED":
            return "share.ended";
        case "ACCESS-REQUEST-CREATED":
            return "access.requested";
        case "ACCESS-REQUEST-DECIDED":
            return "access.decided";
        case "COMMAND-APPROVAL-REQUESTED":
            return "command.approval_requested";
        case "COMMAND-APPROVAL-DECIDED":
            return "command.approval_decided";
        case "AI-SESSION-OPENED":
            return "mcp.session_opened";
        case "AI-SESSION-CLOSED":
            return "mcp.session_closed";
        case "TERMINAL-WATCHED":
            return msg.watching === false ? null : "session.watched";
        case "SIGN-IN-NEW-DEVICE":
            return "account.sign_in_new_device";
        default:
            return null;
    }
}

/** 通知裡的隧道 id（有的話）。/ The notification's tunnel id, if any. */
export function notificationTunnel(msg: Msg): number | null {
    return typeof msg.tunnel_id === "number" ? msg.tunnel_id : null;
}

/** 格子旁的小標：強制 / 覆寫 / 跟預設。/ The chip next to a cell: enforced / overrides / follows the default. */
export type CellChip = "locked" | "overrides" | "follows";

export function cellChip(ev: NotifyEvent, channel: NotifyChannel): CellChip {
    if (ev.locked) return "locked";
    const mine = ev.mine?.[channel];
    return mine === true || mine === false ? "overrides" : "follows";
}

/** 這列有沒有我的覆寫（「回到預設」）。/ Whether the row has an override of mine ("reset to default"). */
export function hasOverride(ev: NotifyEvent): boolean {
    return ev.channels.some((c) => ev.mine?.[c] === true || ev.mine?.[c] === false);
}

/** 依群組排好（目錄順序）。/ Grouped in catalogue order. */
export function groupEvents(events: NotifyEvent[], order: EventGroup[]): { group: EventGroup; events: NotifyEvent[] }[] {
    return order.map((group) => ({ group, events: events.filter((e) => e.group === group) })).filter((g) => g.events.length > 0);
}

/** 本機先套用一筆變更（等後端回來前畫面就跟上）。/ Apply a change locally (the screen follows before the backend answers). */
export function applyMine(prefs: NotifyPrefs, event: string, channel: NotifyChannel, value: boolean | null): NotifyPrefs {
    return {
        ...prefs,
        events: prefs.events.map((e) => (e.event === event ? { ...e, mine: { ...e.mine, [channel]: value } } : e)),
    };
}

export function applyMute(prefs: NotifyPrefs, tunnelId: number, tunnelName: string, scope: MuteScope | null): NotifyPrefs {
    const rest = prefs.mutes.filter((m) => m.tunnel_id !== tunnelId);
    return { ...prefs, mutes: scope ? [...rest, { tunnel_id: tunnelId, tunnel_name: tunnelName, scope }].sort((a, b) => a.tunnel_name.localeCompare(b.tunnel_name)) : rest };
}

/** 「怎麼運作」圖每一層的角色。/ The role of each layer in the "How it works" diagram. */
export type LayerRole = "decides" | "overridden" | "unset" | "skipped";

export interface FlowLayer {
    /** 這一層設的值：on / off / locked / muted / null（沒設）。/ What the layer says. */
    value: "on" | "off" | "locked" | "muted" | null;
    role: LayerRole;
}

export interface NotifyFlowState {
    site: FlowLayer;
    mine: FlowLayer;
    tunnel: FlowLayer;
    result: { on: boolean; source: NotifySource };
    /** 這個事件沒有這個管道。/ The event has no such channel. */
    noChannel: boolean;
}

/**
 * 圖的狀態：決定的那一層 = decides；它前面有設值但被蓋過的 = overridden；沒設 = unset；強制時後面幾層 = skipped。
 * Diagram state: the deciding layer = decides; earlier layers with a value that lost = overridden; no value =
 * unset; when enforced, the later layers = skipped.
 */
export function notifyFlow(ev: NotifyEvent, channel: NotifyChannel, mute?: MuteScope | null): NotifyFlowState {
    const noChannel = !ev.channels.includes(channel);
    const result = noChannel ? { on: false, source: "builtin" as NotifySource } : resolveNotify(ev, channel, mute);
    const siteVal = ev.site[channel];
    const mineVal = ev.mine?.[channel];
    const covered = muteCovers(mute, ev);
    const val = (v: boolean | null | undefined): FlowLayer["value"] => (v === true ? "on" : v === false ? "off" : null);
    const roleOf = (layer: NotifySource, has: boolean): LayerRole => {
        if (result.source === layer) return "decides";
        if (result.source === "locked") return "skipped";
        return has ? "overridden" : "unset";
    };
    return {
        site: ev.locked ? { value: "locked", role: "decides" } : { value: val(siteVal), role: roleOf("site", siteVal === true || siteVal === false) },
        mine: { value: val(mineVal), role: roleOf("mine", mineVal === true || mineVal === false) },
        tunnel: { value: covered ? "muted" : null, role: roleOf("muted", covered) },
        result,
        noChannel,
    };
}
