"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

interface ConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}

export function ConfigModal({ isOpen, onClose, tunnelId }: ConfigModalProps) {
    const [configContent, setConfigContent] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const { showError } = useToast();

    useEffect(() => {
        if (isOpen && tunnelId) {
            const fetchConfig = async () => {
                setLoading(true);
                try {
                    const res = await apiFetch(`/tunnels/server/config/${tunnelId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setConfigContent(data.config ?? "# No SSH config available.");
                    } else {
                        showError("Failed to load SSH configuration");
                    }
                } catch (e: any) {
                    showError(e.message || "Failed to load configuration");
                } finally {
                    setLoading(false);
                }
            };
            fetchConfig();
        }
    }, [isOpen, tunnelId, showError]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Reverse Server Configuration" size="lg" isLoading={loading}>
            <div className="space-y-4">
                <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
                    <span className="mt-0.5 shrink-0 text-lg">💡</span>
                    <span>This configuration block allows you to securely access this tunnel from your local machine using standard SSH, exactly as if the service were exposed on your local network.</span>
                </div>
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
