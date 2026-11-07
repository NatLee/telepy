"use client";

/**
 * 偏好設定 → 安全性：把自己的帳號連到管理員設定的單一登入（OIDC）。連結 = 先「確認是你」，再整頁到身分提供者
 * 登入一次，回來就連好了（`/tunnels/sso` 說結果）；解除也要確認，最後一個登入方式不能拿掉。
 * 沒有任何身分提供者時整塊不畫。
 * Preferences → Security: link your account to the single sign-on providers an admin set up. Linking confirms it's
 * you, then signs in once at the provider (`/tunnels/sso` says how it went); unlinking confirms too, and the last way
 * in can't go. Nothing is drawn when no provider exists.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Building2, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, needsReauth, type MfaProof } from "@/lib/mfa";
import { canUnlink, type SsoLinks as Links } from "@/lib/sso";

export function SsoLinks() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const reauth = useReauth();
    const [links, setLinks] = useState<Links | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
    const [unlinking, setUnlinking] = useState<Links["providers"][number] | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/auth/oidc/links");
            const data = await readJson<Links>(res);
            if (res.ok && data) setLinks(data);
        } catch {
            /* 舊後端或連不上：整塊不畫。/ Older backend or unreachable: draw nothing. */
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /** 送出；後端要「確認是你」就問一次再送。/ Send; when the server asks for a confirmation, ask once and resend. */
    const withProof = async (send: (proof: MfaProof | null) => Promise<Response>) => {
        let res = await send(null);
        let data: unknown = await readJson(res);
        const methods = needsReauth(res.status, data);
        if (methods) {
            const proof = await reauth.request(methods, t("sso.links.reauth"));
            if (!proof) return null;
            res = await send(proof);
            data = await readJson(res);
        }
        return { res, data };
    };

    const link = async (id: number) => {
        setBusy(id);
        try {
            const done = await withProof((proof) => apiFetch(`/api/auth/oidc/links/${id}`, { method: "POST", body: JSON.stringify({ reauth: proof }) }));
            if (!done) return;
            const url = (done.data as { url?: string } | null)?.url;
            if (done.res.ok && url) {
                // 整頁離開：到身分提供者登入，回來是 /tunnels/sso。/ Leave for the provider; we come back to /tunnels/sso.
                window.location.assign(url);
                return;
            }
            showError(mfaErrorMessage(t, done.data, responseError(done.res, done.data, t("sso.links.failed"))));
        } finally {
            setBusy(null);
        }
    };

    const unlink = async (id: number) => {
        setBusy(id);
        try {
            const done = await withProof((proof) => apiFetch(`/api/auth/oidc/links/${id}`, { method: "DELETE", body: JSON.stringify({ reauth: proof }) }));
            if (!done) return;
            if (done.res.ok) {
                setLinks(done.data as Links);
                showSuccess(t("sso.links.unlinked"));
            } else if ((done.data as { code?: string } | null)?.code === "last_sign_in_method") {
                showError(t("sso.links.lastWayIn"));
            } else {
                showError(mfaErrorMessage(t, done.data, responseError(done.res, done.data, t("sso.links.failed"))));
            }
        } finally {
            setBusy(null);
        }
    };

    if (!links || links.providers.length === 0) return null;

    return (
        <section className="space-y-3">
            <SectionHeading icon={<Building2 />} title={t("sso.links.title")} description={t("sso.links.description")} />
            <ul className="divide-y divide-border/70 rounded-xl text-sm ring-1 ring-inset ring-border/80">
                {links.providers.map((p) => {
                    const lastOne = p.linked && !canUnlink(links, p.id);
                    return (
                        <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                                <Building2 size={16} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2">
                                    <span className="truncate">{p.name}</span>
                                    {p.linked ? <Chip tone="success">{t("sso.links.linked")}</Chip> : <span className="text-xs text-muted-foreground">{t("sso.links.notLinked")}</span>}
                                    {!p.enabled && <Chip>{t("sso.links.off")}</Chip>}
                                </p>
                                {lastOne && <p className="mt-0.5 text-xs text-muted-foreground">{t("sso.links.lastWayInHint")}</p>}
                            </div>
                            {p.linked ? (
                                <Button size="sm" variant="outline" disabled={busy !== null || lastOne} onClick={() => setUnlinking(p)}>
                                    <Unlink size={14} />
                                    {t("sso.links.unlink")}
                                </Button>
                            ) : (
                                <Button size="sm" variant="outline" disabled={busy !== null || !p.enabled} onClick={() => void link(p.id)}>
                                    <Link2 size={14} />
                                    {t("sso.links.link")}
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {unlinking && (
                <ConfirmDialog
                    isOpen
                    title={t("sso.links.unlinkTitle", { name: unlinking.name })}
                    message={t("sso.links.unlinkMessage", { name: unlinking.name })}
                    confirmText={t("sso.links.unlink")}
                    isDestructive
                    onConfirm={() => {
                        const id = unlinking.id;
                        setUnlinking(null);
                        void unlink(id);
                    }}
                    onClose={() => setUnlinking(null)}
                />
            )}
            {reauth.dialog}
        </section>
    );
}
