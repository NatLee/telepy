"use client";

/**
 * 偏好設定裡的「登入安全性」：passkey、驗證器 App（TOTP）、復原碼。邏輯在 hooks/useSecuritySettings.ts。
 * Sign-in security section of the preferences modal: passkeys, authenticator app, recovery codes.
 */
import React, { useState } from "react";
import { Check, KeyRound, Pencil, ShieldCheck, ShieldOff, Smartphone, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RecoveryCodesDialog } from "@/components/auth/RecoveryCodesDialog";
import { SectionHeading } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { passkeySupported } from "@/lib/webauthn";
import { useSecuritySettings, type PasskeyInfo } from "@/hooks/useSecuritySettings";

type Pending = { kind: "removePasskey"; passkey: PasskeyInfo } | { kind: "disableTotp" } | { kind: "regenerate" } | null;

export function SecuritySettings() {
    const { t, locale } = useI18n();
    const { showSuccess } = useToast();
    const { state, actions, reauthDialog } = useSecuritySettings();
    const { status, loadFailed, busy, totpSetup, recoveryCodes } = state;
    const [newName, setNewName] = useState("");
    const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
    const [totpCode, setTotpCode] = useState("");
    const [pending, setPending] = useState<Pending>(null);
    const supported = passkeySupported();

    const fmt = (iso: string | null) => {
        if (!iso) return t("security.never");
        const d = new Date(iso);
        return isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };

    const confirmPending = async () => {
        const p = pending;
        setPending(null);
        if (!p) return;
        if (p.kind === "removePasskey") await actions.removePasskey(p.passkey.id);
        if (p.kind === "disableTotp") await actions.disableTotp();
        if (p.kind === "regenerate") await actions.regenerateCodes();
    };

    const copySecret = async (secret: string) => {
        try {
            await navigator.clipboard.writeText(secret);
            showSuccess(t("common.copied"));
        } catch {
            /* clipboard blocked */
        }
    };

    const subheading = "text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5";

    return (
        <section className="space-y-3">
            <SectionHeading icon={<ShieldCheck />} title={t("security.title")} description={t("security.description")} />

            {loadFailed ? (
                <p className="text-sm text-destructive">{t("security.loadFailed")}</p>
            ) : !status ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : (
                <div className="divide-y divide-border/70 rounded-xl text-sm ring-1 ring-inset ring-border/80">
                    <div className={`flex items-center gap-2 rounded-t-xl bg-surface px-4 py-2.5 ${status.mfa_enabled ? "text-success" : "text-muted-foreground"}`}>
                        {status.mfa_enabled ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
                        {status.mfa_enabled ? t("security.statusOn") : t("security.statusOff")}
                    </div>

                    {/* Passkeys */}
                    <div className="px-4 py-3 space-y-2">
                        <p className={subheading}>
                            <KeyRound size={13} /> {t("security.passkeys")}
                        </p>
                        {status.passkeys.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t("security.noPasskeys")}</p>
                        ) : (
                            <ul className="space-y-1.5">
                                {status.passkeys.map((p) => (
                                    <li key={p.id} className="flex items-center gap-2">
                                        {editing?.id === p.id ? (
                                            <form
                                                className="flex-1 flex gap-1.5"
                                                onSubmit={async (e) => {
                                                    e.preventDefault();
                                                    if (!editing.name.trim()) return;
                                                    await actions.renamePasskey(p.id, editing.name.trim());
                                                    setEditing(null);
                                                }}
                                            >
                                                <Input autoFocus value={editing.name} maxLength={100} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} className="h-8" />
                                                <Button type="submit" size="sm" variant="outline" aria-label={t("common.save")}>
                                                    <Check size={14} />
                                                </Button>
                                                <Button type="button" size="sm" variant="ghost" aria-label={t("common.cancel")} onClick={() => setEditing(null)}>
                                                    <X size={14} />
                                                </Button>
                                            </form>
                                        ) : (
                                            <>
                                                <div className="flex-1 min-w-0">
                                                    <p className="truncate text-foreground">{p.name}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {t("security.passkeyCreated", { time: fmt(p.created_at) })} · {t("security.passkeyLastUsed", { time: fmt(p.last_used_at) })}
                                                    </p>
                                                </div>
                                                <button type="button" className="text-muted-foreground hover:text-foreground p-1" aria-label={t("common.edit")} onClick={() => setEditing({ id: p.id, name: p.name })}>
                                                    <Pencil size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="text-destructive hover:underline inline-flex items-center gap-1 text-xs"
                                                    disabled={busy}
                                                    onClick={() => setPending({ kind: "removePasskey", passkey: p })}
                                                >
                                                    <Trash2 size={13} /> {t("common.remove")}
                                                </button>
                                            </>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {supported ? (
                            <form
                                className="flex gap-2 pt-1"
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    await actions.addPasskey(newName);
                                    setNewName("");
                                }}
                            >
                                <Input value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} placeholder={t("security.passkeyNamePlaceholder")} className="h-9" />
                                <Button type="submit" size="sm" disabled={busy} className="shrink-0">
                                    <KeyRound size={14} className="mr-1.5" />
                                    {t("security.addPasskey")}
                                </Button>
                            </form>
                        ) : (
                            <p className="text-xs text-muted-foreground">{t("security.passkeysUnsupported")}</p>
                        )}
                    </div>

                    {/* Authenticator app (TOTP) */}
                    <div className="px-4 py-3 space-y-2">
                        <p className={subheading}>
                            <Smartphone size={13} /> {t("security.totp")}
                        </p>
                        {status.totp_enabled ? (
                            <div className="flex items-center gap-2">
                                <p className="flex-1 text-xs text-muted-foreground">{t("security.totpOn", { time: fmt(status.totp_enabled_at) })}</p>
                                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPending({ kind: "disableTotp" })}>
                                    {t("security.totpDisable")}
                                </Button>
                            </div>
                        ) : totpSetup ? (
                            <div className="space-y-3">
                                <p className="text-xs text-muted-foreground">{t("security.totpScan")}</p>
                                <div className="flex flex-col sm:flex-row gap-3 items-center">
                                    {/* 後端產生的 SVG 當成圖片載入（不插入 DOM，不會執行任何東西）。/ Rendered as an image, never injected. */}
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(totpSetup.qr_svg)}`}
                                        alt="QR code"
                                        width={168}
                                        height={168}
                                        className="rounded-md border border-border bg-white"
                                    />
                                    <div className="flex-1 min-w-0 space-y-1">
                                        <p className="text-xs text-muted-foreground">{t("security.totpKey")}</p>
                                        <button
                                            type="button"
                                            onClick={() => copySecret(totpSetup.secret)}
                                            className="w-full text-left font-mono text-xs break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 hover:bg-muted"
                                            title={t("common.copy")}
                                        >
                                            {totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}
                                        </button>
                                    </div>
                                </div>
                                <form
                                    className="flex gap-2"
                                    onSubmit={async (e) => {
                                        e.preventDefault();
                                        await actions.enableTotp(totpCode);
                                        setTotpCode("");
                                    }}
                                >
                                    <Input
                                        value={totpCode}
                                        onChange={(e) => setTotpCode(e.target.value)}
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        placeholder={t("security.totpEnterCode")}
                                        className="h-9 font-mono"
                                    />
                                    <Button type="submit" size="sm" disabled={busy || totpCode.trim().length < 6} className="shrink-0">
                                        {t("security.totpVerify")}
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" onClick={actions.cancelTotp}>
                                        {t("common.cancel")}
                                    </Button>
                                </form>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <p className="flex-1 text-xs text-muted-foreground">{t("security.totpOff")}</p>
                                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={actions.startTotp}>
                                    {t("security.totpSetup")}
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* Recovery codes */}
                    {status.mfa_enabled && (
                        <div className="px-4 py-3 flex items-center gap-2">
                            <div className="flex-1">
                                <p className={subheading}>{t("security.recoveryCodes")}</p>
                                <p className="text-xs text-muted-foreground mt-1">{t("security.recoveryRemaining", { count: status.recovery_codes_remaining })}</p>
                            </div>
                            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPending({ kind: "regenerate" })}>
                                {t("security.recoveryRegenerate")}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={confirmPending}
                title={
                    pending?.kind === "removePasskey" ? t("common.remove") : pending?.kind === "disableTotp" ? t("security.totpDisable") : t("security.recoveryRegenerate")
                }
                message={
                    pending?.kind === "removePasskey"
                        ? t("security.removePasskeyConfirm", { name: pending.passkey.name })
                        : pending?.kind === "disableTotp"
                          ? t("security.totpDisableConfirm")
                          : t("security.recoveryRegenerateConfirm")
                }
                confirmText={pending?.kind === "regenerate" ? t("security.recoveryRegenerate") : t("common.confirm")}
                isDestructive={pending?.kind !== "regenerate"}
            />
            {recoveryCodes && <RecoveryCodesDialog codes={recoveryCodes} onClose={actions.dismissRecoveryCodes} />}
            {reauthDialog}
        </section>
    );
}
