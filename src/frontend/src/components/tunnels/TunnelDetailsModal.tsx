"use client";

/**
 * 通道詳細資訊:ID / 反向埠 / 權限一眼看到,主機別名、描述與裝置公鑰可直接編輯(VIEW 權限唯讀);
 * 別名與公鑰不能和別條通道重複,後端擋下時錯誤顯示在欄位旁。
 * Tunnel details: id / reverse port / permission at a glance; alias, description and the device's public
 * key are edited in place (read-only with VIEW access). Alias and key must be unique across tunnels; a
 * backend rejection shows next to the field.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useTunnelDetailsModal } from "@/hooks/useTunnelDetailsModal";
import { useTunnelConnections } from "@/hooks/useTunnelConnections";
import { TunnelConnectionsSection } from "@/components/tunnels/TunnelConnections";
import { DeviceHostKeySection } from "@/components/tunnels/DeviceHostKeySection";
import { StepUpSetting } from "@/components/tunnels/StepUpSetting";
import { RecordingSetting } from "@/components/tunnels/RecordingSetting";
import { TerminalDetachSetting } from "@/components/tunnels/TerminalDetachSetting";
import { DeviceFactsSection } from "@/components/tunnels/DeviceFacts";
import { Save, Server, Loader2, KeyRound, Pencil, Hash, Network, ShieldCheck, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip, Section } from "@/components/ui/section";
import { KeyTypeBadge } from "@/components/keys/KeyList";
import { fingerprint, parsePublicKey } from "@/lib/sshKeys";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

import { TunnelModalProps } from "@/types/tunnel";

interface TunnelDetailsModalProps extends TunnelModalProps {
    onUpdate: () => void;
}

const ROLE_LABEL: Record<string, TranslationKey> = {
    owner: "keys.role.owner",
    admin: "keys.role.admin",
    edit: "keys.role.edit",
    view: "keys.role.view",
};

/** 貼上的公鑰的即時預覽:類型 / 位元數 / 指紋。/ Live preview of a pasted key: type, size, fingerprint. */
function KeyPreview({ value }: { value: string }) {
    const parsed = useMemo(() => parsePublicKey(value), [value]);
    const [fp, setFp] = useState<{ key: string; fp: string } | null>(null);
    useEffect(() => {
        if (!parsed) return;
        let cancelled = false;
        fingerprint(parsed).then((v) => !cancelled && setFp({ key: value, fp: v })).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [parsed, value]);
    if (!parsed) return null;
    const current = fp?.key === value ? fp.fp : null;
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-inset ring-border/80">
            <KeyTypeBadge type={parsed.label} bits={parsed.bits} />
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={current ?? ""}>{current ?? "…"}</span>
            {parsed.comment && <span className="truncate font-mono text-xs text-muted-foreground/80">{parsed.comment}</span>}
        </div>
    );
}

