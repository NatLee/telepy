/**
 * MCP 頁邏輯:MCP 端點網址與目前開著的 AI session 數。
 * 網址取自 RFC 9728 discovery(`resource`,後端依 PUBLIC_URL 或 X-Forwarded-* 決定),
 * 這樣顯示的就是 AI 客戶端實際要連的位址;拿不到時退回目前網站的 origin + /mcp。
 * MCP page logic: the MCP endpoint URL and the number of open AI sessions. The URL comes from the
 * RFC 9728 discovery document (`resource`, built from PUBLIC_URL or the forwarded headers) so it
 * matches what clients connect to; falls back to this site's origin + /mcp.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/** MCP 端點網址;載入中為 null。設定頁的 AI 分頁也用它。/ The MCP endpoint URL (null while loading). */
export function useMcpServerUrl() {
    const [serverUrl, setServerUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            let url = `${window.location.origin}/mcp`;
            try {
                const res = await fetch(`${API_BASE}/.well-known/oauth-protected-resource/mcp`);
                if (res.ok) {
                    const data = await res.json();
                    if (typeof data?.resource === "string" && data.resource) url = data.resource;
                }
            } catch {
                /* 退回 origin / fall back to the origin */
            }
            if (!cancelled) setServerUrl(url);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return serverUrl;
}

export function useMcpPage() {
    const serverUrl = useMcpServerUrl();
    const [openSessions, setOpenSessions] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/ai/sessions");
                const data = res.ok ? await res.json() : null;
                if (!cancelled && Array.isArray(data)) setOpenSessions(data.length);
            } catch {
                /* 只是摘要,失敗就不顯示 / summary only; hide on failure */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return { serverUrl, openSessions };
}
