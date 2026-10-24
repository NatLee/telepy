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
    ssh_banner: string | null;
    label: string | null;
    /** 連這台機器時預設的帳號。/ Default login on this machine. */
    username: string | null;
    ssh_port: number;
    source: "scan" | "manual";
    first_seen: string | null;
    last_seen: string | null;
    created_at: string;
}

/** connecting | networks | discovery | ports | names | done | failed */
export type LanScanPhase = "connecting" | "networks" | "discovery" | "ports" | "names" | "done" | "failed";

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
    scan: LanScan | null;
    hosts: LanHost[];
}
