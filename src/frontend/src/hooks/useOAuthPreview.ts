/**
 * OAuth 登入頁：登入前先向後端問「是誰在要求連接」（公開的 /api/oauth/authorize/preview，不含帳號資料）。
 * 請求本身壞掉時（未知的 client、redirect_uri 不符…）在這裡就知道，不用先登入才看到錯誤。
 * OAuth sign-in page: ask the backend who is asking before the login (public preview, no account data).
 * A broken request shows up here, before the user signs in for nothing.
 */
import { useEffect, useState } from "react";
import { readJson } from "@/lib/api";

export interface OAuthPreview {
    client: { client_id: string; client_name: string; client_uri?: string | null };
    redirect_host: string;
    scopes: { name: string; description: string }[];
    /** 取消 = 帶 error=access_denied 導回客戶端。/ Cancel = back to the client with error=access_denied. */
    cancel_to: string;
}

export interface OAuthPreviewError {
    error: string;
    error_description?: string;
    redirect_to?: string;
}

/** query = 授權請求的查詢字串；null = 不是 OAuth 流程。/ query = the authorization request; null = not OAuth. */
export function useOAuthPreview(query: string | null) {
    const [preview, setPreview] = useState<OAuthPreview | null>(null);
    const [error, setError] = useState<OAuthPreviewError | null>(null);
    const [loading, setLoading] = useState(query !== null);

    useEffect(() => {
        if (query === null) return;
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                // 公開端點：不帶登入，也不走 apiFetch 的 401 處理。/ Public: no token, no 401 handling.
                const base = process.env.NEXT_PUBLIC_API_BASE || "";
                const res = await fetch(`${base}/api/oauth/authorize/preview?${query}`);
                const data = await readJson<OAuthPreview & OAuthPreviewError>(res);
                if (cancelled) return;
                if (res.ok && data && "client" in data) {
                    setPreview(data);
                    setError(null);
                } else if (res.status === 400 && data?.error) {
                    setError({ error: data.error, error_description: data.error_description, redirect_to: data.redirect_to });
                }
                // 其他狀況（網路、舊後端 404）：照常讓人登入，只是不知道 app 名稱。/ Otherwise sign in without the name.
            } catch {
                /* 同上 / as above */
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [query]);

    return { preview, error, loading };
}
