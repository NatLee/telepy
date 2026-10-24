/**
 * 終端機錄影（`GET /api/recordings`）。/ Terminal recordings.
 */
export interface Recording {
    id: number;
    tunnel: { id: number; name: string | null };
    user: { id: number; username: string };
    /** 裝置上的帳號。/ The device account. */
    os_user: string;
    /** 區網主機 `login@address`。/ A LAN host as `login@address`. */
    lan_host: string | null;
    started_at: string;
    ended_at: string | null;
    live: boolean;
    duration_ms: number;
    bytes: number;
    truncated: boolean;
    can_delete: boolean;
}
