"use client";

import React, { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Copy, Plus, Key as KeyIcon, Trash2, Edit3, Settings, AlertCircle, RefreshCw, Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { isValidSSHKey, getHostFriendlyNameFromKey } from "@/lib/utils";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { WebSocketStatusBadge } from "@/components/ui/WebSocketStatusBadge";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

export default function UserKeysPage() {
    const [keys, setKeys] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const { showSuccess, showError } = useToast();

    // Modals state
    const [addModalOpen, setAddModalOpen] = useState(false);
    const [detailsModal, setDetailsModal] = useState<{ isOpen: boolean, key: any }>({ isOpen: false, key: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean, keyId: number | null, name: string }>({ isOpen: false, keyId: null, name: "" });

    // Add Key Form state
    const [newKeyContent, setNewKeyContent] = useState("");
    const [newKeyName, setNewKeyName] = useState("");
    const [newKeyDescription, setNewKeyDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Edit Description state
    const [editDescription, setEditDescription] = useState("");
    const [isUpdating, setIsUpdating] = useState(false);

    const fetchKeys = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/reverse/user/keys");
            if (res.ok) {
                setKeys(await res.json());
            } else {
                showError("Failed to fetch keys");
            }
        } catch (e: any) {
            showError(e.message || "Failed to fetch keys");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchKeys();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const key = e.target.value;
        setNewKeyContent(key);
        if (!newKeyName && isValidSSHKey(key)) {
            setNewKeyName(getHostFriendlyNameFromKey(key, ""));
        }
    };

    const handleAddKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isValidSSHKey(newKeyContent)) {
            showError("Invalid SSH Public Key format.");
            return;
        }
        setIsSubmitting(true);
        try {
            const payload = {
                key: newKeyContent,
                host_friendly_name: newKeyName || "Unnamed Key",
                description: newKeyDescription,
            };
            // To add a key, we need /api/reverse/create/key/<token> but this is for tunnels.
            // Wait, is there a direct API to add user keys? The old keys.js uses `fetch('/api/reverse/user/keys')` via POST? No, wait.
            // If adding a key is the same as the tunnel wizard, we get a token then create via /api/reverse/create/key/<token>.
            // The old keys.js does:
            // 1. /api/reverse/issue/token
            // 2. /api/reverse/create/key/${token}
            const tokenRes = await apiFetch("/api/reverse/issue/token");
            if (!tokenRes.ok) throw new Error("Failed to get issue token");
            const { token } = await tokenRes.json();

            const createRes = await apiFetch(`/api/reverse/create/key/${token}`, {
                method: "POST",
                body: JSON.stringify(payload),
            });

            if (createRes.ok) {
                showSuccess("Key added successfully");
                setAddModalOpen(false);
                setNewKeyContent("");
                setNewKeyName("");
                setNewKeyDescription("");
                fetchKeys();
            } else {
                const err = await createRes.json();
                showError(err.error || "Failed to add key");
            }
        } catch (e: any) {
            showError(e.message || "Failed to add key");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteConfirm.keyId) return;
        try {
            const res = await apiFetch(`/api/reverse/user/keys/${deleteConfirm.keyId}`, {
                method: "DELETE",
            });
            if (res.ok) {
                showSuccess(`Key '${deleteConfirm.name}' deleted`);
                fetchKeys();
            } else {
                showError("Failed to delete key");
            }
        } catch (e: any) {
            showError(e.message || "Failed to delete key");
        }
    };

    const handleUpdateDescription = async () => {
        if (!detailsModal.key?.id) return;
        setIsUpdating(true);
        try {
            const res = await apiFetch(`/api/reverse/user/keys/${detailsModal.key.id}`, {
                method: "PATCH",
                body: JSON.stringify({ description: editDescription }),
            });
            if (res.ok) {
                showSuccess("Description updated");
                setDetailsModal({ isOpen: false, key: null });
                fetchKeys();
            } else {
                showError("Failed to update description");
            }
        } catch (e: any) {
            showError(e.message || "Failed to update description");
        } finally {
            setIsUpdating(false);
        }
    };

    return (
        <div className="animate-fade-in-up">
            <div className="sm:flex sm:items-center sm:justify-between mb-8">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-foreground flex items-center gap-2 tracking-tight">
                        <KeyIcon className="text-primary animate-float" />
                        SSH Keys
                        <TooltipProvider delayDuration={100}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button className="text-muted-foreground hover:text-primary transition-colors focus:outline-none" aria-label="About SSH Keys">
                                        <Info size={18} />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs text-sm" sideOffset={8}>
                                    <p>
                                        Your SSH public keys are registered here to authorize you on the Telepy SSH server. When you connect via terminal, the server verifies your identity using these keys. Add your <code className="bg-muted text-foreground px-1 rounded">~/.ssh/id_rsa.pub</code> or <code className="bg-muted text-foreground px-1 rounded">id_ed25519.pub</code> to get started.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <WebSocketStatusBadge />
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Manage your personal SSH public keys. Each key authorizes a machine to connect. Use standard OpenSSH format (<code className="bg-muted px-1 rounded text-xs">ssh-rsa</code>, <code className="bg-muted px-1 rounded text-xs">ssh-ed25519</code>, etc.).
                    </p>
                </div>
                <div className="mt-4 sm:mt-0 flex gap-2">
                    <Button variant="outline" onClick={fetchKeys} disabled={loading} aria-label="Refresh keys">
                        <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                    <Button onClick={() => setAddModalOpen(true)}>
                        <Plus size={16} className="-ml-1 mr-2" />
                        Add Key
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {loading ? (
                    <div className="col-span-full py-12 flex justify-center text-muted-foreground">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mr-3"></div>
                        Loading keys...
                    </div>
                ) : keys.length === 0 ? (
                    <div className="col-span-full py-16 text-center text-muted-foreground bg-card border-2 border-dashed border-border rounded-lg shadow-sm flex flex-col items-center">
                        <KeyIcon size={48} className="text-muted mb-4 opacity-50" />
                        <h3 className="text-lg font-semibold text-foreground">No keys found</h3>
                        <p className="mt-1 text-sm text-muted-foreground max-w-sm">Add an SSH public key to authorize yourself on the Telepy SSH server and start connecting.</p>
                        <div className="mt-6">
                            <Button onClick={() => setAddModalOpen(true)}>
                                <Plus size={16} className="mr-2" />
                                Add Key
                            </Button>
                        </div>
                    </div>
                ) : (
                    keys.map((k) => (
                        <Card key={k.id} className="flex flex-col h-full hover:shadow-md transition-shadow">
                            <CardHeader className="p-4 border-b border-border pb-3">
                                <CardTitle className="flex justify-between items-start text-lg pr-2 truncate" title={k.host_friendly_name}>
                                    {k.host_friendly_name}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-4 flex-1">
                                <div className="bg-muted/50 rounded p-2 mb-3">
                                    <p className="text-[11px] text-muted-foreground font-mono break-all line-clamp-2" title={k.key ?? ''}>
                                        {k.key ? `${k.key.substring(0, 80)}...` : '—'}
                                    </p>
                                </div>
                                {k.description && (
                                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{k.description}</p>
                                )}
                            </CardContent>
                            <CardFooter className="bg-muted/10 p-3 flex justify-between gap-1.5 border-t border-border mt-auto rounded-b-xl">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setDetailsModal({ isOpen: true, key: k });
                                        setEditDescription(k.description || "");
                                    }}
                                    className="text-primary hover:text-primary/90 flex items-center gap-1.5 h-8 text-xs flex-1 bg-primary/5 hover:bg-primary/10 transition-colors"
                                >
                                    <Edit3 size={14} /> Details
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setDeleteConfirm({ isOpen: true, keyId: k.id, name: k.host_friendly_name })}
                                    className="text-destructive hover:text-destructive/90 flex items-center gap-1.5 h-8 text-xs flex-1 bg-destructive/5 hover:bg-destructive/10 transition-colors"
                                >
                                    <Trash2 size={14} /> Delete
                                </Button>
                            </CardFooter>
                        </Card>
                    ))
                )}
            </div>

            {/* Add Key Modal */}
            <Modal isOpen={addModalOpen} onClose={() => setAddModalOpen(false)} title="Add SSH Key" size="lg">
                <form onSubmit={handleAddKey} className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-foreground">
                            SSH Public Key <span className="text-destructive">*</span>
                        </label>
                        <textarea
                            required
                            rows={4}
                            value={newKeyContent}
                            onChange={handleKeyChange}
                            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                            placeholder="ssh-rsa AAAAB3NzaC1yc... user@machine"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-foreground">
                            Host Friendly Name <span className="text-destructive">*</span>
                        </label>
                        <Input
                            type="text"
                            required
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                            placeholder="e.g. My Laptop Key"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-foreground">
                            Description <span className="text-muted-foreground font-normal">(Optional)</span>
                        </label>
                        <textarea
                            value={newKeyDescription}
                            onChange={(e) => setNewKeyDescription(e.target.value)}
                            rows={2}
                            className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            placeholder="Optional notes about this key..."
                        />
                    </div>
                    <div className="flex justify-end pt-4 space-x-3">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setAddModalOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? "Adding..." : "Add Key"}
                        </Button>
                    </div>
                </form>
            </Modal>

            {/* Details / Edit Modal */}
            <Modal isOpen={detailsModal.isOpen} onClose={() => setDetailsModal({ isOpen: false, key: null })} title="Key Details" size="lg">
                {detailsModal.key && (
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <p className="text-sm font-medium text-muted-foreground leading-none">Host Friendly Name</p>
                            <p className="font-semibold text-foreground">{detailsModal.key.host_friendly_name}</p>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <label className="text-sm font-medium text-foreground">Public Key</label>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => navigator.clipboard.writeText(detailsModal.key.key)}
                                    className="h-8 px-2 text-xs text-primary"
                                >
                                    <Copy size={12} className="mr-1" /> Copy
                                </Button>
                            </div>
                            <div className="bg-muted rounded-md p-3 max-h-32 flex overflow-y-auto border border-border">
                                <code className="text-xs text-muted-foreground break-all whitespace-pre-wrap font-mono">
                                    {detailsModal.key.key || "No key available"}
                                </code>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium text-foreground block">Description</label>
                            <textarea
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                rows={3}
                                className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                placeholder="Optional notes about this key..."
                            />
                        </div>

                        <div className="flex justify-end pt-4 space-x-3">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setDetailsModal({ isOpen: false, key: null })}
                            >
                                Close
                            </Button>
                            <Button
                                type="button"
                                onClick={handleUpdateDescription}
                                disabled={isUpdating}
                            >
                                {isUpdating ? "Saving..." : "Save Description"}
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, keyId: null, name: "" })}
                onConfirm={handleDelete}
                title="Delete Key"
                message={`Are you sure you want to delete the key '${deleteConfirm.name}'? Connections depending on this key will fail.`}
                confirmText="Delete"
                isDestructive={true}
            />
        </div>
    );
}
