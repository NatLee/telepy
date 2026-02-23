/**
 * 通道與反向代理相關型別 / Tunnel and Reverse Proxy types
 * Defines shapes for tunnels, users, and files associated with them.
 */

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
}

export interface TunnelModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}
