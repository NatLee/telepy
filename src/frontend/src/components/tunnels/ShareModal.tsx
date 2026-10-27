"use client";

/**
 * 分享通道彈窗：權限說明、新增分享、目前已分享列表與編輯目標使用者。
 * Share tunnel modal: permission matrix, add share, shared list and edit target users.
 */
import React from "react";
import { Share2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useShareModal } from "@/hooks/useShareModal";
import { ShareModalPermissionMatrix } from "@/components/tunnels/ShareModalPermissionMatrix";
import { ShareModalShareForm } from "@/components/tunnels/ShareModalShareForm";
import { ShareModalSharedList, type SharedUserRow } from "@/components/tunnels/ShareModalSharedList";
import { ShareModalEditTargetUsersModal } from "@/components/tunnels/ShareModalEditTargetUsersModal";
import { AccessRequestsPanel } from "@/components/tunnels/AccessRequests";
import { TunnelModalProps } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { useFeatures } from "@/hooks/useFeatures";
import { Callout } from "@/components/ui/callout";

interface ShareModalProps extends TunnelModalProps {
    readOnly?: boolean;
}

export function ShareModal({ isOpen, onClose, tunnelId, readOnly = false }: ShareModalProps) {
    const { t } = useI18n();
    // 「分享隧道」被管理員關掉：只看得到、取消得了現有的分享。/ Sharing turned off: existing shares can be seen and removed only.
    const canShare = useFeatures().has("tunnels.share");
    const { state, actions } = useShareModal(tunnelId, isOpen, canShare && !readOnly);
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
        expiryPreset,
        setExpiryPreset,
        expiryDate,
        setExpiryDate,
    } = state;
    const { handleShare, handleUpdatePermission, handleUnshare, handleSaveAllowed, handleUpdateExpiry, refresh } = actions;

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title={readOnly ? t("share.permissionsTitle") : t("share.shareTitle")} icon={<Share2 />} size="2xl" isLoading={loading}>
                <div className="space-y-5">
                    {/* 等待決定的存取申請（owner / ADMIN；沒有就不顯示）。/ Pending access requests (owner / ADMIN; hidden when none). */}
                    <AccessRequestsPanel tunnelId={tunnelId} enabled={isOpen} onDecided={refresh} />

                    {!readOnly && !canShare && <Callout tone="warning">{t("access.shareOff")}</Callout>}
                    {!readOnly && canShare && (
                        <ShareModalShareForm
                            selectedUser={selectedUser}
                            setSelectedUser={setSelectedUser}
                            availableUsers={availableUsers}
                            tunnelUsernames={tunnelUsernames}
                            selectedAllowedIds={selectedAllowedIds}
                            setSelectedAllowedIds={setSelectedAllowedIds}
                            expiryPreset={expiryPreset}
                            setExpiryPreset={setExpiryPreset}
                            expiryDate={expiryDate}
                            setExpiryDate={setExpiryDate}
                            onShare={handleShare}
                        />
                    )}

                    <ShareModalSharedList
                        loading={loading}
                        sharedUsers={sharedUsers as SharedUserRow[]}
                        readOnly={readOnly}
                        locked={!canShare}
                        tunnelUsernames={tunnelUsernames}
                        onEditTargetUsers={(payload) =>
                            setEditTargetUsersModal({
                                userId: payload.userId,
                                username: payload.username,
                                allowedIds: payload.allowedIds,
                            })
                        }
                        onUpdatePermission={handleUpdatePermission}
                        onUpdateExpiry={handleUpdateExpiry}
                        onUnshare={(payload) => setUnshareConfirm({ isOpen: true, userId: payload.userId, username: payload.username })}
                    />

                    {/* 權限對照表收起來放最後;唯讀者(看權限用)預設展開。
                        The matrix sits last and collapsed; read-only viewers get it open. */}
                    <ShareModalPermissionMatrix defaultOpen={readOnly} />
                </div>
            </Modal>

            <ConfirmDialog
                isOpen={unshareConfirm !== null}
                onClose={() => setUnshareConfirm(null)}
                onConfirm={handleUnshare}
                title={t("share.unshareTitle")}
                message={t("share.unshareMessage", { username: unshareConfirm?.username ?? "" })}
                confirmText={t("share.unshare")}
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
