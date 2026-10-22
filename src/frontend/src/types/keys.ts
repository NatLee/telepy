/**
 * SSH 金鑰與裝置金鑰清單的 API 型別（對應後端 `api/user_keys.rs`、`api/device_keys.rs`）。
 * API shapes for user keys and per-device key lists.
 */

export interface UserKey {
    id: number;
    host_friendly_name: string;
    key: string;
    description: string | null;
    created_at: string;
    updated_at: string;
    user: number;
    /** `SHA256:…`；舊資料無法解析時為 null。/ null when a legacy key cannot be parsed. */
    fingerprint: string | null;
    key_type: string | null;
    bits: number | null;
    comment: string | null;
    last_used_at: string | null;
    last_used_ip: string | null;
}

export type TunnelRole = "owner" | "admin" | "edit" | "view";

/** 一把金鑰在某個 OS 帳號上的狀態。/ State of one key in one device account. */
export type TargetStatus = "installed" | "pending" | "error";

export interface KeyTarget {
    username: string;
    status: TargetStatus;
    error: string | null;
}

/** `GET /api/reverse/user/keys/devices`：我能用的裝置 × 我在它清單上的金鑰。 */
export interface KeyDevice {
    tunnel_id: number;
    host_friendly_name: string;
    online: boolean;
    role: TunnelRole;
    /** 我在這台能用的 OS 帳號（金鑰會裝進這些）。/ Accounts my keys go into here. */
    accounts: string[];
    keys: { user_key_id: number; targets: KeyTarget[] }[];
}

export interface DeviceKeyEntry {
    user_key_id: number;
    name: string;
    fingerprint: string | null;
    key_type: string | null;
    owner: { id: number; username: string };
    mine: boolean;
    added_by: string;
    created_at: string;
    targets: KeyTarget[];
}

export interface DeviceKeyRemoval {
    username: string;
    fingerprint: string;
    owner: string | null;
    status: "pending" | "error";
    error: string | null;
}

/** `GET /api/reverse/server/{id}/device-keys` */
export interface DeviceKeys {
    tunnel: { id: number; host_friendly_name: string; online: boolean; role: TunnelRole };
    can_manage: boolean;
    accounts: string[];
    entries: DeviceKeyEntry[];
    removals: DeviceKeyRemoval[];
    sync: { username: string; ok: boolean; error: string | null; synced_at: string }[];
    my_keys: { id: number; name: string; fingerprint: string | null; key_type: string | null; in_list: boolean }[];
}

export type AuditKind = "service" | "managed" | "telepy_user" | "unknown" | "invalid";

export interface AuditLine {
    line_no: number;
    kind: AuditKind;
    key_type?: string;
    bits?: number | null;
    fingerprint?: string;
    comment?: string | null;
    options?: string | null;
    in_list?: boolean;
    owner?: string | null;
    key_name?: string | null;
    raw?: string;
}

export interface AuditAccount {
    username: string;
    ok: boolean;
    error: string | null;
    exists: boolean;
    lines: AuditLine[];
}

/** `GET /api/reverse/server/{id}/authorized-keys` */
export interface AuthorizedKeysAudit {
    tunnel_id: number;
    accounts: AuditAccount[];
}
