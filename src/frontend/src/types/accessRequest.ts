/**
 * 存取申請型別（`/api/reverse/server/{id}/access-requests`）。
 * Access request types.
 */
export type SharePermission = "view" | "edit" | "admin";
export type AccessRequestStatus = "pending" | "approved" | "denied" | "cancelled";

export interface AccessRequest {
    id: number;
    tunnel_id: number;
    requester: { id: number; username: string | null };
    accounts: { id: number; username: string | null }[];
    permission: SharePermission | null;
    duration_secs: number;
    reason: string;
    status: AccessRequestStatus;
    created_at: string;
    decided_by: string | null;
    decided_at: string | null;
    /** 核准後暫時授權到什麼時候。/ When an approved grant ends. */
    ends_at: string | null;
}

/** 被分享的人可以要的帳號：allowed = 已經能用；until = 暫時的到什麼時候。/ An account a sharee could ask for. */
export interface RequestableAccount {
    id: number;
    username: string;
    allowed: boolean;
    until: string | null;
}

export interface AccessRequestList {
    can_decide: boolean;
    can_request: boolean;
    /** owner / admin / edit / view */
    permission: string;
    requests: AccessRequest[];
    accounts?: RequestableAccount[];
    permission_until?: string | null;
}
