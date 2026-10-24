/**
 * OAuth 同意頁邏輯：URL 上是 MCP 客戶端送來的授權請求；用網頁登入（Bearer JWT）向後端取顯示資料，
 * 使用者核可／拒絕後把瀏覽器導到後端回的 redirect_to，並留在「已允許 / 已拒絕」的結果畫面（自訂 scheme 的 app
 * 不會換頁，舊版會跳回表單讓人以為沒成功）。沒登入 → /oauth/login；「不是你？」登出後回到同一個請求；
 * 管理員要求兩步驟而帳號還沒設好 → 先設定再繼續。
 * Consent-page logic: fetch what to show with the web login, send the browser to the backend's redirect_to
 * after approve / deny and stay on a result view (custom-scheme apps do not navigate away). Signed out →
 * /oauth/login; "Not you?" signs out and returns to the same request; required two-step setup comes first.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useReauth } from "@/hooks/useReauth";
import { mfaErrorMessage, needsReauth, type MfaMethod, type MfaProof } from "@/lib/mfa";
import { loginPathFor, matchesTunnel } from "@/lib/oauthFlow";
import type { RequiredFactor } from "@/types/auth";

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
    /** 帳號有兩步驟驗證 → 核可前要再驗證。/ Accounts with 2FA confirm the approval. */
    reauth?: { required: boolean; methods: MfaMethod[] };
    /** 這個帳號先前連接過同一個 app（仍有效的連線）。/ Earlier, still active connections of this same app. */
    existing?: { id: number; scopes: string[]; created_at: string; last_used_at: string | null }[];
}

/** 送出決定之後：導回 app 的網址，畫面停在結果。/ After a decision: where the app is, and the result view. */
export interface ConsentDecision {
    approved: boolean;
    to: string;
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
    const { isAuthenticated, isLoading: authLoading, user, logout, fetchUserProfile } = useAuth();
    const { t } = useI18n();
    const reauth = useReauth();

    const [info, setInfo] = useState<ConsentInfo | null>(null);
    /** 再驗證失敗（碼錯、鎖定…）：顯示在按鈕旁，不換成錯誤頁。/ Step-up failures stay next to the buttons. */
    const [stepUpError, setStepUpError] = useState<string | null>(null);
    const [error, setError] = useState<ConsentError | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
    /** all = 全部隧道（含之後才有的）；some = 只限勾選的。/ all = every tunnel, later ones too; some = only the ticked ones. */
    const [tunnelMode, setTunnelMode] = useState<"all" | "some">("all");
    const [tunnelIds, setTunnelIds] = useState<number[]>([]);
    const [tunnelQuery, setTunnelQuery] = useState("");
    /** 重新連接同一個 app 時取代舊連線（預設勾）。/ Replace the earlier connection when reconnecting (on by default). */
    const [replace, setReplace] = useState(true);
    const [decision, setDecision] = useState<ConsentDecision | null>(null);
    /** 管理員要求兩步驟、帳號還沒設好（後端 403 mfa_enrollment_required）。/ Required two-step setup is missing. */
    const [enrollMissing, setEnrollMissing] = useState<RequiredFactor[] | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const request = useMemo(() => {
        const out: Record<string, string> = {};
        for (const k of REQUEST_PARAMS) {
            const v = searchParams.get(k);
            if (v !== null && v !== "") out[k] = v;
        }
        return out;
    }, [searchParams]);
    const query = useMemo(() => new URLSearchParams(request).toString(), [request]);

    const here = `${pathname}?${query}`;

