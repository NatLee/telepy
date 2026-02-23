/** 
 * 通知相關型別 / Notification types
 * Defines the shapes for WebSocket notification messages and actions.
 */

export const NOTIFICATION_ACTIONS = {
    UPDATE_TUNNEL_STATUS_DATA: "UPDATE-TUNNEL-STATUS-DATA",
    UPDATE_TUNNEL_STATUS: "UPDATE-TUNNEL-STATUS",
    TUNNEL_SHARED: "TUNNEL-SHARED",
    TUNNEL_UNSHARED: "TUNNEL-UNSHARED",
    TUNNEL_PERMISSION_UPDATED: "TUNNEL-PERMISSION-UPDATED",
    TUNNEL_USERNAMES_UPDATED: "TUNNEL-USERNAMES-UPDATED",
    UPDATED_TUNNELS: "UPDATED-TUNNELS",
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
