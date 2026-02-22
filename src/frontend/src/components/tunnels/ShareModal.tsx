"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { apiFetch } from "@/lib/api";
import { useNotificationWebSocket } from "@/lib/websocket";
import { useToast } from "@/components/ui/Toast";
import { Share2, UserPlus, X, Command, Shield, Users, Edit2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
    readOnly?: boolean;
}

interface ReverseServerUsername {
    id: number;
    username: string;
    created_by?: string;
    created_by_id?: number;
}

export function ShareModal({ isOpen, onClose, tunnelId, readOnly = false }: ShareModalProps) {
    const [sharedUsers, setSharedUsers] = useState<any[]>([]);
    const [availableUsers, setAvailableUsers] = useState<any[]>([]);
    const [selectedUser, setSelectedUser] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [unshareConfirm, setUnshareConfirm] = useState<{ isOpen: boolean, userId: number, username: string } | null>(null);
    const [tunnelUsernames, setTunnelUsernames] = useState<ReverseServerUsername[]>([]);
    const [selectedAllowedIds, setSelectedAllowedIds] = useState<number[]>([]);
    const [editTargetUsersModal, setEditTargetUsersModal] = useState<{ userId: number, username: string, allowedIds: number[] } | null>(null);
    const { showSuccess, showError } = useToast();
    const { lastMessage } = useNotificationWebSocket();

    const fetchUsers = async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const [sharedRes, availableRes, usernamesRes] = await Promise.all([
                apiFetch(`/tunnels/shared-users/${tunnelId}`),
                apiFetch(`/tunnels/available-users/${tunnelId}`),
                apiFetch(`/api/reverse/server/${tunnelId}/usernames`),
            ]);

            if (sharedRes.ok && availableRes.ok) {
                setSharedUsers((await sharedRes.json()).users);
                setAvailableUsers((await availableRes.json()).users);
            } else {
                showError("Failed to fetch shared users");
            }
            if (usernamesRes.ok) {
                const data = await usernamesRes.json();
                setTunnelUsernames(data?.usernames ?? []);
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

    // Handle WebSocket updates for shares, permissions, and allowed usernames
    useEffect(() => {
        if (!lastMessage?.message || !isOpen || !tunnelId) return;
        const { action, tunnel_id } = lastMessage.message;
        if ((action === "TUNNEL-SHARED" || action === "TUNNEL-UNSHARED" || action === "TUNNEL-PERMISSION-UPDATED" || action === "TUNNEL-USERNAMES-UPDATED") && tunnel_id === tunnelId) {
            fetchUsers();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastMessage, isOpen, tunnelId]);

    const handleShare = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedUser || !tunnelId) return;

        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}`, {
                method: "POST",
                body: JSON.stringify({
                    shared_with_user_id: selectedUser,
                    allowed_target_username_ids: selectedAllowedIds.length > 0 ? selectedAllowedIds : undefined
                }),
            });
            if (res.ok) {
                showSuccess("Tunnel shared successfully");
                setSelectedUser("");
                setSelectedAllowedIds([]);
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
                // Success toast is handled by WebSocket notification
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
                // Success toast is handled by WebSocket notification
                setUnshareConfirm(null);
                fetchUsers();
            } else {
                showError("Failed to unshare tunnel");
            }
        } catch (e: any) {
            showError(e.message || "Failed to unshare tunnel");
        }
    };

    const handleSaveAllowed = async () => {
        if (!tunnelId || !editTargetUsersModal) return;
        try {
            const res = await apiFetch(`/tunnels/share/${tunnelId}/${editTargetUsersModal.userId}/allowed-usernames`, {
                method: "PATCH",
                body: JSON.stringify({ allowed_target_username_ids: editTargetUsersModal.allowedIds }),
            });
            if (res.ok) {
                // Success toast is handled by WebSocket notification
                setEditTargetUsersModal(null);
                fetchUsers();
            } else {
                showError("Failed to update allowed users");
            }
        } catch (e: any) {
            showError(e.message || "Failed to update allowed users");
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title={readOnly ? "Tunnel Permissions" : "Share Tunnel"} size="lg" isLoading={loading}>
                <div className="space-y-6">
                    <div className="bg-card border border-border shadow-sm rounded-lg overflow-hidden text-sm">
                        <div className="bg-muted/40 px-4 py-2.5 border-b border-border flex items-center gap-2 font-medium text-foreground">
                            <Shield size={16} className="text-primary" />
                            <span>Permission Matrix</span>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left">
                                <thead>
                                    <tr className="bg-muted/50 border-b border-border text-xs text-muted-foreground">
                                        <th className="px-4 py-2 font-semibold text-left">Role</th>
                                        <th className="px-3 py-2 font-medium">View Tunnels</th>
                                        <th className="px-3 py-2 font-medium">Edit tunnel configurations</th>
                                        <th className="px-3 py-2 font-medium">Manage Target Users</th>
                                        <th className="px-3 py-2 font-medium">Share Tunnels</th>
                                        <th className="px-3 py-2 font-medium">Delete Tunnels</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border border-b border-border text-center bg-card">
                                    <tr className="hover:bg-muted/30 transition-colors">
                                        <td className="px-4 py-2 font-medium text-left text-foreground">Admin</td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                    </tr>
                                    <tr className="hover:bg-muted/30 transition-colors">
                                        <td className="px-4 py-2 font-medium text-left text-foreground">Editor</td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2 text-center">
                                            <div className="flex items-center justify-center gap-0.5" title="Can only manage assigned and self-created Target Users">
                                                <Check size={16} className="text-foreground" />
                                                <span className="text-[10px] text-muted-foreground/70 -mt-2">*</span>
                                            </div>
                                        </td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                    </tr>
                                    <tr className="hover:bg-muted/30 transition-colors">
                                        <td className="px-4 py-2 font-medium text-left text-foreground">Viewer</td>
                                        <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                        <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div className="px-4 py-2 border-t border-border bg-muted/20 text-[10px] text-muted-foreground">
                            * Editors can only manage Target Users that are already assigned to them or self-created.
                        </div>
                    </div>

                    {!readOnly && (
                        <form onSubmit={handleShare} className="space-y-3">
                            <div className="flex gap-2">
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
                            </div>
                            {selectedUser && tunnelUsernames.length > 0 && (
                                <div className="bg-muted/30 border border-border rounded-lg p-3">
                                    <p className="text-xs font-medium text-muted-foreground mb-2">Restrict to specific Target Server Users:</p>
                                    <div className="flex flex-wrap gap-2">
                                        {tunnelUsernames.map(u => (
                                            <label key={u.id} className="flex items-center gap-1.5 text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:bg-muted/50 transition-colors">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedAllowedIds.includes(u.id)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) {
                                                            setSelectedAllowedIds(prev => [...prev, u.id]);
                                                        } else {
                                                            setSelectedAllowedIds(prev => prev.filter(id => id !== u.id));
                                                        }
                                                    }}
                                                    className="rounded"
                                                />
                                                <code className="font-mono">{u.username}</code>
                                                {u.created_by && (
                                                    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
                                                        By: {u.created_by} (#{u.created_by_id})
                                                    </span>
                                                )}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </form>
                    )}

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
                                            <th className={`px-4 py-3 text-left ${readOnly ? 'w-[45%]' : 'w-[30%]'} text-xs font-medium text-muted-foreground uppercase tracking-wider`}>User</th>
                                            <th className="px-4 py-3 text-center w-[30%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Target Users</th>
                                            <th className="px-4 py-3 text-center w-[25%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Permission</th>
                                            {!readOnly && <th className="px-4 py-3 text-right w-[15%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Action</th>}
                                        </tr>
                                    </thead>
                                    <tbody className="bg-card divide-y divide-border">
                                        {sharedUsers.map((su) => (
                                            <tr key={su.id} className="hover:bg-muted/50 transition-colors">
                                                <td className="px-4 py-3 text-sm font-medium text-foreground">
                                                    <div>{su.username}</div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                                    <div className="flex items-center justify-center gap-1.5">
                                                        <span className="text-xs text-muted-foreground">
                                                            {su.allowed_target_usernames?.length > 0
                                                                ? `${su.allowed_target_usernames.length}`
                                                                : '0'
                                                            }
                                                        </span>
                                                        {!readOnly && tunnelUsernames.length > 0 && (
                                                            <button
                                                                onClick={() => {
                                                                    setEditTargetUsersModal({
                                                                        userId: su.id,
                                                                        username: su.username,
                                                                        allowedIds: su.allowed_target_usernames?.map((a: any) => a.id) || []
                                                                    });
                                                                }}
                                                                className="text-muted-foreground hover:text-foreground p-1 bg-muted/30 hover:bg-muted/50 rounded transition-colors"
                                                                title="Edit allowed target users"
                                                            >
                                                                <Edit2 size={12} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                                    <div className="inline-block text-left">
                                                        <Select
                                                            value={su.permission_type || (su.can_admin_tunnel ? "admin" : su.can_edit_tunnel ? "edit" : "view")}
                                                            onValueChange={(val) => handleUpdatePermission(su.id, val)}
                                                            disabled={readOnly}
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
                                                {!readOnly && (
                                                    <td className="px-4 py-3 whitespace-nowrap text-right">
                                                        <button
                                                            onClick={() => setUnshareConfirm({ isOpen: true, userId: su.id, username: su.username })}
                                                            className="text-destructive hover:text-destructive/90 transition-colors bg-destructive/10 hover:bg-destructive/20 p-1.5 rounded-md"
                                                            title="Unshare Tunnel"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                    </td>
                                                )}
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

            <Modal
                isOpen={editTargetUsersModal !== null}
                onClose={() => setEditTargetUsersModal(null)}
                title={`Target Server Users Access - ${editTargetUsersModal?.username}`}
                size="sm"
            >
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Select which target server users <strong className="text-foreground">{editTargetUsersModal?.username}</strong> is allowed to access.
                        Leave all unchecked to allow access to all users.
                    </p>
                    <div className="bg-muted/30 border border-border rounded-lg p-3 max-h-[300px] overflow-y-auto">
                        <div className="flex flex-col gap-2">
                            {tunnelUsernames.map(u => (
                                <label key={u.id} className="flex items-center gap-3 text-sm bg-background border border-border rounded-md px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={
                                            Boolean(
                                                (editTargetUsersModal?.username && u.created_by === editTargetUsersModal.username) ||
                                                (editTargetUsersModal?.allowedIds?.includes(u.id))
                                            )
                                        }
                                        disabled={Boolean(editTargetUsersModal?.username && u.created_by === editTargetUsersModal.username)}
                                        onChange={(e) => {
                                            if (!editTargetUsersModal) return;
                                            if (e.target.checked) {
                                                setEditTargetUsersModal(prev => prev ? { ...prev, allowedIds: [...prev.allowedIds, u.id] } : null);
                                            } else {
                                                setEditTargetUsersModal(prev => prev ? { ...prev, allowedIds: prev.allowedIds.filter(id => id !== u.id) } : null);
                                            }
                                        }}
                                        className="rounded w-4 h-4 text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                                    />
                                    <code className="font-mono bg-muted/50 px-1 py-0.5 rounded">{u.username}</code>
                                    {u.created_by && (
                                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
                                            By: {u.created_by} (#{u.created_by_id})
                                        </span>
                                    )}
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setEditTargetUsersModal(null)}>Cancel</Button>
                        <Button onClick={handleSaveAllowed}>Save Changes</Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
