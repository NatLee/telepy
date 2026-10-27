"use client";

/**
 * 通道詳細資訊:ID / 反向埠 / 權限一眼看到,主機別名、描述與裝置公鑰可直接編輯(VIEW 權限唯讀);
 * 別名與公鑰不能和別條通道重複,後端擋下時錯誤顯示在欄位旁(並跳到那一頁)。
 * 版面跟偏好設定一樣:左側分頁 + 固定高度 —— 基本資料 / 裝置 / 金鑰與身分 / 工作階段 / 連線紀錄。
 * 每頁都一直掛著(只是藏起來),切頁不會重抓、也不會丟掉剛刷新的裝置狀況;沒存的改動在分頁上標一個點。
 * Tunnel details: id / reverse port / permission at a glance; alias, description and the device's public
 * key are edited in place (read-only with VIEW access). Alias and key must be unique across tunnels; a
 * backend rejection shows next to the field (and jumps to its tab).
 * Laid out like Preferences: a left tab rail + fixed height — Basics / Device / Keys & identity /
 * Sessions / Connections. Every tab stays mounted (just hidden), so switching neither refetches nor loses
 * freshly refreshed device facts; unsaved changes put a dot on their tab.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
import { useTunnelDetailsModal, type TunnelFormErrors } from "@/hooks/useTunnelDetailsModal";
import { useTunnelConnections } from "@/hooks/useTunnelConnections";
import { TunnelConnectionsSection } from "@/components/tunnels/TunnelConnections";
import { DeviceHostKeySection } from "@/components/tunnels/DeviceHostKeySection";
import { StepUpSetting } from "@/components/tunnels/StepUpSetting";
import { RecordingSetting } from "@/components/tunnels/RecordingSetting";
import { useFeatures } from "@/hooks/useFeatures";
import { TerminalDetachSetting } from "@/components/tunnels/TerminalDetachSetting";
import { DeviceFactsSection } from "@/components/tunnels/DeviceFacts";
import { Activity, Cpu, Save, Server, Loader2, KeyRound, Pencil, Hash, Network, ShieldCheck, Tag, UserCheck } from "lucide-react";
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

import type { TunnelDetailsTab, TunnelModalProps } from "@/types/tunnel";

interface TunnelDetailsModalProps extends TunnelModalProps {
    onUpdate: () => void;
    /** 打開時先顯示的分頁(例:主機金鑰警示 → 金鑰與身分)。/ Tab to open at (e.g. a host-key alert → Keys & identity). */
    initialTab?: TunnelDetailsTab;
}

/** 欄位屬於哪一頁:後端擋下時跳過去。/ Which tab a field lives on, to jump there on a rejection. */
const FIELD_TAB: Record<keyof TunnelFormErrors, TunnelDetailsTab> = {
    host_friendly_name: "general",
    description: "general",
    labels: "general",
    key: "identity",
};

/** 分頁標籤旁的小點:紅 = 要修正,橘 = 還沒存。/ Dot beside a tab label: red = needs a fix, orange = unsaved. */
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

