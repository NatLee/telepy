/**
 * 群組（每個人自己的；對應後端 `api/groups.rs`）：通道群組是通道列表的資料夾，金鑰群組是自己的金鑰分組；
 * 金鑰群組可以整組授予一條通道或一個通道群組，之後組裡增減金鑰、通道群組增減通道都會跟著裝 / 移除。
 * Personal groups (backend `api/groups.rs`): tunnel groups are folders for the tunnel list, key groups hold your
 * own keys; a key group is granted as a unit to a tunnel or a tunnel group, and the grant follows membership.
 */

export interface NamedRef {
    id: number;
    name: string;
}

export interface TunnelGroup {
    id: number;
    name: string;
    /** 說明（"" = 沒有）。/ Description ("" = none). */
    description: string;
    /** 標籤（規則同通道標籤）。/ Labels (tunnel label rules). */
    labels: string[];
    position: number;
    /** 這組裡我看得到的通道。/ Tunnels in it that I can see. */
    tunnel_ids: number[];
    created_at: string;
}

/** 金鑰群組授予的對象：一條通道或一個通道群組（只有一個不是 null）。/ Exactly one of the two is set. */
export interface KeyGroupGrant {
    id: number;
    tunnel: NamedRef | null;
    tunnel_group: NamedRef | null;
    /** 只裝到這些帳號名稱；null = 我在那裡能用的每個帳號。/ Account names; null = every account I may use there. */
    accounts: string[] | null;
    created_at: string;
}

export interface KeyGroup {
    id: number;
    name: string;
    description: string;
    labels: string[];
    key_ids: number[];
    grants: KeyGroupGrant[];
    created_at: string;
}

/** 群組的說明與標籤（建立 / 編輯表單送出的）。/ A group's description and labels, as the editors send them. */
export interface GroupMeta {
    description: string;
    labels: string[];
}

/** 改動的回應：整份清單 + 剛建立 / 改到的那組。/ Write replies: the whole list plus the group just touched. */
export interface GroupsReply<T> {
    groups: T[];
    group: T | null;
}

/** 讓一把金鑰來到某台裝置的金鑰群組授予。/ A key group grant that puts a key on a device. */
export interface KeyGroupSource {
    /** 金鑰群組 id。/ Key group id. */
    id: number;
    name: string;
    /** 經由通道群組授予時：哪一組。/ When granted through a tunnel group: which one. */
    tunnel_group: NamedRef | null;
    accounts: string[] | null;
}

/** 從某台裝置看我的金鑰群組：有沒有直接授予這台、或經由我的哪個通道群組。/ My key group as seen from one device. */
export interface MyKeyGroupHere {
    id: number;
    name: string;
    key_count: number;
    grant: { id: number; accounts: string[] | null } | null;
    via_tunnel_group: { id: number; name: string; grant_id: number; accounts: string[] | null } | null;
}
