"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { useTunnelDetailsModal } from "@/hooks/useTunnelDetailsModal";
import { Copy, Save, Check, Server, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";

import { TunnelModalProps } from "@/types/tunnel";

interface TunnelDetailsModalProps extends TunnelModalProps {
    onUpdate: () => void;
}

export function TunnelDetailsModal({ isOpen, onClose, tunnelId, onUpdate }: TunnelDetailsModalProps) {
    const { t } = useI18n();
    const {
        state: { details, loading, description, setDescription, isSaving, copiedKey },
        actions: { handleSaveDescription, copyKey }
    } = useTunnelDetailsModal(tunnelId, isOpen, onUpdate, onClose);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("tunnelDetails.title")}
            description={details?.host_friendly_name}
            icon={<Server />}
            size="lg"
            isLoading={loading || !details}
            footer={
                (details && !loading) ? (
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                        >
                            {t("common.close")}
                        </Button>
                        {details.user_permission !== 'view' && (
                            <Button
                                type="button"
                                onClick={handleSaveDescription}
                                disabled={isSaving}
                            >
                                {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
                                {t("common.saveChanges")}
                            </Button>
                        )}
                    </>
                ) : undefined
            }
        >
            <div className="space-y-5">
                {(loading || !details) ? null : (
                    <>
                        {/* 屬性格:一個外框、四格以細線分隔,取代四塊灰底卡片。
                            Property grid: one frame split by hairlines instead of four grey boxes. */}
                        <dl className="grid grid-cols-2 overflow-hidden rounded-xl bg-surface ring-1 ring-inset ring-border/80 [&>div]:p-3.5 [&>div]:sm:p-4">
                            <div className="border-r border-b border-border/70">
                                <dt className="text-xs text-muted-foreground">{t("tunnelDetails.tunnelId")}</dt>
                                <dd className="mt-1 font-mono text-[15px] tabular-nums text-foreground">#{details.id}</dd>
                            </div>
                            <div className="border-b border-border/70">
                                <dt className="text-xs text-muted-foreground">{t("tunnelDetails.yourPermission")}</dt>
                                <dd className="mt-1 text-[15px] capitalize text-foreground">{details.user_permission || t("tunnels.owner")}</dd>
                            </div>
                            <div className="min-w-0 border-r border-border/70">
                                <dt className="text-xs text-muted-foreground">{t("tunnelDetails.hostFriendlyName")}</dt>
                                <dd className="mt-1 truncate text-[15px] text-foreground">{details.host_friendly_name}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-muted-foreground">{t("tunnelDetails.reversePort")}</dt>
                                <dd className="mt-1 font-mono text-[15px] tabular-nums text-primary">:{details.reverse_port}</dd>
                            </div>
                        </dl>

                        <div className="space-y-2">
                            <Label htmlFor="tunnel-details-description">{t("common.description")}</Label>
                            <Textarea
                                id="tunnel-details-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                disabled={details.user_permission === 'view'}
                                placeholder={details.user_permission === 'view' ? t("tunnelDetails.noDescription") : t("tunnelDetails.descriptionPlaceholder")}
                            />
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label>{t("tunnels.publicKey")}</Label>
                                <Button type="button" variant="ghost" size="xs" onClick={copyKey} className="text-primary hover:text-primary">
                                    {copiedKey ? <Check /> : <Copy />}
                                    {copiedKey ? t("tunnelDetails.copied") : t("tunnelDetails.copyFullKey")}
                                </Button>
                            </div>
                            <div className="flex max-h-32 min-w-0 overflow-y-auto rounded-xl bg-surface p-3 ring-1 ring-inset ring-border/80">
                                <code className="min-w-0 break-all whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
                                    {details.key || t("tunnelDetails.noKey")}
                                </code>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
