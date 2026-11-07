/**
 * 網站設定 → 登入 → 單一登入：身分提供者清單、新增 / 修改 / 刪除、discovery 檢查與試登入（`/api/site/oidc*`）。
 * Site settings → Sign-in → single sign-on: the providers, create / change / delete, the discovery check and the
 * test sign-in (`/api/site/oidc*`).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { rememberSsoButtons } from "@/hooks/useSignInLook";
import { useI18n } from "@/lib/i18n";
import type { GroupRule } from "@/lib/sso";
import { useToast } from "@/components/ui/Toast";

export interface OidcProvider {
    id: number;
    slug: string;
    name: string;
    issuer: string;
    client_id: string;
    has_secret: boolean;
    scopes: string;
    username_from: "email" | "preferred_username";
    allowed_domains: string[];
    create_users: boolean;
    link_by_email: boolean;
    enabled: boolean;
    created_at: string;
    updated_at: string;
    callback_url: string;
    links: number;
    groups_claim: string;
    required_groups: string[];
    group_rules: GroupRule[];
}

export interface OidcList {
    providers: OidcProvider[];
    callback_base: string;
    public_url_set: boolean;
    /** 規則可以指向的使用者群組。/ The user groups rules may point at. */
    user_groups?: { id: number; name: string }[];
}

export interface Discovery {
    ok: boolean;
    issuer: string | string[];
    authorization_endpoint?: string;
    token_endpoint?: string;
    jwks_uri?: string;
    end_session_endpoint?: string | null;
    keys?: number;
    pkce?: "S256" | "unlisted";
    error?: string | null;
}

/** 表單送出的欄位；`client_secret` 沒給 = 不動，空字串 = 拿掉。/ The form's fields; omitted secret = keep, "" = remove. */
export interface ProviderDraft {
    name: string;
    slug: string;
    issuer: string;
    client_id: string;
    client_secret?: string;
    scopes: string;
    username_from: "email" | "preferred_username";
    allowed_domains: string[];
    create_users: boolean;
    link_by_email: boolean;
    enabled: boolean;
    groups_claim: string;
    required_groups: string[];
    group_rules: GroupRule[];
}

/** 欄位錯誤（`{field: [msg]}`）。/ Field errors. */
export type FieldErrors = Partial<Record<keyof ProviderDraft, string>>;

function fieldErrors(data: unknown): FieldErrors | null {
    if (!data || typeof data !== "object") return null;
    const out: FieldErrors = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(v) && typeof v[0] === "string") out[k as keyof ProviderDraft] = v[0];
    }
    return Object.keys(out).length ? out : null;
}

export function useOidcProviders() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [list, setList] = useState<OidcList | null>(null);
    const [failed, setFailed] = useState(false);

    const apply = useCallback((data: OidcList) => {
        setList(data);
        // 登入頁的按鈕跟著換（這個瀏覽器登出後馬上看得到）。/ Keep this browser's sign-in buttons in step.
        rememberSsoButtons(data.providers.filter((p) => p.enabled).map((p) => ({ slug: p.slug, name: p.name })));
    }, []);

    // 打開時讀一次（promise 串起來，不在 effect 裡直接 setState）。/ Read once on mount (a promise chain).
    useEffect(() => {
        let alive = true;
        apiFetch("/api/site/oidc")
            .then(async (res) => (res.ok ? await readJson<OidcList>(res) : null))
            .then((data) => {
                if (!alive) return;
                if (data) setList(data);
                setFailed(!data);
            })
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, []);

    /** 存檔：成功回 null，欄位錯誤回那些錯誤。/ Save: null on success, else the field errors. */
    const save = useCallback(
        async (id: number | null, draft: ProviderDraft): Promise<FieldErrors | null> => {
            const res = await apiFetch(id ? `/api/site/oidc/${id}` : "/api/site/oidc", { method: id ? "PATCH" : "POST", body: JSON.stringify(draft) });
            const data = await readJson<OidcList>(res);
            if (res.ok && data) {
                apply(data);
                showSuccess(t(id ? "sso.admin.saved" : "sso.admin.added", { name: draft.name }));
                return null;
            }
            const errors = fieldErrors(data);
            if (errors) return errors;
            showError(responseError(res, data, t("sso.admin.saveFailed")));
            return {};
        },
        [apply, showError, showSuccess, t]
    );

    const toggle = useCallback(
        async (p: OidcProvider, enabled: boolean) => {
            const res = await apiFetch(`/api/site/oidc/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
            const data = await readJson<OidcList>(res);
            if (res.ok && data) apply(data);
            else showError(responseError(res, data, t("sso.admin.saveFailed")));
        },
        [apply, showError, t]
    );

    const remove = useCallback(
        async (p: OidcProvider) => {
            const res = await apiFetch(`/api/site/oidc/${p.id}`, { method: "DELETE" });
            const data = await readJson<OidcList>(res);
            if (res.ok && data) {
                apply(data);
                showSuccess(t("sso.admin.removed", { name: p.name }));
            } else showError(responseError(res, data, t("sso.admin.saveFailed")));
        },
        [apply, showError, showSuccess, t]
    );

    const discover = useCallback(async (issuer: string): Promise<Discovery | { fieldError: string }> => {
        const res = await apiFetch("/api/site/oidc/discover", { method: "POST", body: JSON.stringify({ issuer }) });
        const data = await readJson<Discovery & { issuer?: string | string[] }>(res);
        if (res.ok && data) return data;
        const err = Array.isArray(data?.issuer) ? data.issuer[0] : responseError(res, data, t("sso.admin.checkFailed"));
        return { fieldError: err };
    }, [t]);

    /** 試登入：整頁到身分提供者，回來是 `/tunnels/sso?test=…`。/ A test sign-in: leave for the provider. */
    const test = useCallback(
        async (p: OidcProvider) => {
            const res = await apiFetch(`/api/site/oidc/${p.id}/test`, { method: "POST", body: "{}" });
            const data = await readJson<{ url?: string }>(res);
            if (res.ok && data?.url) window.location.assign(data.url);
            else showError(responseError(res, data, t("sso.admin.testFailed")));
        },
        [showError, t]
    );

    return { list, failed, save, toggle, remove, discover, test };
}
