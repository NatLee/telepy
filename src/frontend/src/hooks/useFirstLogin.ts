import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

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

    useEffect(() => {
        if (isAuthenticated) {
            router.replace("/tunnels");
        }
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

    const getPasswordStrength = () => {
        if (!password) return { text: "", color: "bg-slate-200" };
        if (password.length < 6) return { text: t("firstLogin.strengthWeak"), color: "bg-red-500" };
        if (password.length < 10) return { text: t("firstLogin.strengthModerate"), color: "bg-yellow-500" };
        return { text: t("firstLogin.strengthStrong"), color: "bg-green-500" };
    };
    const strength = getPasswordStrength();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (username === password) {
            showError(t("firstLogin.usernamePasswordSame"));
            return;
        }
        if (password !== confirmPassword) {
            showError(t("firstLogin.passwordsMismatchToast"));
            return;
        }

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
            googleClientId
        },
        actions: {
            handleSubmit
        }
    };
}
