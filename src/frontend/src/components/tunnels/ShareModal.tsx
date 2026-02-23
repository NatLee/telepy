"use client";

/**
 * 分享通道彈窗：權限說明、新增分享、目前已分享列表與編輯目標使用者。
 * Share tunnel modal: permission matrix, add share, shared list and edit target users.
 */
import React from "react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useShareModal } from "@/hooks/useShareModal";
import { ShareModalPermissionMatrix } from "@/components/tunnels/ShareModalPermissionMatrix";
import { ShareModalShareForm } from "@/components/tunnels/ShareModalShareForm";
import { ShareModalSharedList, type SharedUserRow } from "@/components/tunnels/ShareModalSharedList";
import { ShareModalEditTargetUsersModal } from "@/components/tunnels/ShareModalEditTargetUsersModal";
import { TunnelModalProps } from "@/types/tunnel";

interface ShareModalProps extends TunnelModalProps {
    readOnly?: boolean;
}

export function ShareModal({ isOpen, onClose, tunnelId, readOnly = false }: ShareModalProps) {
    const { state, actions } = useShareModal(tunnelId, isOpen);
    const {
        sharedUsers,
        availableUsers,
        selectedUser,
        setSelectedUser,
        loading,
        unshareConfirm,
        setUnshareConfirm,
        tunnelUsernames,
        selectedAllowedIds,
        setSelectedAllowedIds,
        editTargetUsersModal,
        setEditTargetUsersModal,
    } = state;
    const { handleShare, handleUpdatePermission, handleUnshare, handleSaveAllowed } = actions;

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title={readOnly ? "Tunnel Permissions" : "Share Tunnel"} size="lg" isLoading={loading}>
                <div className="space-y-6">
                    <ShareModalPermissionMatrix />

                    {!readOnly && (
                        <ShareModalShareForm
                            selectedUser={selectedUser}
                            setSelectedUser={setSelectedUser}
                            availableUsers={availableUsers}
                            tunnelUsernames={tunnelUsernames}
                            selectedAllowedIds={selectedAllowedIds}
                            setSelectedAllowedIds={setSelectedAllowedIds}
                            onShare={handleShare}
                        />
                    )}

                    <ShareModalSharedList
                        loading={loading}
                        sharedUsers={sharedUsers as SharedUserRow[]}
                        readOnly={readOnly}
                        tunnelUsernames={tunnelUsernames}
                        onEditTargetUsers={(payload) =>
                            setEditTargetUsersModal({
                                userId: payload.userId,
                                username: payload.username,
                                allowedIds: payload.allowedIds,
                            })
                        }
                        onUpdatePermission={handleUpdatePermission}
                        onUnshare={(payload) => setUnshareConfirm({ isOpen: true, userId: payload.userId, username: payload.username })}
                    />
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

            <ShareModalEditTargetUsersModal
                isOpen={editTargetUsersModal !== null}
                username={editTargetUsersModal?.username ?? null}
                allowedIds={editTargetUsersModal?.allowedIds ?? []}
                tunnelUsernames={tunnelUsernames}
                onClose={() => setEditTargetUsersModal(null)}
                onSave={handleSaveAllowed}
                onAllowedIdsChange={(allowedIds) =>
                    setEditTargetUsersModal((prev) => (prev ? { ...prev, allowedIds } : null))
                }
            />
        </>
    );
}
