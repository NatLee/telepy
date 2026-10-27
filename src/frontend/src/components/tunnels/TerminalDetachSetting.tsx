/**
 * 隧道詳細資訊裡的「斷線後保留 shell」：owner / ADMIN 選「照每個人的選擇」或「一律立刻結束」（敏感裝置；
 * 放寬回去要再驗證），其他人只看狀態。
 * The tunnel details' "keep shells after a disconnect": owner / ADMIN pick "each person's choice" or "always end at
 * once" (sensitive devices; relaxing it needs a re-authentication); everyone else sees the state.
 */
import React, { useState } from "react";
import { Unplug } from "lucide-react";
import { Chip, Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, needsReauth } from "@/lib/mfa";
import { isDetachPolicy, type DetachPolicy } from "@/lib/terminalDetach";

export function TerminalDetachSetting({ tunnelId, policy, canManage, onChanged }: { tunnelId: number; policy: string | undefined; canManage: boolean; onChanged?: () => void }) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const { request, dialog } = useReauth();
    const [value, setValue] = useState<DetachPolicy>(isDetachPolicy(policy) ? policy : "user");
    const [busy, setBusy] = useState(false);

    const change = async (next: DetachPolicy) => {
        if (busy || next === value) return;
        setBusy(true);
        try {
            const put = (body: object) => apiFetch(`/api/reverse/server/${tunnelId}/terminal-detach`, { method: "PUT", body: JSON.stringify(body) });
            let res = await put({ policy: next });
            let data = await readJson(res);
            const methods = needsReauth(res.status, data);
            if (methods) {
                const proof = await request(methods);
                if (!proof) return;
                res = await put({ policy: next, reauth: proof });
                data = await readJson(res);
            }
            if (res.ok) {
                setValue(next);
                showSuccess(next === "never" ? t("detach.tunnel.turnedNever") : t("detach.tunnel.turnedUser"));
                onChanged?.();
            } else {
                showError(mfaErrorMessage(t, data, t("detach.tunnel.changeFailed")));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section
            icon={<Unplug />}
            title={t("detach.tunnel.title")}
            description={t("detach.tunnel.description")}
            action={value === "never" ? <Chip tone="warning">{t("detach.tunnel.chipNever")}</Chip> : <Chip>{t("detach.tunnel.chipUser")}</Chip>}
        >
            {canManage ? (
                <Segmented
                    size="sm"
                    aria-label={t("detach.tunnel.title")}
                    value={value}
                    onChange={(v) => void change(v)}
                    options={[
                        { value: "user" as const, label: t("detach.tunnel.user") },
                        { value: "never" as const, label: t("detach.tunnel.never") },
                    ]}
                />
            ) : (
                <p className="text-sm text-foreground">{value === "never" ? t("detach.tunnel.neverReadOnly") : t("detach.tunnel.userReadOnly")}</p>
            )}
            {dialog}
        </Section>
    );
}
