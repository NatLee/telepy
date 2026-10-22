/** 
 * 通知相關型別 / Notification types
 * Defines the shapes for WebSocket notification messages and actions.
 */

export const NOTIFICATION_ACTIONS = {
    UPDATE_TUNNEL_STATUS_DATA: "UPDATE-TUNNEL-STATUS-DATA",
    UPDATE_TUNNEL_STATUS: "UPDATE-TUNNEL-STATUS",
    UPDATE_TUNNEL_LATENCY: "UPDATE-TUNNEL-LATENCY",
    TUNNEL_SHARED: "TUNNEL-SHARED",
    TUNNEL_UNSHARED: "TUNNEL-UNSHARED",
    TUNNEL_PERMISSION_UPDATED: "TUNNEL-PERMISSION-UPDATED",
    TUNNEL_USERNAMES_UPDATED: "TUNNEL-USERNAMES-UPDATED",
    UPDATED_TUNNELS: "UPDATED-TUNNELS",
    // AI（MCP）工具開/關 SSH session：送給 session 的使用者與隧道擁有者。/ AI session lifecycle (user + tunnel owner).
    AI_SESSION_OPENED: "AI-SESSION-OPENED",
    AI_SESSION_CLOSED: "AI-SESSION-CLOSED",
    // 裝置金鑰清單同步完（送給隧道擁有者與被分享者）。/ A device's key list was synced (tunnel audience).
    DEVICE_KEYS_UPDATED: "DEVICE-KEYS-UPDATED",
    // 區網掃描（#20）：進度 / 完成只送給發起的人，主機表更新送給看得到隧道的人。
    // LAN scan progress / done go to the scanner; host-list updates go to the tunnel's audience.
    LAN_SCAN_PROGRESS: "LAN-SCAN-PROGRESS",
    LAN_SCAN_DONE: "LAN-SCAN-DONE",
    UPDATED_LAN_HOSTS: "UPDATED-LAN-HOSTS",
} as const;

export type NotificationAction = typeof NOTIFICATION_ACTIONS[keyof typeof NOTIFICATION_ACTIONS];

export interface NotificationPayload {
    action: NotificationAction | string;
    details?: string;
    tunnel_id?: number;
    port?: number;
    status?: string;
    data?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}