export function TunnelDetailsModal({ isOpen, onClose, tunnelId, onUpdate, initialTab }: TunnelDetailsModalProps) {
    const { t } = useI18n();
    const { has } = useFeatures();
    const {
        state: { details, loading, form, labelsText, labels, errors, canEdit, dirty, basicsDirty, keyChanged, valid, isSaving },
        actions: { setField, setLabelsText, save },
    } = useTunnelDetailsModal(tunnelId, isOpen, onUpdate, onClose);
    const connections = useTunnelConnections(tunnelId, isOpen);
    const [tab, setTabState] = useState<TunnelDetailsTab>(initialTab ?? "general");
    const formRef = useRef<HTMLFormElement>(null);

    // 每次打開(或換一條通道)回到指定的分頁:在 render 時比對,不用 effect。
    // Every open (or another tunnel) starts at the requested tab; adjusted during render, not in an effect.
    const openKey = isOpen ? `${tunnelId}:${initialTab ?? "general"}` : null;
    const [lastOpenKey, setLastOpenKey] = useState(openKey);
    // 主機金鑰變了 / 機器是別人的:分頁標紅;沒指定分頁打開時直接切過去(最要緊的事不該藏起來)。
    // Host key changed / machine claimed: the tab turns red, and an open without a requested tab goes there.
    const [hostKeyAlert, setHostKeyAlert] = useState(false);
    if (openKey !== lastOpenKey) {
        setLastOpenKey(openKey);
        setHostKeyAlert(false);
        if (openKey) setTabState(initialTab ?? "general");
    }
    const autoTab = !initialTab;
    const onHostKeyAlert = useCallback(
        (alert: boolean) => {
            setHostKeyAlert(alert);
            if (alert && autoTab) setTabState("identity");
        },
        [autoTab],
    );

    // 切頁時內容區回到頂端(各頁一直掛著,共用同一個捲動區)。/ Switching tabs scrolls the shared body back to the top.
    const setTab = (next: TunnelDetailsTab) => {
        setTabState(next);
        const scroller = formRef.current?.parentElement;
        if (scroller) scroller.scrollTop = 0;
    };

    const role = details?.user_permission ?? "owner";
    const manager = role === "owner" || role === "admin";
    // 看不到裝置位址的人(沒有可用帳號)就沒有「裝置」頁。/ No Device tab for people who can't see the device.
    const showDevice = !!details?.endpoint;
    const activeTab = tab === "device" && !showDevice ? "general" : tab;

    const basicsError = !!(errors.host_friendly_name || errors.description || errors.labels);
    const tabs = [
        { value: "general" as const, label: <NavTabLabel label={t("tunnelDetails.tabGeneral")} mark={basicsError ? "error" : basicsDirty ? "dirty" : null} />, hint: t("tunnelDetails.tabGeneralHint"), icon: <Pencil /> },
        ...(showDevice ? [{ value: "device" as const, label: t("tunnelDetails.tabDevice"), hint: t("tunnelDetails.tabDeviceHint"), icon: <Cpu /> }] : []),
        { value: "identity" as const, label: <NavTabLabel label={t("tunnelDetails.tabIdentity")} mark={errors.key || hostKeyAlert ? "error" : keyChanged ? "dirty" : null} />, hint: t("tunnelDetails.tabIdentityHint"), icon: <KeyRound /> },
        { value: "sessions" as const, label: t("tunnelDetails.tabSessions"), hint: t("tunnelDetails.tabSessionsHint"), icon: <UserCheck /> },
        { value: "connections" as const, label: t("tunnelDetails.tabConnections"), hint: t("tunnelDetails.tabConnectionsHint"), icon: <Activity /> },
    ];

    const submit = async () => {
        const rejected = await save();
        if (!rejected) return;
        // 目前這頁沒有錯誤就跳到第一個有錯的那頁。/ Jump to the first tab with an error unless this one has one.
        const tabsWithErrors = (Object.keys(rejected) as (keyof TunnelFormErrors)[]).map((f) => FIELD_TAB[f]);
        if (tabsWithErrors.length && !tabsWithErrors.includes(activeTab)) setTab(tabsWithErrors[0]);
    };
    // 「儲存」只在有可編輯欄位的頁,或有改動還沒存時出現。/ Save shows on the tabs with fields, or while changes are unsaved.
    const showSave = canEdit && (activeTab === "general" || activeTab === "identity" || dirty);

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
            size="5xl"
            fixedHeight
            nav={details && !loading ? <NavTabs tabs={tabs} value={activeTab} onChange={setTab} aria-label={t("tunnelDetails.title")} /> : undefined}
            isLoading={loading || !details}
            footer={
                details && !loading ? (
                    <>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("common.close")}
                        </Button>
                        {showSave && (
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
                    ref={formRef}
                    id="tunnel-details-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    {/* 基本資料 / Basics */}
                    <div role="tabpanel" hidden={activeTab !== "general"} className="space-y-6">
                        {!canEdit && <Callout tone="info">{t("tunnelDetails.readOnly")}</Callout>}
                        <Section icon={<Pencil />} title={t("tunnelDetails.basics")}>
                            <Field id="tunnel-details-name" label={t("tunnelDetails.hostFriendlyName")} required={canEdit} hint={canEdit ? t("tunnelDetails.nameHint") : undefined} error={errors.host_friendly_name}>
                                <Input value={form.host_friendly_name} onChange={(e) => setField("host_friendly_name", e.target.value)} disabled={!canEdit} maxLength={100} />
                            </Field>
                            <Field id="tunnel-details-description" label={t("common.description")} addon={canEdit ? t("common.optional") : undefined} error={errors.description}>
                                <Textarea
                                    value={form.description}
                                    onChange={(e) => setField("description", e.target.value)}
                                    rows={3}
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
                    </div>

                    {/* 裝置的基本狀況（能登入裝置的人才看得到）。/ Device facts (people who can log in to the device). */}
                    {showDevice && (
                        <div role="tabpanel" hidden={activeTab !== "device"} className="space-y-6">
                            <DeviceFactsSection tunnelId={details.id} isOpen={isOpen} endpoint={details.endpoint} deviceName={details.host_friendly_name} canRefresh={manager} />
                        </div>
                    )}

                    {/* 裝置公鑰 + 裝置身分（host key 釘選）/ Device public key + device identity (pinned host key) */}
                    <div role="tabpanel" hidden={activeTab !== "identity"} className="space-y-6">
                        {!canEdit && <Callout tone="info">{t("tunnelDetails.readOnly")}</Callout>}
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
                        <DeviceHostKeySection tunnelId={tunnelId} isOpen={isOpen} onChanged={onUpdate} onAlert={onHostKeyAlert} />
                    </div>

                    {/* 工作階段的規則(owner / ADMIN 可改):二次確認、錄影、斷線保留 shell。
                        Session rules (owner / ADMIN): step-up, recording, keeping shells after a drop. */}
                    <div role="tabpanel" hidden={activeTab !== "sessions"} className="space-y-6">
                        <StepUpSetting tunnelId={details.id} required={!!details.require_step_up} canManage={manager} onChanged={onUpdate} />
                        {has("recordings.manage") && <RecordingSetting tunnelId={details.id} enabled={!!details.record_sessions} canManage={manager} onChanged={onUpdate} />}
                        <TerminalDetachSetting tunnelId={details.id} policy={details.terminal_detach_policy} canManage={manager} onChanged={onUpdate} />
                    </div>

                    {/* 連線紀錄 / Connection history */}
                    <div role="tabpanel" hidden={activeTab !== "connections"} className="space-y-6">
                        <TunnelConnectionsSection data={connections.data} failed={connections.failed} />
                    </div>
                </form>
            )}
        </Modal>
    );
}