export function TunnelDetailsModal({ isOpen, onClose, tunnelId, onUpdate }: TunnelDetailsModalProps) {
    const { t } = useI18n();
    const {
        state: { details, loading, form, labelsText, labels, errors, canEdit, dirty, keyChanged, valid, isSaving },
        actions: { setField, setLabelsText, save },
    } = useTunnelDetailsModal(tunnelId, isOpen, onUpdate, onClose);
    const connections = useTunnelConnections(tunnelId, isOpen);

    const role = details?.user_permission ?? "owner";

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("tunnelDetails.title")}
            description={
                details ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                        <Chip mono><Hash /> {details.id}</Chip>
                        <Chip tone="primary" mono><Network /> :{details.reverse_port}</Chip>
                        <Chip tone={role === "view" ? "neutral" : "success"}><ShieldCheck /> {t(ROLE_LABEL[role] ?? "keys.role.view")}</Chip>
                    </span>
                ) : undefined
            }
            icon={<Server />}
            size="xl"
            isLoading={loading || !details}
            footer={
                details && !loading ? (
                    <>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("common.close")}
                        </Button>
                        {canEdit && (
                            <Button type="submit" form="tunnel-details-form" disabled={isSaving || !dirty || !valid}>
                                {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
                                {t("common.saveChanges")}
                            </Button>
                        )}
                    </>
                ) : undefined
            }
        >
            {details && !loading && (
                <form
                    id="tunnel-details-form"
                    className="space-y-6"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    {!canEdit && <Callout tone="info">{t("tunnelDetails.readOnly")}</Callout>}

                    {/* 基本資料 / Basics */}
                    <Section icon={<Pencil />} title={t("tunnelDetails.basics")}>
                        <Field id="tunnel-details-name" label={t("tunnelDetails.hostFriendlyName")} required={canEdit} hint={canEdit ? t("tunnelDetails.nameHint") : undefined} error={errors.host_friendly_name}>
                            <Input value={form.host_friendly_name} onChange={(e) => setField("host_friendly_name", e.target.value)} disabled={!canEdit} maxLength={100} />
                        </Field>
                        <Field id="tunnel-details-description" label={t("common.description")} addon={canEdit ? t("common.optional") : undefined} error={errors.description}>
                            <Textarea
                                value={form.description}
                                onChange={(e) => setField("description", e.target.value)}
                                rows={2}
                                disabled={!canEdit}
                                placeholder={canEdit ? t("tunnelDetails.descriptionPlaceholder") : t("tunnelDetails.noDescription")}
                            />
                        </Field>
                        <Field id="tunnel-details-labels" label={t("tunnelDetails.labels")} addon={canEdit ? t("common.optional") : undefined} hint={canEdit ? t("tunnelDetails.labelsHint") : undefined} error={errors.labels}>
                            <Input
                                value={labelsText}
                                onChange={(e) => setLabelsText(e.target.value)}
                                disabled={!canEdit}
                                spellCheck={false}
                                autoCapitalize="none"
                                placeholder={canEdit ? "home, env=prod" : t("tunnelDetails.noLabels")}
                            />
                        </Field>
                        {labels.length > 0 && (
                            <span className="-mt-2 flex flex-wrap gap-1">
                                {labels.map((l) => (
                                    <Chip key={l}><Tag /> {l}</Chip>
                                ))}
                            </span>
                        )}
                    </Section>

                    {/* 裝置的基本狀況（能登入裝置的人才看得到）。/ Device facts (people who can log in to the device). */}
                    <DeviceFactsSection tunnelId={details.id} isOpen={isOpen} endpoint={details.endpoint} deviceName={details.host_friendly_name} canRefresh={role === "owner" || role === "admin"} />

                    {/* 開 session 前確認是你（owner / ADMIN 可改）。/ Step-up before sessions (owner / ADMIN). */}
                    <StepUpSetting tunnelId={details.id} required={!!details.require_step_up} canManage={role === "owner" || role === "admin"} onChanged={onUpdate} />

                    {/* 錄下網頁終端機（owner / ADMIN 可改）。/ Record web terminals (owner / ADMIN). */}
                    <RecordingSetting tunnelId={details.id} enabled={!!details.record_sessions} canManage={role === "owner" || role === "admin"} onChanged={onUpdate} />

                    {/* 斷線後保留網頁終端機的 shell（owner / ADMIN 可改）。/ Keep web terminal shells after a drop (owner / ADMIN). */}
                    <TerminalDetachSetting tunnelId={details.id} policy={details.terminal_detach_policy} canManage={role === "owner" || role === "admin"} onChanged={onUpdate} />

                    {/* 裝置公鑰 / Device public key */}
                    <Section
                        icon={<KeyRound />}
                        title={t("tunnelDetails.keySection")}
                        description={t("tunnelDetails.keyHint")}
                        action={form.key.trim() ? <CopyButton value={form.key.trim()} /> : undefined}
                    >
                        <Field id="tunnel-details-key" label={t("tunnels.publicKey")} required={canEdit} error={errors.key}>
                            <Textarea
                                value={form.key}
                                onChange={(e) => setField("key", e.target.value)}
                                rows={3}
                                disabled={!canEdit}
                                spellCheck={false}
                                className="break-all font-mono text-xs leading-relaxed md:text-xs"
                                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… device"
                            />
                        </Field>
                        <KeyPreview value={form.key} />
                        {keyChanged && !errors.key && <Callout tone="warning">{t("tunnelDetails.keyChanged")}</Callout>}
                    </Section>

                    {/* 裝置身分（host key 釘選）/ Device identity (pinned host key) */}
                    <DeviceHostKeySection tunnelId={tunnelId} isOpen={isOpen} onChanged={onUpdate} />

                    {/* 連線紀錄 / Connection history */}
                    <TunnelConnectionsSection data={connections.data} failed={connections.failed} />
                </form>
            )}
        </Modal>
    );
}
