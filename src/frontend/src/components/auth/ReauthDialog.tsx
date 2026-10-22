"use client";

/**
 * 「確認是你本人」對話框：敏感操作（新增 / 移除登入方式、重產復原碼、核可 MCP app）前的再驗證。
 * 可用 passkey、驗證器 App 的 6 位數碼或一組復原碼；回傳證明給呼叫端放進 API 的 `reauth`。
 * "Confirm it's you" dialog for sensitive actions: a passkey, an authenticator code or a recovery code.
 */
import React, { useState } from "react";
import { KeyRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { getPasskey, isPasskeyCancel, passkeySupported } from "@/lib/webauthn";
import { mfaErrorMessage, type MfaMethod, type MfaProof } from "@/lib/mfa";

export function ReauthDialog({ methods, onDone }: { methods: MfaMethod[]; onDone: (proof: MfaProof | null) => void }) {
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
            size="sm"
            footer={
                <button
                    type="button"
                    onClick={() => onDone(null)}
                    className="px-4 py-2 text-sm font-medium bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors"
                >
                    {t("common.cancel")}
                </button>
            }
        >
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t("security.reauthDescription")}</p>
                {canPasskey && (
                    <Button type="button" className="w-full" disabled={busy} onClick={usePasskey}>
                        <KeyRound size={16} className="mr-2" />
                        {t("security.reauthUsePasskey")}
                    </Button>
                )}
                {codeMethods.length > 0 && (
                    <form onSubmit={submitCode} className="space-y-2">
                        {codeMethods.length > 1 && (
                            <div className="grid grid-cols-2 gap-2">
                                {codeMethods.map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        aria-pressed={codeMethod === m}
                                        onClick={() => {
                                            setCodeMethod(m);
                                            setCode("");
                                        }}
                                        className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${codeMethod === m ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                                    >
                                        {m === "totp" ? t("security.reauthTotp") : t("security.reauthRecovery")}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <Input
                                autoFocus={!canPasskey}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                inputMode={codeMethod === "totp" ? "numeric" : "text"}
                                autoComplete="one-time-code"
                                placeholder={codeMethod === "totp" ? "123456" : "xxxx-xxxx-xxxx"}
                                className="font-mono"
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
