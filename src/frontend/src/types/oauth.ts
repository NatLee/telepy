/**
 * 已連接的應用程式(OAuth grant)的 API 形狀。/ API shapes of connected apps (OAuth grants).
 */
import type { AiActivityRow, AiSession } from "@/hooks/useAiActivityPage";

export interface OAuthGrant {
    id: number;
    client_id: string;
    client_name: string;
    client_uri?: string | null;
    scopes: string[];
    /** null = 使用者看得到的全部隧道。/ null = every tunnel the user can see. */
    tunnels: { id: number; name: string }[] | null;
    created_at: string;
    last_used_at: string | null;
    /** refresh token 不再使用時的到期時間。/ When access ends if the app stops refreshing. */
    expires_at: string | null;
}

/** `GET /api/oauth/grants/{id}` */
export interface OAuthGrantDetail extends OAuthGrant {
    user: { id: number; username: string | null };
    client: {
        redirect_uris: string[];
        /** 註冊是公開的,名稱誰都能取;導回的網域才是真的。/ Registration is open; the host is what's real. */
        redirect_hosts: string[];
        logo_uri: string | null;
        public: boolean;
        registered_at: string;
    };
    sessions: AiSession[];
    stats: { calls: number; failed: number; last_call_at: string | null };
    activity: AiActivityRow[];
}
