import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { apiFetch } from "@/lib/api";

export function useFirstLogin() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError } = useToast();
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
                const data = await res.json();
                if (res.ok) {
                    login(data.access_token, data.refresh_token);
                    showSuccess("Google Login successful");
                    router.push("/tunnels");
                } else {
                    showError(data.error || data.detail || "Google Login failed");
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
                showError(err.message || "Google Login failed");
            }
        };
    }, [login, router, showError, showSuccess]);

    const getPasswordStrength = () => {
        if (!password) return { text: "", color: "bg-slate-200" };
        if (password.length < 6) return { text: "Weak", color: "bg-red-500" };
        if (password.length < 10) return { text: "Moderate", color: "bg-yellow-500" };
        return { text: "Strong", color: "bg-green-500" };
    };
    const strength = getPasswordStrength();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (username === password) {
            showError("Username and password cannot be the same.");
            return;
        }
        if (password !== confirmPassword) {
            showError("Passwords do not match.");
            return;
        }

        setIsSubmitting(true);
        try {
            // 1. Register User
            const regRes = await apiFetch("/api/auth/register", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const regData = await regRes.json();

            if (!regRes.ok || regData.status !== "success") {
                showError(regData.error || regData.detail || "Registration failed");
                setIsSubmitting(false);
                return;
            }

            showSuccess("Admin account created successfully.");

            // 2. Login newly created user
            const loginRes = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            const loginData = await loginRes.json();

            if (loginRes.ok && loginData.access_token) {
                login(loginData.access_token, loginData.refresh_token);
                router.push("/tunnels");
            } else {
                showError("Automatic login failed. Please sign in.");
                router.push("/login");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            showError(err.message || "Operation failed");
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
