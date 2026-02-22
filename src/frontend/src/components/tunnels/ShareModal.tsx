"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Share2, UserPlus, X, Command, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}

export function ShareModal({ isOpen, onClose, tunnelId }: ShareModalProps) {
    const [sharedUsers, setSharedUsers] = useState<any[]>([]);
    const [availableUsers, setAvailableUsers] = useState<any[]>([]);
    const [selectedUser, setSelectedUser] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [unshareConfirm, setUnshareConfirm] = useState<{ isOpen: boolean, userId: number, username: string } | null>(null);
    const { showSuccess, showError } = useToast();

    const fetchUsers = async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const [sharedRes, availableRes] = await Promise.all([
                apiFetch(`/tunnels/shared-users/${tunnelId}`),
                apiFetch(`/tunnels/available-users/${tunnelId}`),
            ]);

            if (sharedRes.ok && availableRes.ok) {
                setSharedUsers((await sharedRes.json()).users);
                setAvailableUsers((await availableRes.json()).users);
            } else {
                showError("Failed to fetch shared users");
            }
        } catch (e: any) {
            showError(e.message || "Failed to fetch users");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchUsers();
            setSelectedUser("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const handleShare = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedUser || !tunnelId) return;

        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}`, {
                method: "POST",
                body: JSON.stringify({ shared_with_user_id: selectedUser }),
            });
            if (res.ok) {
                showSuccess("Tunnel shared successfully");
                setSelectedUser("");
                fetchUsers();
            } else {
                const data = await res.json();
                showError(data.error || "Failed to share tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to share tunnel");
        }
    };

    const handleUpdatePermission = async (userId: number, newPermission: string) => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/tunnels/update-permission/${tunnelId}/${userId}`, {
                method: "PATCH",
                body: JSON.stringify({ permission_type: newPermission }),
            });
            if (res.ok) {
                showSuccess("Permission updated");
                fetchUsers();
            } else {
                const data = await res.json();
                showError(data.error || "Failed to update permission");
            }
        } catch (e: any) {
            showError(e.message || "Failed to update permission");
        }
    };

    const handleUnshare = async () => {
        if (!unshareConfirm || !tunnelId) return;
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${unshareConfirm.userId}`, {
                method: "DELETE",
            });
            if (res.ok) {
                showSuccess(`Tunnel unshared from ${unshareConfirm.username}`);
                fetchUsers();
            } else {
                showError("Failed to unshare tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to unshare tunnel");
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Share Tunnel" size="lg" isLoading={loading}>
                <div className="space-y-6">
                    <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
                        <span className="mt-0.5 shrink-0 text-lg">💡</span>
                        <span>Grant other users access to this tunnel. <strong>View</strong> allows seeing details, <strong>Edit</strong> allows managing connections and settings, and <strong>Admin</strong> grants full control including deleting the tunnel and managing shares.</span>
                    </div>

                    <form onSubmit={handleShare} className="flex gap-2">
                        <Select
                            value={selectedUser}
                            onValueChange={setSelectedUser}
                            disabled={availableUsers.length === 0}
                        >
                            <SelectTrigger className="flex-1">
                                <SelectValue placeholder={availableUsers.length === 0 ? "No available users to share with" : "-- Select User --"} />
                            </SelectTrigger>
                            <SelectContent>
                                {availableUsers.map((u) => (
                                    <SelectItem key={u.id} value={u.id.toString()}>
                                        {u.username}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button
                            type="submit"
                            disabled={!selectedUser}
                        >
                            <UserPlus size={16} className="mr-2" />
                            Share
                        </Button>
                    </form>

                    <div className="bg-card border border-border rounded-md overflow-hidden">
                        {loading ? null : sharedUsers.length === 0 ? (
                            <div className="p-8 text-center text-muted-foreground flex flex-col items-center">
                                <Share2 size={32} className="text-muted mb-2 opacity-50" />
                                <p>This tunnel is not shared with anyone.</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <div className="bg-muted/40 px-4 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    Currently Shared With
                                </div>
                                <table className="min-w-full divide-y divide-border table-fixed">
                                    <thead className="bg-muted/20 border-b border-border">
                                        <tr>
                                            <th className="px-4 py-3 text-left w-[40%] text-xs font-medium text-muted-foreground uppercase tracking-wider">User</th>
                                            <th className="px-4 py-3 text-center w-[40%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Permission</th>
                                            <th className="px-4 py-3 text-right w-[20%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-card divide-y divide-border">
                                        {sharedUsers.map((su) => (
                                            <tr key={su.id} className="hover:bg-muted/50 transition-colors">
                                                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-foreground">
                                                    {su.username}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                                    <div className="inline-block text-left">
                                                        <Select
                                                            value={su.permission_type || (su.can_admin_tunnel ? "admin" : su.can_edit_tunnel ? "edit" : "view")}
                                                            onValueChange={(val) => handleUpdatePermission(su.id, val)}
                                                        >
                                                            <SelectTrigger className="h-8 w-[100px] text-xs">
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="view">View</SelectItem>
                                                                <SelectItem value="edit">Edit</SelectItem>
                                                                <SelectItem value="admin">Admin</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-right">
                                                    <button
                                                        onClick={() => setUnshareConfirm({ isOpen: true, userId: su.id, username: su.username })}
                                                        className="text-destructive hover:text-destructive/90 transition-colors bg-destructive/10 hover:bg-destructive/20 p-1.5 rounded-md"
                                                        title="Unshare Tunnel"
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={unshareConfirm !== null}
                onClose={() => setUnshareConfirm(null)}
                onConfirm={handleUnshare}
                title="Unshare Tunnel"
                message={`Are you sure you want to unshare this tunnel with ${unshareConfirm?.username}? They will lose all access.`}
                confirmText="Unshare"
                isDestructive={true}
            />
        </>
    );
}
