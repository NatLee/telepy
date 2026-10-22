import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** 管理員密碼的最短長度（後端不限制，首次設定這裡把關）。/ Minimum admin password length, enforced here only. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 密碼強度 0–3（0 = 空）：長度為主，字元種類（小寫 / 大寫 / 數字 / 符號）為輔；夠長的通關密語也算強。
 * Password strength 0–3 (0 = empty): length first, character classes second; a long passphrase counts as strong.
 */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
    if (!password) return 0;
    if (password.length < MIN_PASSWORD_LENGTH) return 1;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    if (password.length >= 20 || (password.length >= 12 && classes >= 3)) return 3;
    if (password.length >= 16 || classes >= 2) return 2;
    return 1;
}

export function useFirstLogin() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();
    const router = useRouter();

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    // 已登入 → tunnels；已經有帳號（不是首次設定）→ 登入頁，這頁只給第一位管理員用。
    // Signed in → tunnels; setup already done → the sign-in page (this page is only for the first admin).
    useEffect(() => {
        if (isAuthenticated) {
            router.replace("/tunnels");
            return;
        }
        const base = process.env.NEXT_PUBLIC_API_BASE || "";
        fetch(`${base}/api/auth/setup-status`)
            .then((res) => readJson<{ first_time_setup?: boolean }>(res))
            .then((data) => {
                if (data?.first_time_setup === false) {
                    router.replace("/login");
                }
            })
            .catch(() => {});
    }, [isAuthenticated, router]);

    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).getTokenUsingGoogleCredential = async (response: any) => {
            try {
                const res = await apiFetch("/api/auth/google/token", {
                    method: "POST",
                    body: JSON.stringify({ credential: response.credential }),
                });
                const data = await readJson<{ access_token?: string; refresh_token?: string }>(res);
                if (res.ok && data?.access_token) {
                    login(data.access_token, data.refresh_token!);
                    showSuccess(t("login.googleSuccess"));
                    router.push("/tunnels");
                } else {
                    showError(responseError(res, data, t("login.googleFailed")));
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
                showError(err.message || t("login.googleFailed"));
            }
        };
    }, [login, router, showError, showSuccess, t]);

    const strength = passwordStrength(password);
    const rules = {
        length: password.length >= MIN_PASSWORD_LENGTH,
        notUsername: password.length > 0 && password !== username.trim(),
    };
    const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
    const canSubmit = !isSubmitting && username.trim().length > 0 && rules.length && rules.notUsername && passwordsMatch;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password === username.trim()) {
            showError(t("firstLogin.usernamePasswordSame"));
            return;
        }
        if (password !== confirmPassword) {
            showError(t("firstLogin.passwordsMismatchToast"));
            return;
        }
        if (!rules.length) return;

        setIsSubmitting(true);
        try {
            // 1. Register User
            const regRes = await apiFetch("/api/auth/register", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const regData = await readJson<{ status?: string }>(regRes);

            if (!regRes.ok || regData?.status !== "success") {
                showError(responseError(regRes, regData, t("firstLogin.registrationFailed")));
                setIsSubmitting(false);
                return;
            }

            showSuccess(t("firstLogin.adminCreated"));

            // 2. Login newly created user
            const loginRes = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const loginData = await readJson<{ access_token?: string; refresh_token?: string }>(loginRes);

            if (loginRes.ok && loginData?.access_token) {
                login(loginData.access_token, loginData.refresh_token!);
                router.push("/tunnels");
            } else {
                showError(t("firstLogin.autoLoginFailed"));
                router.push("/login");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            showError(err.message || t("firstLogin.operationFailed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        state: {
            username, setUsername,
            password, setPassword,
            confirmPassword, setConfirmPassword,
            isSubmitting,
            strength,
            rules,
            passwordsMatch,
            canSubmit,
            googleClientId
        },
        actions: {
            handleSubmit
        }
    };
}