    // 沒登入 → OAuth 登入頁（不是一般登入頁），登入後回到這個 URL。/ Signed out → the OAuth sign-in, then back here.
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.replace(loginPathFor(here));
        }
    }, [authLoading, isAuthenticated, router, here]);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await apiFetch(`/api/oauth/authorize?${query}`);
                const data = await readJson<ConsentInfo & ConsentError & { code?: string; missing?: RequiredFactor[] }>(res);
                if (cancelled) return;
                if (res.ok && data && "client" in data) {
                    setInfo(data);
                    setSelectedScopes(data.scopes.map((s) => s.name));
                    setEnrollMissing(null);
                    setError(null);
                } else if (res.status === 403 && data?.code === "mfa_enrollment_required") {
                    setEnrollMissing(data.missing ?? []);
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
    }, [authLoading, isAuthenticated, query, t, reloadKey]);

    const toggleScope = useCallback((name: string) => {
        setSelectedScopes((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
    }, []);

    const toggleTunnel = useCallback((id: number) => {
        setTunnelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    }, []);

    const allTunnels = useMemo(() => info?.tunnels ?? [], [info]);
    const shownTunnels = useMemo(() => allTunnels.filter((x) => matchesTunnel(x.name, tunnelQuery)), [allTunnels, tunnelQuery]);

    /** 勾 / 取消目前搜尋結果裡的全部。/ Tick or untick every tunnel the search shows. */
    const setShownTunnels = useCallback(
        (on: boolean) => {
            const ids = shownTunnels.map((x) => x.id);
            setTunnelIds((prev) => (on ? [...new Set([...prev, ...ids])] : prev.filter((id) => !ids.includes(id))));
        },
        [shownTunnels]
    );

    const leave = useCallback((d: ConsentDecision) => {
        setDecision(d);
        window.location.assign(d.to);
    }, []);

    /** 「不是你？」：登出後回到同一個請求（OAuth 登入頁）。/ "Not you?": sign out and come back to this request. */
    const switchAccount = useCallback(() => logout(here), [logout, here]);

    /** 兩步驟設定完成：更新 profile 再重抓同意頁資料。/ Two-step setup done: refresh the profile and reload. */
    const enrollmentDone = useCallback(() => {
        setEnrollMissing(null);
        void fetchUserProfile();
        setReloadKey((k) => k + 1);
    }, [fetchUserProfile]);

    const decide = useCallback(
        async (approve: boolean) => {
            setSubmitting(true);
            setStepUpError(null);
            try {
                const body: Record<string, unknown> = { ...request, approve };
                if (approve) {
                    body.scopes = selectedScopes;
                    body.tunnel_ids = tunnelMode === "all" ? null : tunnelIds;
                    if (info?.existing?.length) body.replace = replace;
                    // 核可 = 讓 AI 拿到 SSH 權限：有兩步驟驗證的帳號先再驗證。/ Step up before granting SSH access.
                    if (info?.reauth?.required) {
                        const proof: MfaProof | null = await reauth.request(info.reauth.methods);
                        if (!proof) return;
                        body.reauth = proof;
                    }
                }
                let res = await apiFetch("/api/oauth/authorize", { method: "POST", body: JSON.stringify(body) });
                let data = await readJson<{ redirect_to?: string; code?: string } & ConsentError>(res);
                // 頁面載入後才啟用 2FA：後端要求再驗證就問一次。/ 2FA turned on after the page loaded.
                const methods = approve && !body.reauth ? needsReauth(res.status, data) : null;
                if (methods) {
                    const proof = await reauth.request(methods);
                    if (!proof) return;
                    body.reauth = proof;
                    res = await apiFetch("/api/oauth/authorize", { method: "POST", body: JSON.stringify(body) });
                    data = await readJson<{ redirect_to?: string; code?: string } & ConsentError>(res);
                }
                if (res.ok && data?.redirect_to) {
                    leave({ approved: approve, to: data.redirect_to });
                    return;
                }
                if (data?.code) {
                    setStepUpError(mfaErrorMessage(t, data, t("oauth.decisionFailed")));
                    return;
                }
                setError({ error: data?.error ?? "server_error", error_description: data?.error_description ?? t("oauth.decisionFailed"), redirect_to: data?.redirect_to });
            } catch {
                setError({ error: "network", error_description: t("oauth.decisionFailed") });
            } finally {
                setSubmitting(false);
            }
        },
        [request, selectedScopes, tunnelMode, tunnelIds, replace, t, info, reauth, leave]
    );

    const canApprove = !!info && selectedScopes.length > 0 && (tunnelMode === "all" || tunnelIds.length > 0) && !submitting && !decision;
    // profile 比同意頁資料先知道還缺什麼（設定途中會更新）。/ The profile tracks what is still missing during setup.
    const missing = enrollMissing === null ? null : (user?.mfa_missing ?? enrollMissing);

    return {
        state: {
            info,
            error,
            loading: loading || authLoading,
            submitting,
            selectedScopes,
            tunnelMode,
            tunnelIds,
            tunnelQuery,
            allTunnels,
            shownTunnels,
            replace,
            decision,
            enrollMissing: missing,
            canApprove,
            request,
            stepUpError,
        },
        reauthDialog: reauth.dialog,
        actions: {
            toggleScope,
            toggleTunnel,
            setTunnelMode,
            setTunnelQuery,
            setShownTunnels,
            setReplace,
            switchAccount,
            enrollmentDone,
            reopen: () => decision && window.location.assign(decision.to),
            approve: () => decide(true),
            deny: () => decide(false),
        },
    };
}
