/**
 * 登入頁邏輯：表單狀態、setup 檢查、Google 回調、帳密登入與導向。
 * Login page logic: form state, setup check, Google callback, credentials login and redirect.
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";

export function useLoginPage() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError } = useToast();
    const router = useRouter();

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    // 已登入則導向 tunnels；若為首次設定則導向 first-login。
    // Redirect to tunnels when authenticated; to first-login when first-time setup.
    useEffect(() => {
        if (isAuthenticated) {
            router.replace("/tunnels");
            return;
        }
        const base = process.env.NEXT_PUBLIC_API_BASE || "";
        fetch(`${base}/api/auth/setup-status`)
            .then((res) => res.json())
            .then((data) => {
                if (data.first_time_setup === true) {
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
                const data = await res.json();
                if (res.ok) {
                    login(data.access_token, data.refresh_token);
                    showSuccess("Google Login successful");
                    router.push("/tunnels");
                } else {
                    showError(data.error || data.detail || "Google Login failed");
                }
            } catch (err: unknown) {
                showError(err instanceof Error ? err.message : "Google Login failed");
            }
        };
    }, [login, router, showError, showSuccess]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const res = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();
            if (res.ok && data.access_token) {
                login(data.access_token, data.refresh_token);
                showSuccess("Login successful");
                router.push("/tunnels");
            } else {
                showError(data.detail || data.error || "Login failed");
            }
        } catch (err: unknown) {
            showError(err instanceof Error ? err.message : "Login failed");
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        state: { username, setUsername, password, setPassword, isSubmitting, googleClientId },
        actions: { handleSubmit },
    };
}
