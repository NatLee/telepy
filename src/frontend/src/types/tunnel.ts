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
    /**
     * 分享給誰（只在列表裡；分享的先後順序）。只給 owner / ADMIN（能管分享的人），其他人 null。
     * Who it is shared with (list only, in sharing order); owner / ADMIN only, null for everyone else.
     */
    shared_with?: TunnelSharee[] | null;
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
    /** 我把它放在哪個通道群組（每個人自己的）；null = 未分組。/ My tunnel group for it (personal); null = ungrouped. */
    group_id?: number | null;
    /** 隧道標籤（大家共用，EDIT 以上可改）。/ Shared labels (EDIT and up may change them). */
    labels?: string[];
    /** 開 session 前要確認是你（step-up）。/ Sessions ask for a step-up first. */
    require_step_up?: boolean;
    /** 網頁終端機會錄影。/ Web terminal sessions are recorded. */
    record_sessions?: boolean;
    /** 網頁終端機斷線時：user = 照每個人的保留時間、never = 一律立刻結束。/ user = each person's grace, never = end at once. */
    terminal_detach_policy?: "user" | "never";
    /** 分享給我的這筆什麼時候結束（只在列表裡；自己的隧道或沒期限時 null）。/ When my share ends (list only; null = mine or no end). */
    share_expires_at?: string | null;
    /** owner / ADMIN：等我決定的存取申請數（只在列表裡）。/ Owner / ADMIN: access requests waiting (list only). */
    access_requests?: number;
    /** 裝置出示了和釘選不同的 SSH host key，等擁有者確認。/ The device presented a different host key; waiting for review. */
    host_key_changed?: boolean;
    /** 這條隧道指到的機器屬於別的帳號的隧道，連線被拒。/ The machine behind this tunnel belongs to another account's tunnel; refused. */
    device_claimed?: boolean;
    /** 單筆才有：這條通道自己的服務公鑰（裝置要授權的那把）。/ Single retrieve only: the tunnel's own service key. */
    service_key?: string | null;
}

/**
 * online：經由隧道讀得到裝置 sshd；degraded：隧道在、sshd 沒回應；offline：連過但現在斷線；never：從沒連上過。
 * online / degraded (tunnel up, device sshd not answering) / offline / never connected.
 */
export type TunnelHealth = "online" | "degraded" | "offline" | "never";

/** 一位分享對象；`permission` 是現在有效的那個（暫時提升過期就是原本的）。/ One sharee; `permission` is the one in force now. */
export interface TunnelSharee {
    id: number;
    username: string;
    /** view / edit / admin */
    permission: string;
}

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
    /** 連著時：tcp（24242）或 websocket（/ws/gateway/）。/ While connected: how the device reached the gateway. */
    transport?: "tcp" | "websocket" | null;
    connected_at: string;
    last_seen_at: string | null;
    /** 位址範圍與（有 GeoIP 時的）國家 / 業者。/ Scope plus country / network owner. */
    geo?: IpGeo | null;
    /** 最近一次換「公網 IP」之前的位址與換的時間。/ The public address before the latest change, and when. */
    previous_ip?: string | null;
    changed_at?: string | null;
    /** 裝置真正的公網 IP（gateway 看到的公網來源，或裝置經 /api/whoami / 站台設定的查詢網址回報的）。/ The device's real public IP. */
    public_ip?: string | null;
    /** gateway / device（經 /api/whoami）/ lookup（經站台設定的 device_ip_lookup_url） */
    public_source?: string | null;
    public_geo?: IpGeo | null;
    /** 裝置自己網卡上的位址（每次連上問一次）。/ The device's own interfaces (asked once per connection). */
    lan?: { iface: string; ip: string; prefix: number }[];
    hostname?: string | null;
    probed_at?: string | null;
    probe_error?: string | null;
    /** 裝置的基本狀況（跟位址同一個每天一次的唯讀腳本）。/ Device facts from the same daily read-only script. */
    facts?: DeviceFacts | null;
    facts_at?: string | null;
}

/** 磁碟 / 記憶體 / 負載 / 重開機。/ Disk, memory, load or a pending reboot. */
export type DeviceWarningKind = "disk" | "memory" | "load" | "reboot";

export interface DeviceWarning {
    kind: DeviceWarningKind | string;
    /** 英文一句話（後端產生）。/ One English sentence from the backend. */
    detail: string;
}

/** 每一項都可能是 null（裝置上沒有那個指令）。/ Any field may be null (the command is missing on the device). */
export interface DeviceFacts {
    os?: string | null;
    kernel?: string | null;
    arch?: string | null;
    /** 讀的當下開機幾秒（對照 facts_at）。/ Seconds since boot at `facts_at`. */
    uptime_s?: number | null;
    cpu_model?: string | null;
    cpus?: number | null;
    mem_total_kb?: number | null;
    mem_avail_kb?: number | null;
    disk_total_kb?: number | null;
    disk_avail_kb?: number | null;
    /** 1 / 5 / 15 分鐘負載（Windows 沒有）。/ 1 / 5 / 15-minute load (none on Windows). */
    load?: [number, number, number] | null;
    ssh?: string | null;
    /** 只有 Debian 家族知道。/ Debian family only. */
    reboot_required?: boolean | null;
    warnings?: DeviceWarning[];
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
    /** 檔案管理 socket（原生 SFTP）才有：位元組、`0644`、`-rw-r--r--`、epoch 秒、是不是 symlink。
     *  From the file-manager socket (native SFTP) only: bytes, octal mode, ls-style string, epoch mtime, symlink. */
    bytes?: number;
    mode?: string;
    perm?: string;
    mtime?: number | null;
    link?: boolean;
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
    /** 這條隧道的終端機錄影（/tunnels/recordings?tunnel=<id>）。/ This tunnel's terminal recordings. */
    onRecordings?: (tunnelId: number) => void;
    /** 指令規則頁（這條隧道）。/ The command rules page for this tunnel. */
    onCommandRules?: (tunnelId: number) => void;
    /** 開終端機並打開工具箱。/ Open the terminal with the toolbox open. */
    onToolbox?: (tunnelId: number) => void;
    /** 釘選 / 取消釘選（每個人自己的）。/ Pin or unpin (per user). */
    onTogglePin?: (tunnelId: number, pinned: boolean) => void;
    /** 點了某個標籤：用它篩選列表。/ A label was clicked: filter the list by it. */
    onLabel?: (label: string) => void;
    /** 換到別的通道群組（每個人自己的分組）。/ Move it to another of my tunnel groups. */
    onMoveToGroup?: (tunnelId: number) => void;
}
