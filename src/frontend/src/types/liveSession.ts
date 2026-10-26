/**
 * 即時 session（`GET /api/sessions`）。/ Live sessions.
 */
import type { IpGeo } from "@/lib/geo";

export type SessionKind = "terminal" | "files" | "browser" | "desktop" | "rustdesk" | "ssh" | "ai";

export interface LiveSession {
    id: number;
    /** 經 Telepy RustDesk 伺服器連的裝置（這時沒有隧道：`tunnel.id` = 0）。/ A RustDesk-server device (no tunnel then). */
    device?: { id: number; name: string } | null;
    tunnel: { id: number; name: string | null };
    user: { id: number; username: string };
    kind: SessionKind | string;
    ip: string | null;
    geo?: IpGeo | null;
    /** UTC ISO */
    since: string;
    /** MCP app name */
    client: string | null;
    mine: boolean;
}
