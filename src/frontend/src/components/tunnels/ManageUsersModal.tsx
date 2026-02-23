"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { X, User, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { TunnelModalProps, ReverseServerUsername } from "@/types/tunnel";

import { useManageUsersModal } from "@/hooks/useManageUsersModal";

interface ManageUsersModalProps extends TunnelModalProps {
    readOnly?: boolean;
}

export function ManageUsersModal({ isOpen, onClose, tunnelId, readOnly = false }: ManageUsersModalProps) {
    const { state, actions } = useManageUsersModal(tunnelId, isOpen);
    const {
        users,
        newUsername, setNewUsername,
        loading,
        deleteConfirm, setDeleteConfirm
    } = state;

    const {
        handleAddUser,
        handleDeleteUser
    } = actions;

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Manage Target Server Users" size="md" isLoading={loading}>
                <div className="space-y-4">
                    {!readOnly && (
                        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
                            <span className="mt-0.5 shrink-0 text-lg">💡</span>
                            <span>List the OS usernames (e.g., <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">root</code>, <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">ubuntu</code>) that are authorized to connect to this tunnel. This adds an essential layer of security by restricting access exclusively to these identities.</span>
                        </div>
                    )}

                    {!readOnly && (
                        <form onSubmit={handleAddUser} className="flex gap-2">
                            <input
                                type="text"
                                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                                placeholder="Enter OS username (e.g., root)"
                                value={newUsername}
                                onChange={(e) => setNewUsername(e.target.value)}
                                disabled={loading}
                            />
                            <Button
                                type="submit"
                                disabled={!newUsername.trim() || loading}
                            >
                                <UserPlus size={16} className="mr-2" />
                                Add
                            </Button>
                        </form>
                    )}

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
                                            {user.created_by && (
                                                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
                                                    By: {user.created_by} (#{user.created_by_id})
                                                </span>
                                            )}
                                        </div>
                                        {!readOnly && (
                                            <button
                                                onClick={() => setDeleteConfirm({ isOpen: true, user })}
                                                className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded hover:bg-destructive/10"
                                                title="Remove User"
                                            >
                                                <X size={18} />
                                            </button>
                                        )}
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
