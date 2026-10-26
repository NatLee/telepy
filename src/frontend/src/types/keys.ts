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
    /** 到期時間；null = 不到期。到期後 Telepy 拒絕它、並從裝置移除。/ Expiry; null = never. Expired keys are refused and removed. */
    expires_at: string | null;
    expired: boolean;
}

export type TunnelRole = "owner" | "admin" | "edit" | "view";

/** 一把金鑰在某個 OS 帳號上的狀態。/ State of one key in one device account. */
export type TargetStatus = "installed" | "pending" | "error";

export interface KeyTarget {
    username: string;
    status: TargetStatus;
    error: string | null;
}

/** 一個登入帳號與它的 id（金鑰「只裝到這些帳號」用 id 指）。/ A login account with its id. */
export interface DeviceAccount {
    id: number;
    username: string;
}

/** `GET /api/reverse/user/keys/devices`：我能用的裝置 × 我在它清單上的金鑰（依裝置名稱排序）。 */
export interface KeyDevice {
    tunnel_id: number;
    host_friendly_name: string;
    online: boolean;
    role: TunnelRole;
    /** 我在這台能用的 OS 帳號（金鑰會裝進這些）。/ Accounts my keys go into here. */
    accounts: string[];
    account_list: DeviceAccount[];
    /** `accounts`：這把金鑰只裝到這些帳號 id；null = 全部。/ `accounts`: chosen account ids; null = all. */
    keys: { user_key_id: number; accounts: number[] | null; targets: KeyTarget[] }[];
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
    /** 只裝到這些帳號（id）；null = 擁有者能用的每個帳號。/ Chosen account ids; null = every allowed account. */
    accounts: number[] | null;
    targets: KeyTarget[];
}

/** 手動從某帳號 authorized_keys 移除的一批（7 天內可還原）。/ One manual removal, restorable for 7 days. */
export interface KeyRemoval {
    id: number;
    username: string;
    keys: number;
    lines: number;
    removed_by: string;
    removed_at: string;
    restored_at: string | null;
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
    /** 裝置的平台（連過裝置才知道）：Windows 的管理員金鑰在共用的 administrators_authorized_keys。/ Known once dialed. */
    platform: { windows: boolean; error: string | null } | null;
    can_manage: boolean;
    accounts: string[];
    /** `accounts` 加上 id（金鑰的帳號選擇用）。/ The same accounts with ids. */
    account_ids: DeviceAccount[];
    entries: DeviceKeyEntry[];
    removals: DeviceKeyRemoval[];
    sync: { username: string; ok: boolean; error: string | null; synced_at: string }[];
    /** `accounts`：在清單上時，只裝到這些帳號 id；null = 全部。/ When listed: chosen account ids; null = all. */
    my_keys: { id: number; name: string; fingerprint: string | null; key_type: string | null; in_list: boolean; expired?: boolean; accounts: number[] | null }[];
    /** 每個帳號一張卡：清單與裝置上實際內容合在一起。/ Per-account merged view. */
    view: { accounts: ViewAccount[] };
}

/** 合併檢視一列的狀態。/ State of one row in the merged view. */
export type RowState = "service" | "installed" | "pending" | "error" | "removing" | "manual" | "unknown" | "invalid";

/** 一把金鑰在一個帳號：清單 × Telepy 裝過的 × 最近一次讀到的檔案。/ One key in one account. */
export interface ViewRow {
    state: RowState;
    /** service 列：全站共用的舊服務金鑰（每條通道都改用自己的金鑰後會被移掉）。/ service rows: the legacy shared key. */
    legacy: boolean;
    /** 最近一次讀檔時在檔案裡看到。/ Seen in the file at the last check. */
    verified: boolean;
    on_list: boolean;
    mine: boolean;
    user_key_id: number | null;
    name: string | null;
    owner: string | null;
    fingerprint: string | null;
    key_type: string | null;
    bits: number | null;
    comment: string | null;
    options: string | null;
    line_no: number | null;
    /** 這把金鑰在檔案裡佔幾行（重複貼上時 > 1）。/ Lines holding this key (> 1 for duplicates). */
    line_count: number;
    error: string | null;
    raw: string | null;
    /** 清單上的金鑰：只裝到這些帳號 id；null = 全部。/ Listed keys: chosen account ids; null = all. */
    accounts: number[] | null;
}

export interface ViewAccount {
    username: string;
    /** 這個帳號的金鑰檔：`~/.ssh/authorized_keys`，Windows 管理員是 `%ProgramData%\ssh\administrators_authorized_keys`。 */
    file: string;
    /** Windows 本機管理員（sshd 不看它自己的 authorized_keys）。/ A Windows administrator. */
    windows_admin: boolean;
    /** 最近一次讀檔；null = 還沒讀過。/ Last read of the file; null = never. */
    checked_at: string | null;
    exists: boolean | null;
    error: string | null;
    rows: ViewRow[];
}
