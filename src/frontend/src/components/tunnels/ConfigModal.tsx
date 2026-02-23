"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { TunnelModalProps, TargetUser } from "@/types/tunnel";
import { useConfigModal } from "@/hooks/useConfigModal";

interface ConfigModalProps extends TunnelModalProps { }

export function ConfigModal({ isOpen, onClose, tunnelId }: ConfigModalProps) {
    const {
        state: { configContent, loading, targetUsers, selectedUserId },
        actions: { handleUserChange }
    } = useConfigModal(isOpen, tunnelId);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Reverse Server Configuration" size="lg" isLoading={loading}>
            <div className="space-y-4">
                <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
                    <span className="mt-0.5 shrink-0 text-lg">💡</span>
                    <span>This configuration block allows you to securely access this tunnel from your local machine using standard SSH, exactly as if the service were exposed on your local network.</span>
                </div>

                {/* Target User Selector — only show when users exist */}
                {targetUsers.length > 0 && (
                    <div className="flex items-center gap-3">
                        <label className="text-sm font-medium text-foreground whitespace-nowrap">
                            Target User:
                        </label>
                        <Select value={selectedUserId} onValueChange={handleUserChange}>
                            <SelectTrigger className="h-9 flex-1 text-sm">
                                <SelectValue placeholder="Select target user" />
                            </SelectTrigger>
                            <SelectContent>
                                {targetUsers.length > 1 && (
                                    <SelectItem value="all">All Users ({targetUsers.length})</SelectItem>
                                )}
                                {targetUsers.map((u: TargetUser) => (
                                    <SelectItem key={u.id} value={String(u.id)}>
                                        {u.username}
                                        {u.created_by && ` (By: ${u.created_by} #${u.created_by_id})`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                <p className="text-sm text-muted-foreground">
                    Add this to your local <code className="bg-muted text-foreground px-1.5 py-0.5 rounded border border-border">~/.ssh/config</code> file.
                </p>
                {loading ? null : (
                    <div className="max-h-[50vh] overflow-auto">
                        <CodeBlock language="txt" value={configContent} />
                    </div>
                )}
            </div>
        </Modal>
    );
}
