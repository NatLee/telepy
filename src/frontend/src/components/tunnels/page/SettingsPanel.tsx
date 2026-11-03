"use client";

/**
 * 通道頁面的「設定」：名稱（= ssh 的主機名稱，規則在欄位下）、描述、標籤（存檔按鈕在這一區）；這條通道的通知（只影響自己）；
 * 最後是離開 / 刪除。
 * A tunnel page's "Settings": name (the ssh host name, rules under the field), description and labels with their own
 * Save; this tunnel's notifications (just for you); and leaving / deleting at the end.
 */
import React from "react";
import { Bell, Loader2, LogOut, Pencil, Save, Tag, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Chip, Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { TunnelNameHelp } from "@/components/tunnels/TunnelNameHelp";
import { useNotifyPrefs } from "@/hooks/useNotifyPrefs";
import type { useTunnelDetails } from "@/hooks/useTunnelDetails";
import { sshSafeName, suggestTunnelName } from "@/lib/tunnelName";
import { useI18n } from "@/lib/i18n";
import type { MuteScope } from "@/lib/notifyPrefs";
import type { Tunnel } from "@/types/tunnel";

interface Props {
    tunnel: Tunnel;
    form: ReturnType<typeof useTunnelDetails>;
    onSave: () => void;
    onLeave: () => void;
    onDelete: () => void;
}

export function SettingsPanel({ tunnel, form: f, onSave, onLeave, onDelete }: Props) {
    const { t } = useI18n();
    const { showError } = useToast();
    const { prefs, setMute } = useNotifyPrefs();
    const { details, form, labelsText, labels, errors, canEdit, basicsDirty, valid, isSaving } = f.state;
    const { setField, setLabelsText } = f.actions;
    const scope: MuteScope | "none" = prefs?.mutes.find((m) => m.tunnel_id === tunnel.id)?.scope ?? "none";
    const mute = (v: MuteScope | "none") =>
        setMute(tunnel.id, tunnel.host_friendly_name, v === "none" ? null : v).catch((e: unknown) => showError(t("notifyPrefs.saveFailed", { error: e instanceof Error ? e.message : "" })));

    return (
        <div className="space-y-6">
            <Section icon={<Pencil />} title={t("tunnelDetails.basics")}>
                {!details ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 size={14} className="animate-spin" /> {t("common.loading")}
                    </p>
                ) : (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            onSave();
                        }}
                    >
                        {!canEdit && <Callout tone="info">{t("tunnelDetails.readOnly")}</Callout>}
                        {/* 名稱 = ssh 的主機名稱：規則與為什麼在欄位下面。/ The name is the ssh host name: rules + why under the field. */}
                        <div className="space-y-1.5">
                            <Field id="tunnel-page-name" label={t("tunnelDetails.hostFriendlyName")} required={canEdit}>
                                <Input value={form.host_friendly_name} onChange={(e) => setField("host_friendly_name", e.target.value)} disabled={!canEdit} maxLength={100} className="font-mono" spellCheck={false} autoComplete="off" aria-describedby="tunnel-page-name-help" />
                            </Field>
                            {canEdit && <TunnelNameHelp id="tunnel-page-name-help" value={form.host_friendly_name} original={details.host_friendly_name} error={errors.host_friendly_name} onUse={(v) => setField("host_friendly_name", v)} />}
                            {canEdit && !sshSafeName(details.host_friendly_name) && form.host_friendly_name.trim() === details.host_friendly_name && (
                                <Callout tone="warning" title={t("tunnelName.old.title")}>
                                    <span className="block">{t("tunnelName.old.body")}</span>
                                    <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setField("host_friendly_name", suggestTunnelName(details.host_friendly_name))}>
                                        {t("tunnelName.use", { name: suggestTunnelName(details.host_friendly_name) })}
                                    </Button>
                                </Callout>
                            )}
                        </div>
                        <Field id="tunnel-page-description" label={t("common.description")} addon={canEdit ? t("common.optional") : undefined} error={errors.description}>
                            <Textarea value={form.description} onChange={(e) => setField("description", e.target.value)} rows={3} disabled={!canEdit} placeholder={canEdit ? t("tunnelDetails.descriptionPlaceholder") : t("tunnelDetails.noDescription")} />
                        </Field>
                        <Field id="tunnel-page-labels" label={t("tunnelDetails.labels")} addon={canEdit ? t("common.optional") : undefined} hint={canEdit ? t("tunnelDetails.labelsHint") : undefined} error={errors.labels}>
                            <Input value={labelsText} onChange={(e) => setLabelsText(e.target.value)} disabled={!canEdit} spellCheck={false} autoCapitalize="none" placeholder={canEdit ? "home, env=prod" : t("tunnelDetails.noLabels")} />
                        </Field>
                        {labels.length > 0 && (
                            <span className="-mt-2 flex flex-wrap gap-1">
                                {labels.map((l) => (
                                    <Chip key={l}>
                                        <Tag /> {l}
                                    </Chip>
                                ))}
                            </span>
                        )}
                        {canEdit && (
                            <div className="flex flex-wrap items-center gap-3">
                                <Button type="submit" disabled={isSaving || !basicsDirty || !valid}>
                                    {isSaving ? <Loader2 className="animate-spin" /> : <Save />} {t("common.saveChanges")}
                                </Button>
                                {basicsDirty && <span className="text-xs text-warning">{t("tunnelPage.unsaved")}</span>}
                            </div>
                        )}
                    </form>
                )}
            </Section>

            {/* 只影響自己：這條通道的通知要不要顯示（強制的照樣會顯示）。/ Just for you: this tunnel's notifications. */}
            <Section icon={<Bell />} title={t("notifyPrefs.menu")} description={t(scope === "all" ? "notifyPrefs.menuHintAll" : scope === "status" ? "notifyPrefs.menuHintStatus" : "notifyPrefs.menuHintOn")}>
                <Segmented
                    fullWidth
                    size="sm"
                    aria-label={t("notifyPrefs.menu")}
                    value={scope}
                    onChange={(v) => void mute(v)}
                    options={[
                        { value: "none", label: t("notifyPrefs.menuShowAll") },
                        { value: "status", label: t("notifyPrefs.menuMuteStatus") },
                        { value: "all", label: t("notifyPrefs.menuMuteAll") },
                    ]}
                />
            </Section>

            {(tunnel.can_delete || !tunnel.is_owner) && (
                // 卡片本身是紅框：裡面不再框一層。/ The card itself carries the red border: no second box inside.
                <Section icon={<TriangleAlert />} title={t("tunnelPage.danger")} tone="danger">
                    <div className="divide-y divide-border [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                        {!tunnel.is_owner && (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <span className="min-w-0 text-sm text-muted-foreground">{t("tunnelActions.leaveHint")}</span>
                                <Button type="button" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={onLeave}>
                                    <LogOut size={15} /> {t("tunnelActions.leaveTunnel")}
                                </Button>
                            </div>
                        )}
                        {tunnel.can_delete && (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <span className="min-w-0 text-sm text-muted-foreground">{t("tunnelActions.deleteHint")}</span>
                                <Button type="button" variant="destructive" onClick={onDelete}>
                                    <Trash2 size={15} /> {t("tunnelActions.deleteTunnel")}
                                </Button>
                            </div>
                        )}
                    </div>
                </Section>
            )}
        </div>
    );
}
