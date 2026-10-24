"use client";

/**
 * 「確認是你本人」對話框：敏感操作（新增 / 移除登入方式、重產復原碼、核可 MCP app）前的再驗證。
 * 可用 passkey、驗證器 App 的 6 位數碼或一組復原碼；回傳證明給呼叫端放進 API 的 `reauth`。
 * "Confirm it's you" dialog for sensitive actions: a passkey, an authenticator code or a recovery code.
 */
import React, { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { getPasskey, isPasskeyCancel, passkeySupported } from "@/lib/webauthn";
import { mfaErrorMessage, type MfaMethod, type MfaProof } from "@/lib/mfa";

export function ReauthDialog({ methods, onDone, description }: { methods: MfaMethod[]; onDone: (proof: MfaProof | null) => void; description?: string }) {
    const { t } = useI18n();
    const canPasskey = methods.includes("passkey") && passkeySupported();
    const codeMethods = methods.filter((m): m is "totp" | "recovery_code" => m === "totp" || m === "recovery_code");
    const [codeMethod, setCodeMethod] = useState<"totp" | "recovery_code">(codeMethods[0] ?? "recovery_code");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const usePasskey = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await apiFetch("/api/auth/mfa/reauth/options", { method: "POST", body: "{}" });
            const data = await readJson<{ challenge_id: string; publicKey: Record<string, unknown> }>(res);
            if (!res.ok || !data) {
                setError(mfaErrorMessage(t, data, t("security.errPasskeyFailed")));
                return;
            }
            const credential = await getPasskey(data.publicKey);
            onDone({ method: "passkey", challenge_id: data.challenge_id, credential });
        } catch (e) {
            setError(isPasskeyCancel(e) ? t("security.errCancelled") : t("security.errPasskeyFailed"));
        } finally {
            setBusy(false);
        }
    };

    const submitCode = (e: React.FormEvent) => {
        e.preventDefault();
        if (code.trim()) onDone({ method: codeMethod, code: code.trim() });
    };

    return (
        <Modal
            isOpen
            onClose={() => onDone(null)}
            title={t("security.reauthTitle")}
            description={description ?? t("security.reauthDescription")}
            icon={<ShieldCheck />}
            size="md"
            footer={
                <Button type="button" variant="outline" onClick={() => onDone(null)}>
                    {t("common.cancel")}
                </Button>
            }
        >
            <div className="space-y-4">
                {canPasskey && (
                    <Button type="button" className="w-full" disabled={busy} onClick={usePasskey}>
                        <KeyRound />
                        {t("security.reauthUsePasskey")}
                    </Button>
                )}
                {codeMethods.length > 0 && (
                    <form onSubmit={submitCode} className="space-y-2.5">
                        {codeMethods.length > 1 && (
                            <Segmented
                                fullWidth
                                size="sm"
                                options={codeMethods.map((m) => ({ value: m, label: m === "totp" ? t("security.reauthTotp") : t("security.reauthRecovery") }))}
                                value={codeMethod}
                                onChange={(m) => {
                                    setCodeMethod(m);
                                    setCode("");
                                }}
                            />
                        )}
                        <div className="flex gap-2">
                            <Input
                                autoFocus={!canPasskey}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                inputMode={codeMethod === "totp" ? "numeric" : "text"}
                                autoComplete="one-time-code"
                                placeholder={codeMethod === "totp" ? "123456" : "xxxx-xxxx-xxxx"}
                                className="font-mono tracking-wider"
                            />
                            <Button type="submit" variant="outline" disabled={busy || !code.trim()}>
                                {t("security.reauthConfirm")}
                            </Button>
                        </div>
                    </form>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
        </Modal>
    );
}
