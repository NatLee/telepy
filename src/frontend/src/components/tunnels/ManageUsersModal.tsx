"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { X, User, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";

import { TunnelModalProps } from "@/types/tunnel";

import { useManageUsersModal } from "@/hooks/useManageUsersModal";
import { useI18n } from "@/lib/i18n";

interface ManageUsersModalProps extends TunnelModalProps {
    readOnly?: boolean;
}

export function ManageUsersModal({ isOpen, onClose, tunnelId, readOnly = false }: ManageUsersModalProps) {
    const { t, tn } = useI18n();
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
            <Modal isOpen={isOpen} onClose={onClose} title={t("manageUsers.title")} icon={<Users />} size="md" isLoading={loading}>
                <div className="space-y-4">
                    {!readOnly && (
                        <Callout tone="tip">
                            {tn("manageUsers.banner", {
                                root: <code>root</code>,
                                ubuntu: <code>ubuntu</code>,
                            })}
                        </Callout>
                    )}

                    {!readOnly && (
                        <form onSubmit={handleAddUser} className="flex gap-2">
                            <Input
                                type="text"
                                className="flex-1 font-mono"
                                placeholder={t("manageUsers.inputPlaceholder")}
                                value={newUsername}
                                onChange={(e) => setNewUsername(e.target.value)}
                                disabled={loading}
                            />
                            <Button
                                type="submit"
                                disabled={!newUsername.trim() || loading}
                            >
                                <UserPlus />
                                {t("common.add")}
                            </Button>
                        </form>
                    )}

                    {loading ? null : users.length === 0 ? (
                        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-8 text-center">
                            <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                                <User size={20} />
                            </span>
                            <p className="text-foreground">{t("manageUsers.empty")}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{t("manageUsers.emptySubtext")}</p>
                        </div>
                    ) : (
                        <ul className="max-h-64 divide-y divide-border/70 overflow-y-auto rounded-xl ring-1 ring-inset ring-border/80">
                            {users.map((user) => (
                                <li key={user.id} className="flex min-w-0 items-center justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-surface">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                                            <User size={16} />
                                        </span>
                                        <span className="truncate font-mono text-sm text-foreground">{user.username}</span>
                                        {user.created_by && (
                                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.75rem] text-muted-foreground">
                                                {t("common.byUserTag", { user: user.created_by, id: user.created_by_id ?? "" })}
                                            </span>
                                        )}
                                    </div>
                                    {!readOnly && (
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            onClick={() => setDeleteConfirm({ isOpen: true, user })}
                                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                            title={t("manageUsers.removeTitle")}
                                            aria-label={t("manageUsers.removeTitle")}
                                        >
                                            <X />
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, user: null })}
                onConfirm={handleDeleteUser}
                title={t("manageUsers.removeTitle")}
                message={t("manageUsers.removeMessage", { username: deleteConfirm.user?.username ?? "" })}
                confirmText={t("common.remove")}
                isDestructive={true}
            />
        </>
    );
}
