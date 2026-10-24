/**
 * 隧道詳細資訊裡的「開 session 前確認是你」：owner / ADMIN 開關（關掉要再驗證），其他人只看狀態。
 * The "confirm it's you before sessions" setting in the tunnel details: owner / ADMIN switch it (turning it off
 * needs a re-authentication); everyone else sees the state.
 */
import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, needsReauth } from "@/lib/mfa";

export function StepUpSetting({ tunnelId, required, canManage, onChanged }: { tunnelId: number; required: boolean; canManage: boolean; onChanged?: () => void }) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const { request, dialog } = useReauth();
    const [value, setValue] = useState(required);
    const [busy, setBusy] = useState(false);

    const change = async (next: boolean) => {
        if (busy || next === value) return;
        setBusy(true);
        try {
            const put = (body: object) => apiFetch(`/api/reverse/server/${tunnelId}/step-up`, { method: "PUT", body: JSON.stringify(body) });
            let res = await put({ required: next });
            let data = await readJson<{ code?: string }>(res);
            const methods = needsReauth(res.status, data);
            if (methods) {
                const proof = await request(methods);
                if (!proof) return;
                res = await put({ required: next, reauth: proof });
                data = await readJson<{ code?: string }>(res);
            }
            if (res.ok) {
                setValue(next);
                showSuccess(next ? t("stepUp.turnedOn") : t("stepUp.turnedOff"));
                onChanged?.();
            } else {
                showError(data?.code === "step_up_enroll" ? t("stepUp.enrollFirst") : mfaErrorMessage(t, data, t("stepUp.changeFailed")));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section icon={<ShieldCheck />} title={t("stepUp.sectionTitle")} description={t("stepUp.sectionDescription")}>
            {canManage ? (
                <Segmented
                    size="sm"
                    aria-label={t("stepUp.sectionTitle")}
                    value={value ? "on" : "off"}
                    onChange={(v) => void change(v === "on")}
                    options={[
                        { value: "off", label: t("stepUp.off") },
                        { value: "on", label: t("stepUp.on") },
                    ]}
                />
            ) : (
                <p className="text-sm text-foreground">{value ? t("stepUp.onReadOnly") : t("stepUp.offReadOnly")}</p>
            )}
            {value && <Callout tone="info">{t("stepUp.whatHappens")}</Callout>}
            {dialog}
        </Section>
    );
}
