import type { TunnelEndpoint } from "@/types/tunnel";
import type { WebLink } from "@/lib/lanWeb";
import type { HostIdentity, HostService } from "@/lib/lanIdentity";

/**
 * 區網探索 / 跳板機（#20）的型別，對應 `/api/reverse/lan/topology` 與 `/api/reverse/server/{id}/lan/*`。
 * Types for LAN discovery and jump hosts.
 */

export interface LanHost {
    id: number;
    tunnel_id: number;
    /** IPv4 位址或主機名稱。/ IPv4 address or hostname. */
    address: string;
    hostname: string | null;
    mac: string | null;
    /** 網卡廠商（後端有 IEEE OUI 表才有）。/ NIC vendor (when the server has the OUI table). */
    vendor?: string | null;
    /** 隨機 / 私有 MAC（查不到廠商）。/ Randomized (private) MAC; no vendor. */
    mac_private?: boolean;
    open_ports: number[];
    /** 開著的網頁 port 與網址（後端算的；舊後端沒有）。/ Open web ports with their URLs (from the backend; absent on older ones). */
    web?: WebLink[];
    /** 最後一次掃描在每個 port 認出來的（網頁標題、Server、憑證、banner）。/ What the last scan recognised per port. */
    services?: HostService[];
    /** 這台是什麼（產品、類型、系統、憑哪條線索）；認不出來是 null。/ What it is; null when unknown. */
    identity?: HostIdentity | null;
    ssh_banner: string | null;
    label: string | null;
    /** 連這台機器時預設的帳號。/ Default login on this machine. */
    username: string | null;
    ssh_port: number;
    /** `self` = 裝置自己在聽的服務（位址 `localhost`）。/ `self` = the device's own listening services (address `localhost`). */
    source: "scan" | "manual" | "self";
    /** 裝置自己（同 `source === "self"`）。/ The device itself. */
    own?: boolean;
    /** 它是裝置的預設閘道。/ It is the device's default gateway. */
    gateway?: boolean;
    /** 上次掃描有掃它的網段、卻沒看到它。/ Its network was scanned last time but it wasn't seen. */
    missing?: boolean;
    /** 上次掃描跟前一次比，它變了什麼（沒變 = null）。/ What the last scan changed for it (null = nothing). */
    since_last?: { new: boolean; opened: number[]; closed: number[] } | null;
    /** 最後一次有掃描（整網段或「檢查這台」）探過它。/ When a scan (full or a check) last covered it. */
    checked_at?: string | null;
    /** 我有在注意它（掃描發現它不見、回來或 port 變了就通知我）。/ I watch it (told when it goes, comes back or changes ports). */
    watched?: boolean;
    first_seen: string | null;
    last_seen: string | null;
    created_at: string;
}

/** connecting | networks | discovery | ports | identify | names | self | done | failed */
export type LanScanPhase = "connecting" | "networks" | "discovery" | "ports" | "identify" | "names" | "self" | "done" | "failed";

/** 兩次掃描之間變了什麼。/ What changed between two scans. */
export interface LanChanges {
    new: string[];
    gone: string[];
    changed: { address: string; opened: number[]; closed: number[] }[];
}

/** 一條隧道最近一次掃描的整體結果。/ A tunnel's last scan as a whole. */
export interface LanSummary {
    networks: string[];
    gateway: string | null;
    scanned_at: string | null;
    /** null = 還沒比過（舊的掃描）。/ null = not compared yet. */
    changes: LanChanges | null;
}

export interface LanScan {
    scan_id: string;
    tunnel_id: number;
    started_by: string;
    started_at: string;
    finished_at: string | null;
    phase: LanScanPhase;
    networks: string[];
    ports: number[];
    probed: number;
    total: number;
    hosts_found: number;
    error: string | null;
    /** 跟前一次比變了什麼（做完才有）。/ What changed since the previous scan (once done). */
    changes?: LanChanges | null;
    gateway?: string | null;
    /** `manual` | `schedule` | `check`（只檢查一台）。/ What started it. */
    trigger?: "manual" | "schedule" | "check";
    /** `check` 檢查的主機。/ The host a check looks at. */
    host_id?: number | null;
}

/** 定時重掃（每條隧道一組；照設定的人的身分跑）。/ A tunnel's scheduled rescan (runs as whoever set it). */
export interface LanSchedule {
    every_secs: number;
    username: string | null;
    subnets: string[] | null;
    ports: number[] | null;
    identify: boolean;
    next_at: string;
    last_at: string | null;
    last_error: string | null;
    by: string | null;
    updated_at: string;
}

export interface TopologyTunnel {
    id: number;
    name: string;
    reverse_port: number;
    /** null = 伺服器還不知道（監控剛啟動）。/ null = not known yet. */
    online: boolean | null;
    rtt_ms: number | null;
    permission: "owner" | "admin" | "edit" | "view" | string;
    can_scan: boolean;
    can_edit: boolean;
    /** 你可以用的裝置帳號（跳板那一跳）。/ Device accounts you may use (the jump hop). */
    usernames: string[];
    default_username: string | null;
    /** 裝置自己的位址（內網網卡、公網 IP），同隧道列表；不能登入裝置的人是 null。/ The device's own addresses, as on the tunnel list; null without an allowed account. */
    endpoint?: TunnelEndpoint | null;
    scan: LanScan | null;
    /** 最近一次掃描（網段、閘道、時間、變化）；沒掃過 = null。/ The last scan; null when never scanned. */
    lan?: LanSummary | null;
    /** 定時重掃；沒設 = null。/ The scheduled rescan; null when none. */
    schedule?: LanSchedule | null;
    hosts: LanHost[];
}
