/**
 * 金鑰詳情：指紋、類型、建立 / 最後使用、完整公鑰、可編輯說明，以及它在每台裝置每個帳號上的狀態。
 * Key details: fingerprint, type, created / last used, full public key, editable description and its state
 * on every device account.
 */
import React, { useState } from "react";
import { Edit3, HardDrive, KeyRound, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { KeyDevice, KeyTarget, UserKey } from "@/types/keys";
import { KeyTypeBadge } from "./KeyCard";
import { OnlineDot } from "./DeviceMatrix";
import { TargetChips } from "./TargetChips";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3 py-2 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{children}</dd>
        </div>
    );
}

export function KeyDetailsModal({
    keyItem,
    placements,
    onClose,
    onSave,
    onManageDevice,
}: {
    keyItem: UserKey | null;
    placements: { device: KeyDevice; targets: KeyTarget[] }[];
    onClose: () => void;
    onSave: (key: UserKey, description: string) => Promise<boolean>;
    onManageDevice: (device: KeyDevice) => void;
}) {
    const { t, locale } = useI18n();
    // 編輯狀態綁在金鑰 id 上：換一把金鑰就自動離開編輯。/ Editing is tied to the key id.
    const [editingId, setEditingId] = useState<number | null>(null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const editing = !!keyItem && editingId === keyItem.id;
    const setEditing = (on: boolean) => {
        if (on && keyItem) setDraft(keyItem.description ?? "");
        setEditingId(on && keyItem ? keyItem.id : null);
    };

    const fmt = (iso: string) => new Date(iso).toLocaleString(locale);

    return (
        <Modal
            isOpen={!!keyItem}
            onClose={onClose}
            title={t("keys.detailsTitle")}
            description={keyItem?.host_friendly_name}
            icon={<KeyRound />}
            size="2xl"
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            {keyItem && (
                <div className="space-y-6">
                    <dl className="divide-y divide-border/70 rounded-xl bg-surface px-3 ring-1 ring-border">
                        <Row label={t("keys.type")}>
                            <KeyTypeBadge type={keyItem.key_type} bits={keyItem.bits} />
                        </Row>
                        <Row label={t("keys.fingerprint")}>
                            <span className="flex items-center gap-1">
                                <span className="min-w-0 break-all font-mono text-xs">{keyItem.fingerprint ?? t("keys.noFingerprint")}</span>
                                {keyItem.fingerprint && <CopyButton value={keyItem.fingerprint} />}
                            </span>
                        </Row>
                        {keyItem.comment && (
                            <Row label={t("keys.comment")}>
                                <span className="font-mono text-xs">{keyItem.comment}</span>
                            </Row>
                        )}
                        <Row label={t("keys.created")}>{fmt(keyItem.created_at)}</Row>
                        <Row label={t("keys.lastUsed")}>
                            {keyItem.last_used_at ? (
                                <span title={fmt(keyItem.last_used_at)}>
                                    {formatRelativeTime(keyItem.last_used_at, locale)}
                                    {keyItem.last_used_ip && <span className="text-muted-foreground"> · {keyItem.last_used_ip}</span>}
                                </span>
                            ) : (
                                <span className="text-muted-foreground">{t("keys.neverUsed")}</span>
                            )}
                        </Row>
                    </dl>

                    <div className="space-y-2">
                        <Label>{t("keys.onDevices")}</Label>
                        {placements.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("keys.onNoDeviceHint")}</p>
                        ) : (
                            <ul className="space-y-2">
                                {placements.map(({ device, targets }) => (
                                    <li key={device.tunnel_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ring-1 ring-border">
                                        <span className="flex min-w-0 flex-col gap-1">
                                            <span className="flex items-center gap-2 text-sm">
                                                <HardDrive size={14} className="text-muted-foreground" aria-hidden />
                                                <span className="truncate">{device.host_friendly_name}</span>
                                                <OnlineDot online={device.online} />
                                            </span>
                                            <TargetChips targets={targets} online={device.online} />
                                        </span>
                                        <Button variant="ghost" size="xs" onClick={() => onManageDevice(device)} className="text-primary hover:text-primary">
                                            {t("keys.matrix.manage")}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label>{t("keys.publicKey")}</Label>
                        <CodeBlock value={keyItem.key} language="ssh" />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>{t("common.description")}</Label>
                            {!editing && (
                                <Button variant="ghost" size="xs" onClick={() => setEditing(true)} className="text-primary hover:text-primary">
                                    <Edit3 /> {t("common.edit")}
                                </Button>
                            )}
                        </div>
                        {editing ? (
                            <div className="space-y-2">
                                <Textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder={t("keys.addDescriptionPlaceholder")} />
                                <div className="flex justify-end gap-2">
                                    <Button size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>
                                        {t("common.cancel")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={saving}
                                        onClick={async () => {
                                            setSaving(true);
                                            if (await onSave(keyItem, draft)) setEditing(false);
                                            setSaving(false);
                                        }}
                                    >
                                        {saving ? <Loader2 className="animate-spin" /> : t("common.save")}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <p className="whitespace-pre-wrap text-sm text-foreground">
                                {keyItem.description || <span className="italic text-muted-foreground">{t("keys.noDescription")}</span>}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}
