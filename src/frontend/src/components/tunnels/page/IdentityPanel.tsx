"use client";

/**
 * 通道頁面的「金鑰與身分」：裝置的公鑰（擁有者 / Admin 才看得到、能換；換的時候確認是你）與釘選的裝置主機金鑰。
 * A tunnel page's "Keys & identity": the device's public key (owner / Admin only; changing it asks you to confirm)
 * and the pinned device host key.
 */
import React, { useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/components/ui/section";
import { KeyTypeBadge } from "@/components/keys/KeyList";
import { DeviceHostKeySection } from "@/components/tunnels/DeviceHostKeySection";
import type { useTunnelDetails } from "@/hooks/useTunnelDetails";
import { fingerprint, parsePublicKey } from "@/lib/sshKeys";
import { useI18n } from "@/lib/i18n";

/** 貼上的公鑰的即時預覽:類型 / 位元數 / 指紋。/ Live preview of a pasted key: type, size, fingerprint. */
function KeyPreview({ value }: { value: string }) {
    const parsed = useMemo(() => parsePublicKey(value), [value]);
    const [fp, setFp] = useState<{ key: string; fp: string } | null>(null);
    useEffect(() => {
        if (!parsed) return;
        let cancelled = false;
        fingerprint(parsed)
            .then((v) => !cancelled && setFp({ key: value, fp: v }))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [parsed, value]);
    if (!parsed) return null;
    const current = fp?.key === value ? fp.fp : null;
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-inset ring-border/80">
            <KeyTypeBadge type={parsed.label} bits={parsed.bits} />
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={current ?? ""}>
                {current ?? "…"}
            </span>
            {parsed.comment && <span className="truncate font-mono text-xs text-muted-foreground/80">{parsed.comment}</span>}
        </div>
    );
}

export function IdentityPanel({ tunnelId, form: f, onSave, onChanged }: { tunnelId: number; form: ReturnType<typeof useTunnelDetails>; onSave: () => void; onChanged: () => void }) {
    const { t } = useI18n();
    const { details, form, errors, canChangeKey, keyChanged, valid, isSaving } = f.state;
    return (
        <div className="space-y-6">
            {/* 裝置金鑰認得是哪台機器：只有 owner / ADMIN 看得到、能換。/ The device key identifies the machine: owner / ADMIN only. */}
            {!details ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" /> {t("common.loading")}
                </p>
            ) : canChangeKey ? (
                <Section icon={<KeyRound />} title={t("tunnelDetails.keySection")} description={t("tunnelDetails.keyHint")} action={form.key.trim() ? <CopyButton value={form.key.trim()} /> : undefined}>
                    <form
                        className="space-y-3"
                        onSubmit={(e) => {
                            e.preventDefault();
                            onSave();
                        }}
                    >
                        <Field id="tunnel-page-key" label={t("tunnels.publicKey")} required error={errors.key}>
                            <Textarea value={form.key} onChange={(e) => f.actions.setField("key", e.target.value)} rows={3} spellCheck={false} className="break-all font-mono text-xs leading-relaxed md:text-xs" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… device" />
                        </Field>
                        <KeyPreview value={form.key} />
                        {keyChanged && !errors.key && <Callout tone="warning">{t("tunnelDetails.keyChanged")}</Callout>}
                        <Button type="submit" disabled={isSaving || !keyChanged || !valid}>
                            {isSaving ? <Loader2 className="animate-spin" /> : <Save />} {t("common.saveChanges")}
                        </Button>
                    </form>
                </Section>
            ) : (
                <Callout tone="info">{t("tunnelDetails.keyManagersOnly")}</Callout>
            )}
            <DeviceHostKeySection tunnelId={tunnelId} isOpen onChanged={onChanged} onAlert={() => {}} />
        </div>
    );
}
