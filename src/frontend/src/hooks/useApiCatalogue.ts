/**
 * token 能打的端點目錄（`GET /api/auth/tokens/routes`：從伺服器的白名單與 OpenAPI 產生），加上基底網址。
 * The catalogue of endpoints a token can call (built by the server from its allow-list and the OpenAPI document),
 * plus the base URL.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { RouteCatalogue } from "@/lib/apiCatalogue";

export function useApiCatalogue() {
    const [data, setData] = useState<RouteCatalogue | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/auth/tokens/routes");
                if (!res.ok) throw new Error(String(res.status));
                const body = (await res.json()) as RouteCatalogue;
                if (!cancelled) setData(body);
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    // 後端給 PUBLIC_URL 或這個請求的來源；沒有就用頁面的 origin。/ PUBLIC_URL or the request's origin; else the page's.
    const baseUrl = data?.base_url || (typeof window !== "undefined" ? window.location.origin : "");
    return { catalogue: data, failed, baseUrl };
}
