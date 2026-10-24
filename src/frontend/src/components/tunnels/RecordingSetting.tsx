/**
 * 隧道詳細資訊裡的「錄下網頁終端機」：owner / ADMIN 開關（關掉要再驗證），其他人只看狀態。
 * The "record web terminal sessions" setting in the tunnel details: owner / ADMIN switch it (turning it off needs a
 * re-authentication); everyone else sees the state.
 */
import React, { useState } from "react";
import Link from "next/link";
import { CircleDot } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, needsReauth } from "@/lib/mfa";

export function RecordingSetting({ tunnelId, enabled, canManage, onChanged }: { tunnelId: number; enabled: boolean; canManage: boolean; onChanged?: () => void }) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const { request, dialog } = useReauth();
    const [value, setValue] = useState(enabled);
    const [busy, setBusy] = useState(false);

    const change = async (next: boolean) => {
        if (busy || next === value) return;
        setBusy(true);
        try {
            const put = (body: object) => apiFetch(`/api/reverse/server/${tunnelId}/recording`, { method: "PUT", body: JSON.stringify(body) });
            let res = await put({ enabled: next });
            let data = await readJson(res);
            const methods = needsReauth(res.status, data);
            if (methods) {
                const proof = await request(methods);
                if (!proof) return;
                res = await put({ enabled: next, reauth: proof });
                data = await readJson(res);
            }
            if (res.ok) {
                setValue(next);
                showSuccess(next ? t("recordings.turnedOn") : t("recordings.turnedOff"));
                onChanged?.();
            } else {
                showError(mfaErrorMessage(t, data, t("recordings.changeFailed")));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section
            icon={<CircleDot />}
            title={t("recordings.sectionTitle")}
            description={t("recordings.sectionDescription")}
            action={
                <Link href={`/tunnels/recordings?tunnel=${tunnelId}`} className="text-xs text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground">
                    {t("recordings.viewLink")}
                </Link>
            }
        >
            {canManage ? (
                <Segmented
                    size="sm"
                    aria-label={t("recordings.sectionTitle")}
                    value={value ? "on" : "off"}
                    onChange={(v) => void change(v === "on")}
                    options={[
                        { value: "off", label: t("recordings.off") },
                        { value: "on", label: t("recordings.on") },
                    ]}
                />
            ) : (
                <p className="text-sm text-foreground">{value ? t("recordings.onReadOnly") : t("recordings.offReadOnly")}</p>
            )}
            {value && <Callout tone="info">{t("recordings.whatHappens")}</Callout>}
            {dialog}
        </Section>
    );
}
