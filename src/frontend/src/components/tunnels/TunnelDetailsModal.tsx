"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Copy, Save, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface TunnelDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
    onUpdate: () => void;
}

export function TunnelDetailsModal({ isOpen, onClose, tunnelId, onUpdate }: TunnelDetailsModalProps) {
    const [details, setDetails] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [description, setDescription] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [copiedKey, setCopiedKey] = useState(false);
    const { showSuccess, showError } = useToast();

    useEffect(() => {
        if (isOpen && tunnelId) {
            const fetchDetails = async () => {
                setLoading(true);
                try {
                    const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setDetails(data);
                        setDescription(data.description || "");
                    } else {
                        showError("Failed to fetch tunnel details");
                    }
                } catch (e: any) {
                    showError(e.message || "Failed to fetch tunnel details");
                } finally {
                    setLoading(false);
                }
            };
            fetchDetails();
        }
    }, [isOpen, tunnelId, showError]);

    const handleSaveDescription = async () => {
        if (!tunnelId) return;
        setIsSaving(true);
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`, {
                method: "PATCH",
                body: JSON.stringify({ description }),
            });
            if (res.ok) {
                showSuccess("Description updated");
                onUpdate();
                onClose();
            } else {
                showError("Failed to update description");
            }
        } catch (e: any) {
            showError(e.message || "Failed to update description");
        } finally {
            setIsSaving(false);
        }
    };

    const copyKey = () => {
        if (details?.key) {
            navigator.clipboard.writeText(details.key);
            setCopiedKey(true);
            setTimeout(() => setCopiedKey(false), 2000);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Tunnel Details"
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
                            Close
                        </Button>
                        {details.user_permission !== 'view' && (
                            <Button
                                type="button"
                                onClick={handleSaveDescription}
                                disabled={isSaving}
                            >
                                {isSaving ? (
                                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2"></div>
                                ) : (
                                    <Save size={16} className="mr-2" />
                                )}
                                Save Changes
                            </Button>
                        )}
                    </>
                ) : undefined
            }
        >
            <div className="space-y-6">
                {(loading || !details) ? null : (
                    <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="bg-muted p-4 rounded-lg border border-border">
                                <p className="text-sm font-medium text-muted-foreground mb-1">Tunnel ID</p>
                                <p className="font-semibold text-foreground">{details.id}</p>
                            </div>
                            <div className="bg-muted p-4 rounded-lg border border-border">
                                <p className="text-sm font-medium text-muted-foreground mb-1">Your Permission</p>
                                <p className="font-semibold text-foreground capitalize">{details.user_permission || "Owner"}</p>
                            </div>
                            <div className="bg-muted p-4 rounded-lg border border-border">
                                <p className="text-sm font-medium text-muted-foreground mb-1">Host Friendly Name</p>
                                <p className="font-semibold text-foreground">{details.host_friendly_name}</p>
                            </div>
                            <div className="bg-muted p-4 rounded-lg border border-border">
                                <p className="text-sm font-medium text-muted-foreground mb-1">Reverse Port</p>
                                <p className="font-semibold text-foreground text-lg text-primary">{details.reverse_port}</p>
                            </div>
                        </div>

                        <div>
                            <Label className="block mb-2">Description</Label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                disabled={details.user_permission === 'view'}
                                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                                placeholder={details.user_permission === 'view' ? "No description available" : "Enter an optional description..."}
                            />
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <Label className="text-sm font-medium text-foreground">Public Key</Label>
                                <button
                                    type="button"
                                    onClick={copyKey}
                                    className="text-sm flex items-center gap-1 text-primary hover:text-primary/80 font-medium transition-colors"
                                >
                                    {copiedKey ? <Check size={14} /> : <Copy size={14} />}
                                    {copiedKey ? "Copied!" : "Copy Full Key"}
                                </button>
                            </div>
                            <div className="bg-muted/50 border border-border rounded-md p-3 max-h-32 flex overflow-y-auto min-w-0">
                                <code className="text-xs text-muted-foreground break-all whitespace-pre-wrap font-mono min-w-0">
                                    {details.key || "No key available"}
                                </code>
                            </div>
                        </div>

                    </>
                )}
            </div>
        </Modal>
    );
}
