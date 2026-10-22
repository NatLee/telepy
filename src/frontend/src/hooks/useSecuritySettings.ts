/**
 * 「登入安全性」邏輯（偏好設定 modal）：passkey 新增 / 改名 / 移除、驗證器 App 設定 / 關閉、復原碼重產。
 * 帳號已有任一第二因素時，這些操作先走再驗證（useReauth）；第一個因素建立時後端回傳復原碼，只顯示一次。
 * Sign-in security logic for the preferences modal; sensitive actions re-authenticate first once 2FA is on.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { mfaErrorMessage, needsReauth, type MfaMethod, type MfaProof } from "@/lib/mfa";
import { createPasskey, isPasskeyCancel } from "@/lib/webauthn";

export interface PasskeyInfo {
    id: number;
    name: string;
    created_at: string;
    last_used_at: string | null;
}

export interface MfaStatus {
    mfa_enabled: boolean;
    methods: MfaMethod[];
    totp_enabled: boolean;
    totp_enabled_at: string | null;
    passkeys: PasskeyInfo[];
    recovery_codes_remaining: number;
}

export interface TotpSetup {
    secret: string;
    otpauth_uri: string;
    qr_svg: string;
}

export function useSecuritySettings() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const { fetchUserProfile } = useAuth();
    const reauth = useReauth();
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
    /** 剛產生、要顯示一次的復原碼。/ Freshly issued recovery codes, shown once. */
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch("/api/auth/mfa");
            const data = await readJson<MfaStatus>(res);
            if (res.ok && data) {
                setStatus(data);
                setLoadFailed(false);
            } else {
                setLoadFailed(true);
            }
        } catch {
            setLoadFailed(true);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    /** 執行敏感操作：已有 2FA 先要證明；後端仍回 reauth_required（狀態剛變）就再問一次。
     *  Run a sensitive action, asking for a proof first when 2FA is on (and again if the server insists). */
    const withReauth = useCallback(
        async (action: (proof?: MfaProof) => Promise<Response>): Promise<{ res: Response; data: unknown } | null> => {
            let proof: MfaProof | undefined;
            if (status?.mfa_enabled) {
                const p = await reauth.request(status.methods);
                if (!p) return null;
                proof = p;
            }
            let res = await action(proof);
            let data: unknown = await readJson(res);
            const methods = needsReauth(res.status, data);
            if (methods && !proof) {
                const p = await reauth.request(methods);
                if (!p) return null;
                res = await action(p);
                data = await readJson(res);
            }
            return { res, data };
        },
        [reauth, status]
    );

    const finish = useCallback(
        async (ok: boolean, data: unknown, successText: string) => {
            if (!ok) {
                showError(mfaErrorMessage(t, data, t("security.failed")));
                return;
            }
            const codes = (data as { recovery_codes?: string[] | null } | null)?.recovery_codes;
            if (codes && codes.length) setRecoveryCodes(codes);
            showSuccess(successText);
            await reload();
            await fetchUserProfile();
        },
        [fetchUserProfile, reload, showError, showSuccess, t]
    );

    const addPasskey = useCallback(
        async (name: string) => {
            setBusy(true);
            try {
                const started = await withReauth((proof) =>
                    apiFetch("/api/auth/passkeys/register/options", { method: "POST", body: JSON.stringify({ reauth: proof ?? null }) })
                );
                if (!started) return;
                if (!started.res.ok) {
                    showError(mfaErrorMessage(t, started.data, t("security.failed")));
                    return;
                }
                const opts = started.data as { challenge_id: string; publicKey: Record<string, unknown> };
                const credential = await createPasskey(opts.publicKey);
                const res = await apiFetch("/api/auth/passkeys/register", {
                    method: "POST",
                    body: JSON.stringify({ challenge_id: opts.challenge_id, name: name.trim() || undefined, credential }),
                });
                const data = await readJson<{ passkey?: PasskeyInfo }>(res);
                await finish(res.ok, data, t("security.passkeyAdded", { name: data?.passkey?.name ?? name }));
            } catch (e) {
                showError(isPasskeyCancel(e) ? t("security.errCancelled") : t("security.errPasskeyFailed"));
            } finally {
                setBusy(false);
            }
        },
        [finish, showError, t, withReauth]
    );

    const renamePasskey = useCallback(
        async (id: number, name: string) => {
            const res = await apiFetch(`/api/auth/passkeys/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
            await finish(res.ok, await readJson(res), t("security.passkeyRenamed"));
        },
        [finish, t]
    );

    const removePasskey = useCallback(
        async (id: number) => {
            setBusy(true);
            try {
                const done = await withReauth((proof) => apiFetch(`/api/auth/passkeys/${id}`, { method: "DELETE", body: JSON.stringify({ reauth: proof ?? null }) }));
                if (done) await finish(done.res.ok, done.data, t("security.passkeyRemoved"));
            } finally {
                setBusy(false);
            }
        },
        [finish, t, withReauth]
    );

    const startTotp = useCallback(async () => {
        setBusy(true);
        try {
            const done = await withReauth((proof) => apiFetch("/api/auth/mfa/totp/setup", { method: "POST", body: JSON.stringify({ reauth: proof ?? null }) }));
            if (!done) return;
            if (done.res.ok) setTotpSetup(done.data as TotpSetup);
            else showError(mfaErrorMessage(t, done.data, t("security.failed")));
        } finally {
            setBusy(false);
        }
    }, [showError, t, withReauth]);

    const enableTotp = useCallback(
        async (code: string) => {
            setBusy(true);
            try {
                const res = await apiFetch("/api/auth/mfa/totp/enable", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
                const data = await readJson(res);
                if (res.ok) setTotpSetup(null);
                await finish(res.ok, data, t("security.totpEnabled"));
            } finally {
                setBusy(false);
            }
        },
        [finish, t]
    );

    const disableTotp = useCallback(async () => {
        setBusy(true);
        try {
            const done = await withReauth((proof) => apiFetch("/api/auth/mfa/totp", { method: "DELETE", body: JSON.stringify({ reauth: proof ?? null }) }));
            if (done) await finish(done.res.ok, done.data, t("security.totpDisabled"));
        } finally {
            setBusy(false);
        }
    }, [finish, t, withReauth]);

    const regenerateCodes = useCallback(async () => {
        setBusy(true);
        try {
            const done = await withReauth((proof) => apiFetch("/api/auth/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ reauth: proof ?? null }) }));
            if (done) await finish(done.res.ok, done.data, t("security.recoveryRegenerated"));
        } finally {
            setBusy(false);
        }
    }, [finish, t, withReauth]);

    return {
        state: { status, loadFailed, busy, totpSetup, recoveryCodes },
        actions: {
            addPasskey,
            renamePasskey,
            removePasskey,
            startTotp,
            enableTotp,
            cancelTotp: () => setTotpSetup(null),
            disableTotp,
            regenerateCodes,
            dismissRecoveryCodes: () => setRecoveryCodes(null),
        },
        reauthDialog: reauth.dialog,
    };
}
