"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

interface TargetUser {
    id: number;
    username: string;
    created_by: string | null;
    created_by_id: number | null;
}

interface ConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}

export function ConfigModal({ isOpen, onClose, tunnelId }: ConfigModalProps) {
    const [configContent, setConfigContent] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [targetUsers, setTargetUsers] = useState<TargetUser[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string>("");
    const { showError } = useToast();

    const fetchConfig = useCallback(async (usernameId?: string) => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            let url = `/tunnels/server/config/${tunnelId}`;
            if (usernameId && usernameId !== "all") {
                url += `?username_id=${usernameId}`;
            }
            const res = await apiFetch(url);
            if (res.ok) {
                const data = await res.json();
                const users: TargetUser[] = data.usernames ?? [];

                // On initial load (no usernameId), populate users and auto-select first
                if (!usernameId) {
                    setTargetUsers(users);
                    if (users.length > 0) {
                        // Auto-select first user and re-fetch with that filter
                        const firstId = String(users[0].id);
                        setSelectedUserId(firstId);
                        // Re-fetch with the first user selected
                        setLoading(false);
                        fetchConfig(firstId);
                        return;
                    } else {
                        // No target users — just show server-only config
                        setSelectedUserId("");
                    }
                }

                setConfigContent(data.config ?? "# No SSH config available.");
            } else {
                showError("Failed to load SSH configuration");
            }
        } catch (e: any) {
            showError(e.message || "Failed to load configuration");
        } finally {
            setLoading(false);
        }
    }, [tunnelId, showError]);

    useEffect(() => {
        if (isOpen && tunnelId) {
            setTargetUsers([]);
            setSelectedUserId("");
            setConfigContent("");
            fetchConfig();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const handleUserChange = (value: string) => {
        setSelectedUserId(value);
        fetchConfig(value);
    };

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
                                {targetUsers.map((u) => (
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
