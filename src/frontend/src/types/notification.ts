/** 
 * 通知相關型別 / Notification types
 * Defines the shapes for WebSocket notification messages and actions.
 */

export const NOTIFICATION_ACTIONS = {
    UPDATE_TUNNEL_STATUS_DATA: "UPDATE-TUNNEL-STATUS-DATA",
    UPDATE_TUNNEL_STATUS: "UPDATE-TUNNEL-STATUS",
    UPDATE_TUNNEL_LATENCY: "UPDATE-TUNNEL-LATENCY",
    // 誰在用某條隧道變了：{tunnel_id, count}（送給看得到它的人）。/ Presence count changed (tunnel audience).
    UPDATE_TUNNEL_PRESENCE: "UPDATE-TUNNEL-PRESENCE",
    // 裝置從新的 IP 連上來：{tunnel_id, tunnel_name, ip, previous_ip}（送給擁有者與 ADMIN）。/ Device IP changed (owner + ADMIN).
    TUNNEL_IP_CHANGED: "TUNNEL-IP-CHANGED",
    // 隧道降級 / 恢復：{tunnel_id, port, health}（送給看得到它的人）。/ Degraded / recovered (tunnel audience).
    UPDATE_TUNNEL_HEALTH: "UPDATE-TUNNEL-HEALTH",
    TUNNEL_SHARED: "TUNNEL-SHARED",
    TUNNEL_UNSHARED: "TUNNEL-UNSHARED",
    TUNNEL_PERMISSION_UPDATED: "TUNNEL-PERMISSION-UPDATED",
    TUNNEL_USERNAMES_UPDATED: "TUNNEL-USERNAMES-UPDATED",
    UPDATED_TUNNELS: "UPDATED-TUNNELS",
    // AI（MCP）工具開/關 SSH session：送給 session 的使用者與隧道擁有者。/ AI session lifecycle (user + tunnel owner).
    AI_SESSION_OPENED: "AI-SESSION-OPENED",
    AI_SESSION_CLOSED: "AI-SESSION-CLOSED",
    // 裝置出示了和釘選不同的 SSH host key（送給隧道擁有者與被分享者）。/ A device presented a different host key (tunnel audience).
    HOST_KEY_CHANGED: "HOST-KEY-CHANGED",
    // 別的帳號把隧道指到了你的機器、被拒絕（送給擁有者與 ADMIN 被分享者）。/ Another account's tunnel reached your machine and was refused.
    DEVICE_CLAIM_ATTEMPT: "DEVICE-CLAIM-ATTEMPT",
    // 裝置金鑰清單同步完（送給隧道擁有者與被分享者）。/ A device's key list was synced (tunnel audience).
    DEVICE_KEYS_UPDATED: "DEVICE-KEYS-UPDATED",
    // 區網掃描（#20）：進度 / 完成只送給發起的人，主機表更新送給看得到隧道的人。
    // LAN scan progress / done go to the scanner; host-list updates go to the tunnel's audience.
    LAN_SCAN_PROGRESS: "LAN-SCAN-PROGRESS",
    LAN_SCAN_DONE: "LAN-SCAN-DONE",
    UPDATED_LAN_HOSTS: "UPDATED-LAN-HOSTS",
    // 一行指令加入裝置的進度（送給發指令的人）。/ One-command join progress (to the ticket owner).
    JOIN_UPDATED: "JOIN-UPDATED",
    // 有人從即時 session 頁結束了你的 session：{tunnel_id, kind, by}。/ Someone ended your session: {tunnel_id, kind, by}.
    SESSION_ENDED: "SESSION-ENDED",
    // 筆電經 gateway 連敏感隧道被擋：{tunnel_id, tunnel_name}（送給那個人）。/ Laptop SSH to a step-up tunnel was refused.
    STEP_UP_REQUIRED: "STEP-UP-REQUIRED",
    // 存取申請：新申請送給 owner / ADMIN；決定送給申請人；其他變動讓 owner / ADMIN 端刷新。
    // Access requests: new ones go to the owner / ADMINs, decisions to the requester, other changes refresh deciders.
    ACCESS_REQUEST_CREATED: "ACCESS-REQUEST-CREATED",
    ACCESS_REQUEST_DECIDED: "ACCESS-REQUEST-DECIDED",
    ACCESS_REQUEST_UPDATED: "ACCESS-REQUEST-UPDATED",
    // 指令規則：有指令等核准 {request, approver_ids}（送給 owner / ADMIN 與申請人）；有結果了 {request}（同一群人）。
    // Command rules: a command waits for approval {request, approver_ids} (owner / ADMINs + the requester); decided {request}.
    COMMAND_APPROVAL_REQUESTED: "COMMAND-APPROVAL-REQUESTED",
    COMMAND_APPROVAL_DECIDED: "COMMAND-APPROVAL-DECIDED",
    // webhook 連續失敗被暫停：{webhook_id, name, scope}（個人的送給擁有者，全站的送給每個管理員）。
    // A webhook was paused after failing again and again (its owner; every admin for a site-wide one).
    WEBHOOK_PAUSED: "WEBHOOK-PAUSED",
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
