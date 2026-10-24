"use client";

/**
 * 敏感隧道的 step-up 流程（掛在 AppLayout）：向 `/api/auth/step-up` 要 token；需要證明就開「確認是你」對話框；帳號還沒有
 * 第二因素就先開設定（沿用 SecuritySettings），設好按「繼續」再確認一次。成功的 token 存進這個分頁（lib/stepUp）。
 * The step-up flow for sensitive tunnels (mounted in AppLayout): ask `/api/auth/step-up` for a token, open the
 * "confirm it's you" dialog when a proof is needed, or the security settings first when the account has no second
 * factor yet. The token is kept in this tab (lib/stepUp).
 */
import React, { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SecuritySettings } from "@/components/layout/SecuritySettings";
import { useReauth } from "@/hooks/useReauth";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, type MfaMethod } from "@/lib/mfa";
import { requestStepUp, saveStepUp, setStepUpHandler } from "@/lib/stepUp";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";

type Answer = { token?: string; until?: string; code?: string; methods?: MfaMethod[]; error?: string };

export function StepUpProvider() {
    const { t } = useI18n();
    const { showSuccess, showError, showToast } = useToast();
    const { request, dialog } = useReauth();
    const [enroll, setEnroll] = useState<((proceed: boolean) => void) | null>(null);
    // 處理函式要讀到最新的 t / request，但只註冊一次。/ Register once while always using the latest t / request.
    const latest = useRef({ t, request, showSuccess, showError, showToast });
    useEffect(() => {
        latest.current = { t, request, showSuccess, showError, showToast };
    });

    useEffect(() => {
        const post = async (body: object) => {
            const res = await apiFetch("/api/auth/step-up", { method: "POST", body: JSON.stringify(body) });
            return { ok: res.ok, data: (await readJson<Answer>(res)) ?? {} };
        };
        const run = async (): Promise<boolean> => {
            const { t, request, showSuccess, showError } = latest.current;
            let first = await post({});
            // 還沒有第二因素：先設定，按「繼續」再來一次。/ No second factor yet: set one up, then try again.
            while (!first.ok && first.data.code === "step_up_enroll") {
                const proceed = await new Promise<boolean>((resolve) => setEnroll(() => resolve));
                setEnroll(null);
                if (!proceed) return false;
                first = await post({});
            }
            let answer = first;
            if (!answer.ok && answer.data.code === "reauth_required") {
                const proof = await request(answer.data.methods ?? [], t("stepUp.reauthDescription"));
                if (!proof) return false;
                answer = await post({ reauth: proof });
            }
            if (answer.ok && answer.data.token && answer.data.until) {
                saveStepUp({ token: answer.data.token, until: answer.data.until });
                showSuccess(t("stepUp.confirmed"));
                return true;
            }
            showError(mfaErrorMessage(t, answer.data, t("stepUp.failed")));
            return false;
        };
        setStepUpHandler(run);
        return () => setStepUpHandler(null);
    }, []);

    // 筆電的 SSH 被擋（像 Tailscale 的 check mode）：看得到的分頁直接請你確認，確認後再跑一次 ssh 就好。
    // Laptop SSH was refused (like Tailscale's check mode): the visible tab asks right away; then run ssh again.
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.STEP_UP_REQUIRED]: (msg) => {
            const { t, showToast } = latest.current;
            showToast(t("stepUp.sshBlocked", { name: String(msg.tunnel_name ?? "") }), "warning");
            if (document.visibilityState === "visible") void requestStepUp();
        },
    });

    return (
        <>
            {dialog}
            <Modal
                isOpen={enroll !== null}
                onClose={() => enroll?.(false)}
                title={t("stepUp.enrollTitle")}
                description={t("stepUp.enrollDescription")}
                icon={<ShieldCheck />}
                size="xl"
                footer={
                    <>
                        <Button variant="outline" onClick={() => enroll?.(false)}>
                            {t("common.cancel")}
                        </Button>
                        <Button onClick={() => enroll?.(true)}>{t("stepUp.enrollContinue")}</Button>
                    </>
                }
            >
                <SecuritySettings />
            </Modal>
        </>
    );
}
