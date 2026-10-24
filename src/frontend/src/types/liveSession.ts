/**
 * 即時 session（`GET /api/sessions`）。/ Live sessions.
 */
import type { IpGeo } from "@/lib/geo";

export type SessionKind = "terminal" | "files" | "browser" | "desktop" | "ssh" | "ai";

export interface LiveSession {
    id: number;
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
