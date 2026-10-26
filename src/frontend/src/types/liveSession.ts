/**
 * 即時 session（`GET /api/sessions`）。/ Live sessions.
 */
import type { IpGeo } from "@/lib/geo";

export type SessionKind = "terminal" | "files" | "browser" | "desktop" | "rustdesk" | "ssh" | "ai";

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
    /** kind = ai：這個 agent session 開著幾個互動 shell。/ kind = ai: interactive shells open on the agent's session. */
    shells?: number | null;
    mine: boolean;
}
