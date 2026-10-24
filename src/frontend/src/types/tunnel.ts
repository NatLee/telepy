/**
 * 通道與反向代理相關型別 / Tunnel and Reverse Proxy types
 * Defines shapes for tunnels, users, and files associated with them.
 */
import type { IpGeo } from "@/lib/geo";

export interface Tunnel {
    id: number;
    host_friendly_name: string;
    reverse_port: number;
    key?: string;
    description?: string;
    is_owner: boolean;
    can_edit: boolean;
    can_share: boolean;
    can_delete: boolean;
    shared_with_count?: number;
    /** 裝置的公網 IP（只在列表裡；看不到或從沒連過時 null）。/ Device public IP (list only; null when hidden or never connected). */
    endpoint?: TunnelEndpoint | null;
    /** 誰在用（只在列表裡）。/ Who is using the tunnel (list only). */
    presence?: TunnelPresence | null;
    /** 健康狀態（只在列表裡；抓取當下的值，即時狀態看 portsMap，見 lib/tunnelHealth）。/ Health at fetch time (list only). */
    health?: TunnelHealth;
    /** 離線時最後一次連線的時間（UTC）；連著或從沒連過時 null。/ When it was last connected; null while connected or never. */
    last_seen_at?: string | null;
    /** 我有沒有釘選（每個人自己的）。/ Whether I pinned it (per user). */
    pinned?: boolean;
    /** 隧道標籤（大家共用，EDIT 以上可改）。/ Shared labels (EDIT and up may change them). */
    labels?: string[];
    /** 分享給我的這筆什麼時候結束（只在列表裡；自己的隧道或沒期限時 null）。/ When my share ends (list only; null = mine or no end). */
    share_expires_at?: string | null;
    /** owner / ADMIN：等我決定的存取申請數（只在列表裡）。/ Owner / ADMIN: access requests waiting (list only). */
    access_requests?: number;
    /** 裝置出示了和釘選不同的 SSH host key，等擁有者確認。/ The device presented a different host key; waiting for review. */
    host_key_changed?: boolean;
}

/**
 * online：經由隧道讀得到裝置 sshd；degraded：隧道在、sshd 沒回應；offline：連過但現在斷線；never：從沒連上過。
 * online / degraded (tunnel up, device sshd not answering) / offline / never connected.
 */
export type TunnelHealth = "online" | "degraded" | "offline" | "never";

/** 人數給所有人；sessions 只給 owner / ADMIN / 管理員（其他人 null）。/ Count for all; sessions for owner / ADMIN / admins. */
export interface TunnelPresence {
    count: number;
    sessions: PresenceSession[] | null;
}

export interface PresenceSession {
    user: string;
    /** terminal / files / browser / ssh / ai */
    kind: string;
    ip: string | null;
    geo?: IpGeo | null;
    since: string;
    /** AI session 的 app。/ The app behind an AI session. */
    client: string | null;
}

/** gateway 看到的裝置連線來源。/ The device's source address as the gateway sees it. */
export interface TunnelEndpoint {
    ip: string;
    /** true = 現在連著；false = 最後一次的紀錄。/ true while connected, false = last recorded connection. */
    live: boolean;
    connected_at: string;
    last_seen_at: string | null;
    /** 位址範圍與（有 GeoIP 時的）國家 / 業者。/ Scope plus country / network owner. */
    geo?: IpGeo | null;
    /** 最近一次換 IP 之前的位址與換的時間。/ The address before the latest change, and when it changed. */
    previous_ip?: string | null;
    changed_at?: string | null;
}

export interface ReverseServerUsername {
    id: number;
    username: string;
    created_by?: string | null;
    created_by_id?: number | null;
}

export interface TargetUser extends ReverseServerUsername { }

export interface FileItem {
    type: "directory" | "file";
    permissions?: { string: string };
    owner?: string;
    group?: string;
    size: string | number;
    date?: string;
    name: string;
}

export interface TunnelModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}

/**
 * 隧道列表的動作回呼（卡片 / 表格列 / 動作選單共用）。
 * Tunnel list action callbacks, shared by the card, the table row and the actions menu.
 */
export interface TunnelActionHandlers {
    onDetails: (tunnelId: number) => void;
    onConfig: (tunnelId: number) => void;
    onScript: (tunnelId: number) => void;
    /** 這條隧道的 gateway 日誌（/tunnels/logs?tunnel=<id>）。/ This tunnel's gateway log. */
    onLogs: (tunnelId: number) => void;
    /** 指令速查：埠轉發等指令（/tunnels/cheatsheet?tunnel=<id>）。/ Command sheet for this tunnel. */
    onCommands: (tunnelId: number) => void;
    /** 這台裝置的金鑰清單（/tunnels/keys?device=<id>）。/ This device's key list. */
    onKeys: (tunnelId: number) => void;
    /** 裝置背後的區網主機（/tunnels/network?tunnel=<id>）。/ The LAN hosts behind this device. */
    onNetwork: (tunnelId: number) => void;
    /** 在瀏覽器裡開它（或它區網主機）的 RDP / VNC 桌面（/tunnels/desktop?tunnel=<id>）。/ Remote desktop. */
    onDesktop: (tunnelId: number) => void;
    onUsers: (tunnelId: number, readOnly: boolean) => void;
    onShare: (tunnelId: number) => void;
    onLeave: (tunnelId: number, name: string) => void;
    onDelete: (tunnelId: number, name: string) => void;
    /** 被分享的人申請更多存取。/ A sharee asks for more access. */
    onRequestAccess?: (tunnelId: number) => void;
    /** 釘選 / 取消釘選（每個人自己的）。/ Pin or unpin (per user). */
    onTogglePin?: (tunnelId: number, pinned: boolean) => void;
    /** 點了某個標籤：用它篩選列表。/ A label was clicked: filter the list by it. */
    onLabel?: (label: string) => void;
}
