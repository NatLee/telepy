/**
 * 登入頁邏輯：表單狀態、setup 檢查、Google 回調、帳密登入、兩步驟驗證的第二步、passkey 登入（按鈕與自動填入）與導向。
 * Login page logic: form state, setup check, Google callback, credentials login, the two-factor step,
 * passkey sign-in (button and autofill) and redirect.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useGoogleClientId } from "@/hooks/useSignInLook";
import { useRouter } from "next/navigation";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { mfaErrorMessage, type MfaMethod } from "@/lib/mfa";
import { loginErrorMessage } from "@/lib/loginErrors";
import { isSafePath } from "@/lib/oauthFlow";
import { conditionalMediationAvailable, getPasskey, isPasskeyCancel, passkeySupported } from "@/lib/webauthn";

/**
 * 登入後要回去的路徑（?next=）：只接受站內路徑，避免 open redirect。OAuth 同意頁沒登入時會經 /oauth/login 帶著自己的 URL 過來。
 * Where to go after login (?next=): same-origin paths only (no open redirect); the OAuth consent page uses it via /oauth/login.
 */
export function safeNextPath(): string {
    if (typeof window === "undefined") return "/tunnels";
    const next = new URLSearchParams(window.location.search).get("next");
    return isSafePath(next) ? next : "/tunnels";
}

interface LoginResult {
    access_token?: string;
    refresh_token?: string;
    mfa_required?: boolean;
    mfa_token?: string;
    methods?: MfaMethod[];
    code?: string;
}

interface PasskeyOptions {
    challenge_id: string;
    publicKey: Record<string, unknown>;
}

/**
 * 自動填入的挑戰多久換一張。後端儀式只活 5 分鐘（`mfa::passkey::CEREMONY_TTL`），而掛著等使用者的 conditional
 * 請求可能停好幾個小時；不換的話使用者久一點才點 passkey，簽的就是一張過期的挑戰，後端回 passkey_failed。
 * How often the autofill challenge is renewed: the backend ceremony lives 5 minutes, the pending request may wait hours.
 */
const AUTOFILL_RENEW_MS = 4 * 60 * 1000;

