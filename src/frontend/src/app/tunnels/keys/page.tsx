"use client";

/**
 * SSH 金鑰管理頁：個人公鑰列表、新增/刪除/詳情、列表與卡片視圖切換。
 * SSH keys management page: list, add/delete/detail, list and card view toggle.
 */
import React from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Copy, Plus, Key as KeyIcon, Trash2, Edit3, RefreshCw, Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
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
import { ViewToggle } from "@/components/ui/ViewToggle";

import { useKeysPage } from "@/hooks/useKeysPage";

export default function UserKeysPage() {
    const { state, actions } = useKeysPage();
    const {
        keys,
        loading,
        viewMode, setViewMode,
        addModalOpen, setAddModalOpen,
        detailsModal, setDetailsModal,
        deleteConfirm, setDeleteConfirm,
        newKeyContent,
        newKeyName, setNewKeyName,
        newKeyDescription, setNewKeyDescription,
        isSubmitting,
        editDescription, setEditDescription,
        isUpdating,
        isEditingDesc, setIsEditingDesc
    } = state;

    const {
        fetchKeys,
        handleKeyChange,
        handleAddKey,
        handleDelete,
        handleUpdateDescription
    } = actions;

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
                <div className="mt-4 sm:mt-0 flex gap-2 items-center">
                    <div className="hidden min-[1200px]:flex items-center">
                        <ViewToggle value={viewMode} onChange={setViewMode} storageKey="ssh-keys-view" />
                        <div className="h-5 w-px bg-border mx-2"></div>
                    </div>
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

            {loading ? (
                <div className="py-12 flex justify-center text-muted-foreground">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mr-3"></div>
                    Loading keys...
                </div>
            ) : keys.length === 0 ? (
                <div className="py-16 text-center text-muted-foreground bg-card border-2 border-dashed border-border rounded-lg shadow-sm flex flex-col items-center">
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
            ) : viewMode === "card" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {keys.map((keyItem) => (
                        <Card key={keyItem.id} className="flex flex-col h-full hover:shadow-md transition-shadow">
                            <CardHeader className="p-4 border-b border-border pb-3">
                                <CardTitle className="flex justify-between items-start text-lg pr-2 truncate" title={keyItem.host_friendly_name}>
                                    {keyItem.host_friendly_name}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-4 flex-1">
                                <div className="bg-muted/50 rounded p-2 mb-3">
                                    <p className="text-[11px] text-muted-foreground font-mono break-all line-clamp-2" title={keyItem.key ?? ''}>
                                        {keyItem.key ? `${keyItem.key.substring(0, 80)}...` : '—'}
                                    </p>
                                </div>
                                {keyItem.description && (
                                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{keyItem.description}</p>
                                )}
                            </CardContent>
                            <CardFooter className="bg-muted/10 p-3 flex justify-between gap-1.5 border-t border-border mt-auto rounded-b-xl">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setDetailsModal({ isOpen: true, key: keyItem });
                                        setEditDescription(keyItem.description || "");
                                        setIsEditingDesc(false); // Reset editing state
                                    }}
                                    className="text-primary hover:text-primary/90 flex items-center gap-1.5 h-8 text-xs flex-1 bg-primary/5 hover:bg-primary/10 transition-colors"
                                >
                                    <Edit3 size={14} /> Details
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setDeleteConfirm({ isOpen: true, keyId: keyItem.id, name: keyItem.host_friendly_name })}
                                    className="text-destructive hover:text-destructive/90 flex items-center gap-1.5 h-8 text-xs flex-1 bg-destructive/5 hover:bg-destructive/10 transition-colors"
                                >
                                    <Trash2 size={14} /> Delete
                                </Button>
                            </CardFooter>
                        </Card>
                    ))}
                </div>
            ) : (
                <div className="border border-border rounded-lg overflow-x-auto bg-card shadow-sm">
                    <table className="min-w-full divide-y divide-border">
                        <thead className="bg-muted/50">
                            <tr>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Name</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Key Preview</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Description</th>
                                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border bg-card">
                            {keys.map((keyItem) => (
                                <tr key={keyItem.id} className="hover:bg-muted/50 transition-colors">
                                    <td className="px-4 py-3 text-sm font-medium text-foreground whitespace-nowrap">
                                        {keyItem.host_friendly_name}
                                    </td>
                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <div className="bg-muted/50 rounded px-2 py-1 font-mono text-[11px] truncate text-muted-foreground max-w-[200px]" title={keyItem.key ?? ''}>
                                            {keyItem.key ? `${keyItem.key.substring(0, 20)}...` : '—'}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="text-xs text-muted-foreground line-clamp-1 max-w-[250px]" title={keyItem.description || ''}>
                                            {keyItem.description || '—'}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 whitespace-nowrap text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => {
                                                    setDetailsModal({ isOpen: true, key: keyItem });
                                                    setEditDescription(keyItem.description || "");
                                                    setIsEditingDesc(false); // Reset editing state
                                                }}
                                                className="text-primary hover:text-primary/90 flex items-center gap-1.5 h-8 px-2 text-xs hover:bg-primary/10 transition-colors"
                                            >
                                                <Edit3 size={14} /> Details
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setDeleteConfirm({ isOpen: true, keyId: keyItem.id, name: keyItem.host_friendly_name })}
                                                className="text-destructive hover:text-destructive/90 flex items-center gap-1.5 h-8 px-2 text-xs hover:bg-destructive/10 transition-colors"
                                            >
                                                <Trash2 size={14} /> Delete
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

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
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-foreground">
                            Description <span className="text-muted-foreground font-normal">(Optional)</span>
                        </label>
                        <Input
                            type="text"
                            value={newKeyDescription}
                            onChange={(e) => setNewKeyDescription(e.target.value)}
                            placeholder="e.g. Used for connecting from home office"
                            className="text-sm"
                        />
                    </div>
                </form>
                <div className="mt-6 flex justify-end gap-3">
                    <Button variant="outline" onClick={() => setAddModalOpen(false)} disabled={isSubmitting}>Cancel</Button>
                    <Button onClick={handleAddKey} disabled={isSubmitting || !newKeyContent || !newKeyName}>
                        {isSubmitting ? (
                            <>
                                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                Adding...
                            </>
                        ) : 'Add SSH Key'}
                    </Button>
                </div>
            </Modal>

            {/* View/Edit Key Details Modal */}
            <Modal
                isOpen={detailsModal.isOpen}
                onClose={() => setDetailsModal({ isOpen: false, key: null })}
                title="SSH Key Details"
                size="lg"
            >
                {detailsModal.key && (
                    <div className="space-y-6">
                        <div>
                            <h3 className="text-sm font-medium text-muted-foreground mb-1">Friendly Name</h3>
                            <p className="font-mono bg-muted/30 p-2 rounded border border-border">{detailsModal.key.host_friendly_name}</p>
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-muted-foreground mb-1">Public Key</h3>
                            <CodeBlock value={detailsModal.key.key || "No key available"} language="ssh" />
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-muted-foreground mb-1">Description</h3>
                            {isEditingDesc ? (
                                <div className="space-y-2 mt-2">
                                    <textarea
                                        value={editDescription}
                                        onChange={(e) => setEditDescription(e.target.value)}
                                        rows={3}
                                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                        placeholder="Add a description..."
                                    />
                                    <div className="flex justify-end gap-2">
                                        <Button size="sm" variant="outline" onClick={() => {
                                            setIsEditingDesc(false);
                                            setEditDescription(detailsModal.key?.description || "");
                                        }} disabled={isUpdating}>
                                            Cancel
                                        </Button>
                                        <Button size="sm" onClick={() => handleUpdateDescription()} disabled={isUpdating}>
                                            {isUpdating ? <RefreshCw size={14} className="animate-spin mr-1" /> : 'Save'}
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex justify-between items-start bg-muted/10 p-3 rounded border border-border">
                                    <p className="text-sm whitespace-pre-wrap flex-1">{detailsModal.key.description || <span className="text-muted-foreground italic">No description provided.</span>}</p>
                                    <Button variant="ghost" size="sm" onClick={() => setIsEditingDesc(true)} className="h-6 px-2 text-xs ml-2">
                                        <Edit3 size={12} className="mr-1" /> Edit
                                    </Button>
                                </div>
                            )}
                        </div>
                        <div className="pt-4 flex justify-end">
                            <Button variant="outline" onClick={() => setDetailsModal({ isOpen: false, key: null })}>Close</Button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Delete Confirmation */}
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
