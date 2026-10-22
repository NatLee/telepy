"use client";

import React from "react";
import { FileCode2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { TunnelModalProps, TargetUser } from "@/types/tunnel";
import { useConfigModal } from "@/hooks/useConfigModal";
import { useI18n } from "@/lib/i18n";

type ConfigModalProps = TunnelModalProps;

export function ConfigModal({ isOpen, onClose, tunnelId }: ConfigModalProps) {
    const { t, tn } = useI18n();
    const {
        state: { configContent, loading, targetUsers, selectedUserId },
        actions: { handleUserChange }
    } = useConfigModal(isOpen, tunnelId);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("config.title")}
            description={tn("config.addToConfig", { path: <code className="rounded-md bg-muted px-1.5 py-px font-mono text-[0.85em] text-foreground">~/.ssh/config</code> })}
            icon={<FileCode2 />}
            size="2xl"
            isLoading={loading}
        >
            <div className="space-y-4">
                <Callout tone="tip">{t("config.banner")}</Callout>

                {/* Target User Selector — only show when users exist */}
                {targetUsers.length > 0 && (
                    <div className="flex items-center gap-3">
                        <label className="text-sm text-muted-foreground whitespace-nowrap">
                            {t("config.targetUser")}
                        </label>
                        <Select value={selectedUserId} onValueChange={handleUserChange}>
                            <SelectTrigger className="h-9 flex-1 text-sm">
                                <SelectValue placeholder={t("config.selectTargetUser")} />
                            </SelectTrigger>
                            <SelectContent>
                                {targetUsers.length > 1 && (
                                    <SelectItem value="all">{t("config.allUsers", { count: targetUsers.length })}</SelectItem>
                                )}
                                {targetUsers.map((u: TargetUser) => (
                                    <SelectItem key={u.id} value={String(u.id)}>
                                        {u.username}
                                        {u.created_by && ` ${t("common.byUserHashTag", { user: u.created_by, id: u.created_by_id ?? "" })}`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {loading ? null : <CodeBlock language="txt" value={configContent} />}
            </div>
        </Modal>
    );
}