export function useLoginPage() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    /** 第一關通過、等待第二步。/ First factor passed, waiting for the second. */
    const [mfa, setMfa] = useState<{ token: string; methods: MfaMethod[] } | null>(null);
    const [mfaMethod, setMfaMethod] = useState<"totp" | "recovery_code">("totp");
    const [mfaCode, setMfaCode] = useState("");
    /** 伺服器能用 passkey（網域 + https 或 localhost）且瀏覽器支援。/ Passkeys usable on this server and browser. */
    const [passkeyAvailable, setPasskeyAvailable] = useState(false);
    const conditional = useRef<AbortController | null>(null);
    const { login, isAuthenticated } = useAuth();
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();
    const router = useRouter();

    // 執行時從公開端點拿（.env > 網站設定）。/ Read at runtime from the public endpoint (.env > site setting).
    const googleClientId = useGoogleClientId();

    const stopAutofill = useCallback(() => {
        conditional.current?.abort();
        conditional.current = null;
    }, []);

    const finish = useCallback(
        (data: LoginResult, successKey: TranslationKey) => {
            stopAutofill();
            login(data.access_token!, data.refresh_token!);
            showSuccess(t(successKey));
            router.push(safeNextPath());
        },
        [login, router, showSuccess, stopAutofill, t]
    );

    /** 帳密 / Google 的回應：token → 登入；mfa_required → 進第二步；其他 → 錯誤。 */
    const handleFirstFactor = useCallback(
        (res: Response, data: LoginResult | null, successKey: TranslationKey, failKey: TranslationKey) => {
            if (res.ok && data?.access_token) {
                finish(data, successKey);
            } else if (res.ok && data?.mfa_required && data.mfa_token) {
                stopAutofill();
                const methods = data.methods ?? [];
                setMfa({ token: data.mfa_token, methods });
                setMfaMethod(methods.includes("totp") ? "totp" : "recovery_code");
                setMfaCode("");
            } else {
                showError(loginErrorMessage(t, data) ?? responseError(res, data, t(failKey)));
            }
        },
        [finish, showError, stopAutofill, t]
    );

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

    const finishPasskeyLogin = useCallback(
        async (challengeId: string, credential: unknown) => {
            const res = await apiFetch("/api/auth/passkey/login", { method: "POST", body: JSON.stringify({ challenge_id: challengeId, credential }) });
            const data = await readJson<LoginResult>(res);
            if (res.ok && data?.access_token) finish(data, "login.success");
            else showError(mfaErrorMessage(t, data, t("login.passkeyFailed")));
        },
        [finish, showError, t]
    );

    // passkey 可用性 + 帳號欄位的自動填入（conditional mediation）。伺服器在 IP 位址上不提供 passkey → 隱藏按鈕。
    // Passkey availability plus autofill in the username field; hidden when the server cannot offer passkeys.
    useEffect(() => {
        if (isAuthenticated || !passkeySupported()) return;
        let cancelled = false;
        const fetchOptions = async (): Promise<PasskeyOptions | null> => {
            const res = await apiFetch("/api/auth/passkey/options", { method: "POST", body: "{}" });
            const opts = await readJson<PasskeyOptions>(res);
            return res.ok && opts ? opts : null;
        };
        (async () => {
            try {
                let opts = await fetchOptions();
                if (cancelled || !opts) return;
                setPasskeyAvailable(true);
                if (!(await conditionalMediationAvailable()) || cancelled) return;
                // 掛一張挑戰等自動填入；到期前中止、換一張新的再掛回去，使用者看不出差別。
                // Arm the autofill request; before the challenge expires, abort and re-arm with a fresh one.
                while (!cancelled && opts) {
                    const ctrl = new AbortController();
                    conditional.current = ctrl;
                    let renewing = false;
                    const renew = setTimeout(() => {
                        renewing = true;
                        ctrl.abort();
                    }, AUTOFILL_RENEW_MS);
                    try {
                        const credential = await getPasskey(opts.publicKey, { mediation: "conditional", signal: ctrl.signal });
                        if (!cancelled) await finishPasskeyLogin(opts.challenge_id, credential);
                        return;
                    } catch (err) {
                        // 使用者取消或我們自己停掉（stopAutofill）：安靜結束。/ Dismissed or stopped on purpose: stay quiet.
                        if (cancelled || !renewing) throw err;
                    } finally {
                        clearTimeout(renew);
                    }
                    opts = await fetchOptions();
                }
            } catch {
                /* 自動填入被取消 / 中止：不打擾使用者。/ Autofill dismissed or aborted: stay quiet. */
            }
        })();
        return () => {
            cancelled = true;
            stopAutofill();
        };
    }, [isAuthenticated, finishPasskeyLogin, stopAutofill]);

    // 掛載 Google 登入回調到 window，供 GSI 呼叫。
    // Expose Google Sign-In callback on window for GSI to call.
    useEffect(() => {
        (window as unknown as { getTokenUsingGoogleCredential?: (response: { credential: string }) => Promise<void> }).getTokenUsingGoogleCredential = async (response: { credential: string }) => {
            try {
                const res = await apiFetch("/api/auth/google/token", {
                    method: "POST",
                    body: JSON.stringify({ credential: response.credential }),
                });
                handleFirstFactor(res, await readJson<LoginResult>(res), "login.googleSuccess", "login.googleFailed");
            } catch (err: unknown) {
                showError(err instanceof Error ? err.message : t("login.googleFailed"));
            }
        };
    }, [handleFirstFactor, showError, t]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const res = await apiFetch("/api/auth/token", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            handleFirstFactor(res, await readJson<LoginResult>(res), "login.success", "login.failed");
        } catch (err: unknown) {
            showError(err instanceof Error ? err.message : t("login.failed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    /** 免帳號：用 passkey 直接登入（按鈕，跳出瀏覽器視窗）。/ Passwordless sign-in from the button. */
    const signInWithPasskey = async () => {
        stopAutofill();
        setIsSubmitting(true);
        try {
            const res = await apiFetch("/api/auth/passkey/options", { method: "POST", body: "{}" });
            const opts = await readJson<PasskeyOptions>(res);
            if (!res.ok || !opts) {
                showError(mfaErrorMessage(t, opts, t("login.passkeyFailed")));
                return;
            }
            const credential = await getPasskey(opts.publicKey);
            await finishPasskeyLogin(opts.challenge_id, credential);
        } catch (err) {
            showError(isPasskeyCancel(err) ? t("security.errCancelled") : t("login.passkeyFailed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    const verifySecondFactor = async (body: Record<string, unknown>) => {
        if (!mfa) return;
        const res = await apiFetch("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ mfa_token: mfa.token, ...body }) });
        const data = await readJson<LoginResult>(res);
        if (res.ok && data?.access_token) {
            finish(data, "login.success");
            return;
        }
        showError(mfaErrorMessage(t, data, t("login.failed")));
        if (data?.code === "mfa_expired") setMfa(null);
    };

    const submitMfaCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            await verifySecondFactor({ method: mfaMethod, code: mfaCode.trim() });
            setMfaCode("");
        } finally {
            setIsSubmitting(false);
        }
    };

    const verifyWithPasskey = async () => {
        if (!mfa) return;
        setIsSubmitting(true);
        try {
            const res = await apiFetch("/api/auth/mfa/passkey/options", { method: "POST", body: JSON.stringify({ mfa_token: mfa.token }) });
            const opts = await readJson<PasskeyOptions & { code?: string }>(res);
            if (!res.ok || !opts) {
                showError(mfaErrorMessage(t, opts, t("login.passkeyFailed")));
                if (opts?.code === "mfa_expired") setMfa(null);
                return;
            }
            const credential = await getPasskey(opts.publicKey);
            await verifySecondFactor({ method: "passkey", challenge_id: opts.challenge_id, credential });
        } catch (err) {
            showError(isPasskeyCancel(err) ? t("security.errCancelled") : t("login.passkeyFailed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        state: { username, setUsername, password, setPassword, isSubmitting, googleClientId, passkeyAvailable, mfa, mfaMethod, setMfaMethod, mfaCode, setMfaCode },
        actions: { handleSubmit, signInWithPasskey, submitMfaCode, verifyWithPasskey, cancelMfa: () => setMfa(null) },
    };
}
