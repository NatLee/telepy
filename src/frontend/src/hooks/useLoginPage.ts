/**
 * 登入頁邏輯：表單狀態、setup 檢查、Google 回調、帳密登入與導向。
 * Login page logic: form state, setup check, Google callback, credentials login and redirect.
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";

/**
 * 登入後要回去的路徑（?next=）：只接受站內路徑，避免 open redirect。OAuth 同意頁沒登入時會帶著自己的 URL 過來。
 * Where to go after login (?next=): same-origin paths only (no open redirect); the OAuth consent page uses it.
 */
export function safeNextPath(): string {
    if (typeof window === "undefined") return "/tunnels";
    const next = new URLSearchParams(window.location.search).get("next") ?? "";
    return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/tunnels";
}

export function useLoginPage() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();
    const router = useRouter();

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    // 已登入則導向 tunnels；若為首次設定則導向 first-login。
    // Redirect to tunnels when authenticated; to first-login when first-time setup.
    useEffect(() => {
        if (isAuthenticated) {
            router.replace(safeNextPath());
            return;
        }
        const base = process.env.NEXT_PUBLIC_API_BASE || "";
        fetch(`${base}/api/auth/setup-status`)
            .then((res) => readJson<{ first_time_setup?: boolean }>(res))
            .then((data) => {
                if (data?.first_time_setup === true) {
                    router.replace("/first-login");
                }
            })
            .catch(() => {});
    }, [isAuthenticated, router]);

    // 掛載 Google 登入回調到 window，供 GSI 呼叫。
    // Expose Google Sign-In callback on window for GSI to call.
    useEffect(() => {
        (window as unknown as { getTokenUsingGoogleCredential?: (response: { credential: string }) => Promise<void> }).getTokenUsingGoogleCredential = async (response: { credential: string }) => {
            try {
                const res = await apiFetch("/api/auth/google/token", {
                    method: "POST",
                    body: JSON.stringify({ credential: response.credential }),
                });
                const data = await readJson<{ access_token?: string; refresh_token?: string }>(res);
                if (res.ok && data?.access_token) {
                    login(data.access_token, data.refresh_token!);
                    showSuccess(t("login.googleSuccess"));
                    router.push(safeNextPath());
                } else {
                    showError(responseError(res, data, t("login.googleFailed")));
                }
            } catch (err: unknown) {
                showError(err instanceof Error ? err.message : t("login.googleFailed"));
            }
        };
    }, [login, router, showError, showSuccess, t]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const res = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const data = await readJson<{ access_token?: string; refresh_token?: string }>(res);
            if (res.ok && data?.access_token) {
                login(data.access_token, data.refresh_token!);
                showSuccess(t("login.success"));
                router.push(safeNextPath());
            } else {
                showError(responseError(res, data, t("login.failed")));
            }
        } catch (err: unknown) {
            showError(err instanceof Error ? err.message : t("login.failed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        state: { username, setUsername, password, setPassword, isSubmitting, googleClientId },
        actions: { handleSubmit },
    };
}
