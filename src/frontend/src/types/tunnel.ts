/**
 * 通道與反向代理相關型別 / Tunnel and Reverse Proxy types
 * Defines shapes for tunnels, users, and files associated with them.
 */

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
}

/** gateway 看到的裝置連線來源。/ The device's source address as the gateway sees it. */
export interface TunnelEndpoint {
    ip: string;
    /** true = 現在連著；false = 最後一次的紀錄。/ true while connected, false = last recorded connection. */
    live: boolean;
    connected_at: string;
    last_seen_at: string | null;
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
    onUsers: (tunnelId: number, readOnly: boolean) => void;
    onShare: (tunnelId: number) => void;
    onLeave: (tunnelId: number, name: string) => void;
    onDelete: (tunnelId: number, name: string) => void;
}
