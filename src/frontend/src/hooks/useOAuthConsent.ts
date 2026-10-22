/**
 * OAuth 同意頁邏輯：URL 上是 MCP 客戶端送來的授權請求；用網頁登入（Bearer JWT）向後端取顯示資料，
 * 使用者核可／拒絕後把瀏覽器導到後端回的 redirect_to。
 * Consent-page logic: the authorization request is in the URL; fetch what to show with the web login,
 * then send the browser to the backend's redirect_to after approve / deny.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

export interface ConsentScope {
    name: string;
    description: string;
}

export interface ConsentTunnel {
    id: number;
    name: string;
    permission: string | null;
}

export interface ConsentInfo {
    client: { client_id: string; client_name: string; client_uri?: string | null; logo_uri?: string | null };
    redirect_uri: string;
    redirect_host: string;
    scopes: ConsentScope[];
    tunnels: ConsentTunnel[];
    user: { id: number; username: string };
}

export interface ConsentError {
    error: string;
    error_description?: string;
    redirect_to?: string;
}

/** 授權請求的參數（原樣轉給後端）。/ The authorization request parameters, forwarded verbatim. */
const REQUEST_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;

export function useOAuthConsent() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const { t } = useI18n();

    const [info, setInfo] = useState<ConsentInfo | null>(null);
    const [error, setError] = useState<ConsentError | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
    /** null = 全部隧道。/ null = every tunnel. */
    const [tunnelIds, setTunnelIds] = useState<number[] | null>(null);

    const request = useMemo(() => {
        const out: Record<string, string> = {};
        for (const k of REQUEST_PARAMS) {
            const v = searchParams.get(k);
            if (v !== null && v !== "") out[k] = v;
        }
        return out;
    }, [searchParams]);
    const query = useMemo(() => new URLSearchParams(request).toString(), [request]);

    // 沒登入 → 去登入頁，登入後回到這個 URL。/ Not logged in → login, then come back here.
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.replace(`/login?next=${encodeURIComponent(`${pathname}?${query}`)}`);
        }
    }, [authLoading, isAuthenticated, router, pathname, query]);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await apiFetch(`/api/oauth/authorize?${query}`);
                const data = await readJson<ConsentInfo & ConsentError>(res);
                if (cancelled) return;
                if (res.ok && data && "client" in data) {
                    setInfo(data);
                    setSelectedScopes(data.scopes.map((s) => s.name));
                    setError(null);
                } else {
                    setError({ error: data?.error ?? "invalid_request", error_description: data?.error_description ?? t("oauth.loadFailed"), redirect_to: data?.redirect_to });
                }
            } catch {
                if (!cancelled) setError({ error: "network", error_description: t("oauth.loadFailed") });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, query, t]);

    const toggleScope = useCallback((name: string) => {
        setSelectedScopes((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
    }, []);

    const toggleTunnel = useCallback(
        (id: number) => {
            setTunnelIds((prev) => {
                const all = info?.tunnels.map((x) => x.id) ?? [];
                // 從「全部」第一次點 = 只取消這一條。/ First click from "all" deselects just that tunnel.
                const base = prev ?? all;
                return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
            });
        },
        [info]
    );

    const selectAllTunnels = useCallback(() => setTunnelIds(null), []);

    const decide = useCallback(
        async (approve: boolean) => {
            setSubmitting(true);
            try {
                const body: Record<string, unknown> = { ...request, approve };
                if (approve) {
                    body.scopes = selectedScopes;
                    body.tunnel_ids = tunnelIds;
                }
                const res = await apiFetch("/api/oauth/authorize", { method: "POST", body: JSON.stringify(body) });
                const data = await readJson<{ redirect_to?: string } & ConsentError>(res);
                if (res.ok && data?.redirect_to) {
                    window.location.assign(data.redirect_to);
                    return;
                }
                setError({ error: data?.error ?? "server_error", error_description: data?.error_description ?? t("oauth.decisionFailed"), redirect_to: data?.redirect_to });
            } catch {
                setError({ error: "network", error_description: t("oauth.decisionFailed") });
            } finally {
                setSubmitting(false);
            }
        },
        [request, selectedScopes, tunnelIds, t]
    );

    const allTunnelIds = info?.tunnels.map((x) => x.id) ?? [];
    const effectiveTunnelIds = tunnelIds ?? allTunnelIds;
    const canApprove = !!info && selectedScopes.length > 0 && (tunnelIds === null || tunnelIds.length > 0) && !submitting;

    return {
        state: { info, error, loading: loading || authLoading, submitting, selectedScopes, tunnelIds, effectiveTunnelIds, canApprove, request },
        actions: { toggleScope, toggleTunnel, selectAllTunnels, approve: () => decide(true), deny: () => decide(false) },
    };
}
