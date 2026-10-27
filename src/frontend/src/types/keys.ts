/**
 * SSH 金鑰與裝置金鑰清單的 API 型別（對應後端 `api/user_keys.rs`、`api/device_keys.rs`）。
 * API shapes for user keys and per-device key lists.
 */
import type { KeyGroupSource, MyKeyGroupHere, NamedRef } from "./groups";

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
    /** 它在哪個金鑰群組；null = 未分組。/ Its key group; null = none. */
    group_id?: number | null;
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
    /** 我把這台放在哪個通道群組。/ My tunnel group for this device. */
    group_id?: number | null;
    /**
     * `accounts`：直接在清單上時只裝到這些帳號 id（null = 全部）；`direct` = 直接在清單上；`groups` = 經由哪些金鑰群組。
     * `accounts`: the direct entry's chosen ids (null = all); `direct` = listed directly; `groups` = key group grants.
     */
    keys: { user_key_id: number; accounts: number[] | null; direct?: boolean; groups?: KeyGroupSource[]; targets: KeyTarget[] }[];
}

export interface DeviceKeyEntry {
    user_key_id: number;
    name: string;
    fingerprint: string | null;
    key_type: string | null;
    owner: { id: number; username: string };
    mine: boolean;
    /** 擁有者的帳號停用了：還在清單上，但 Telepy 把它從裝置拿掉了（重新啟用就裝回去）。/ Owner disabled: listed, off the device. */
    owner_disabled?: boolean;
    added_by: string;
    created_at: string;
    /** 只裝到這些帳號（id）；null = 擁有者能用的每個帳號。/ Chosen account ids; null = every allowed account. */
    accounts: number[] | null;
    /** 直接在清單上（能直接移出）；false = 只經由金鑰群組來。/ Listed directly; false = only through key groups. */
    direct: boolean;
    /** 經由哪些金鑰群組來。/ The key group grants that bring it here. */
    groups: KeyGroupSource[];
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
    my_keys: {
        id: number;
        name: string;
        fingerprint: string | null;
        key_type: string | null;
        in_list: boolean;
        expired?: boolean;
        accounts: number[] | null;
        /** 它的金鑰群組。/ Its key group. */
        group_id?: number | null;
        /** 經由金鑰群組來到這台。/ Group grants that bring it to this device. */
        via_groups?: KeyGroupSource[];
    }[];
    /** 我的金鑰群組與它們有沒有到這台。/ My key groups and whether each reaches this device. */
    my_key_groups?: MyKeyGroupHere[];
    /** 每個帳號一張卡：清單與裝置上實際內容合在一起。/ Per-account merged view. */
    view: { accounts: ViewAccount[]; keep_shared?: boolean };
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
    /** 清單上的金鑰：直接加的（能直接移出）。/ Listed keys: added directly (can be taken off directly). */
    direct?: boolean;
    /** 清單上的金鑰：經由哪些金鑰群組。/ Listed keys: the key groups that bring it here. */
    groups?: NamedRef[];
    /** 金鑰擁有者的帳號停用了（removing = Telepy 正在拿掉；manual = 手動加的，Telepy 不動）。/ The key owner is disabled. */
    owner_disabled?: boolean;
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
