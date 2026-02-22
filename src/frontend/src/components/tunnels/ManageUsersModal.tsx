"use client";

import React, { useState, useEffect } from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { X, Plus, User, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ManageUsersModalProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number | null;
}

export function ManageUsersModal({ isOpen, onClose, tunnelId }: ManageUsersModalProps) {
    const [users, setUsers] = useState<{ id: number; username: string }[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [loading, setLoading] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; user: { id: number; username: string } | null }>({ isOpen: false, user: null });
    const { showSuccess, showError } = useToast();

    const fetchUsers = async () => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/usernames`);
            if (res.ok) {
                const data = await res.json();
                // API returns [{id, username}] objects
                const list = Array.isArray(data) ? data : (data.results ?? []);
                setUsers(list);
            } else {
                showError("Failed to fetch users");
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
            setNewUsername("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const handleAddUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newUsername.trim() || !tunnelId) return;

        try {
            const res = await apiFetch(`/api/reverse/server/usernames`, {
                method: "POST",
                body: JSON.stringify({ reverse_server: tunnelId, username: newUsername.trim() }),
            });
            if (res.ok) {
                showSuccess(`User '${newUsername}' added successfully.`);
                setNewUsername("");
                fetchUsers();
            } else {
                const data = await res.json();
                showError(data.detail || data.error || "Failed to add user");
            }
        } catch (e: any) {
            showError(e.message || "Failed to add user");
        }
    };

    const handleDeleteUser = async () => {
        const user = deleteConfirm.user;
        if (!user || !tunnelId) return;

        try {
            // Delete by the username record id
            const res = await apiFetch(`/api/reverse/server/usernames/${user.id}`, {
                method: "DELETE",
            });
            if (res.ok) {
                showSuccess(`User '${user.username}' removed.`);
                fetchUsers();
            } else {
                showError("Failed to remove user");
            }
        } catch (e: any) {
            showError(e.message || "Failed to remove user");
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Manage Target Server Users" size="md" isLoading={loading}>
                <div className="space-y-6">
                    <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
                        <span className="mt-0.5 shrink-0 text-lg">💡</span>
                        <span>List the OS usernames (e.g., <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">root</code>, <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">ubuntu</code>) that are authorized to connect to this tunnel. This adds an essential layer of security by restricting access exclusively to these identities.</span>
                    </div>

                    <form onSubmit={handleAddUser} className="flex flex-col sm:flex-row gap-2">
                        <Input
                            type="text"
                            value={newUsername}
                            onChange={(e) => setNewUsername(e.target.value)}
                            placeholder="e.g. root"
                            className="flex-1"
                        />
                        <Button
                            type="submit"
                            disabled={!newUsername.trim()}
                        >
                            <Plus size={16} className="mr-2" />
                            Add
                        </Button>
                    </form>

                    <div className="bg-card border border-border rounded-md overflow-hidden min-w-0">
                        {loading ? null : users.length === 0 ? (
                            <div className="p-8 text-center text-muted-foreground flex flex-col items-center">
                                <User size={32} className="text-muted mb-2 opacity-50" />
                                <p>No authorized users found.</p>
                                <p className="text-sm mt-1">Users added here will be allowed to connect via SSH.</p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-border max-h-60 overflow-y-auto">
                                {users.map((user) => (
                                    <li key={user.id} className="px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors min-w-0 gap-2">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="bg-primary/20 p-1.5 rounded-md text-primary shrink-0">
                                                <User size={16} />
                                            </div>
                                            <span className="text-sm font-medium text-foreground truncate">{user.username}</span>
                                        </div>
                                        <button
                                            onClick={() => setDeleteConfirm({ isOpen: true, user })}
                                            className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded hover:bg-destructive/10"
                                            title="Remove User"
                                        >
                                            <X size={18} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, user: null })}
                onConfirm={handleDeleteUser}
                title="Remove User"
                message={`Are you sure you want to remove '${deleteConfirm.user?.username}'? They will no longer be able to authenticate using this tunnel.`}
                confirmText="Remove"
                isDestructive={true}
            />
        </>
    );
}
