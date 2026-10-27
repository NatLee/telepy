"use client";

/**
 * 分享通道彈窗，左側分頁：已分享的人（權限、帳號、到期日）/ 分享給別人 / 權限對照表；等待中的存取申請放在每一頁最上面。
 * Share tunnel modal with side tabs: who it's shared with / share with someone / the permission table; pending
 * access requests sit on top of every tab.
 */
import React, { useState } from "react";
import { Share2, Table2, UserPlus, Users } from "lucide-react";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
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
import { Button } from "@/components/ui/button";

type ShareTab = "people" | "add" | "matrix";

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
    // 左側分頁：分享給誰（清單）/ 新增分享 / 權限對照。看權限的人（唯讀）先看對照表。
    // Side tabs: who it's shared with / share with someone / the permission table. Read-only viewers start on the table.
    const canAdd = !readOnly;
    const [tab, setTab] = useState<ShareTab>(readOnly ? "matrix" : "people");
    const tabs = [
        { value: "people" as const, icon: <Users />, label: <NavTabLabel label={t("share.tab.people", { count: sharedUsers.length })} mark={null} />, hint: t("share.tab.peopleHint") },
        ...(canAdd ? [{ value: "add" as const, icon: <UserPlus />, label: t("share.tab.add"), hint: t("share.tab.addHint") }] : []),
        { value: "matrix" as const, icon: <Table2 />, label: t("share.matrixTitle"), hint: t("share.tab.matrixHint") },
    ];

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                title={readOnly ? t("share.permissionsTitle") : t("share.shareTitle")}
                icon={<Share2 />}
                size="4xl"
                fixedHeight
                nav={<NavTabs aria-label={t("share.tab.aria")} tabs={tabs} value={tab} onChange={setTab} />}
                isLoading={loading}
            >
                <div className="space-y-5">
                    {/* 等待決定的存取申請（owner / ADMIN；沒有就不顯示），放在每一頁最上面。/ Pending access requests, on top of every tab. */}
                    <AccessRequestsPanel tunnelId={tunnelId} enabled={isOpen} onDecided={refresh} />

                    <div role="tabpanel" hidden={tab !== "add"} className="space-y-5">
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
                    </div>

                    <div role="tabpanel" hidden={tab !== "people"}>
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
                    {canAdd && canShare && sharedUsers.length === 0 && !loading && (
                        <Button type="button" variant="outline" size="sm" onClick={() => setTab("add")}>
                            <UserPlus size={15} />
                            {t("share.tab.add")}
                        </Button>
                    )}
                    </div>

                    {/* 權限對照表：自己一頁，直接展開。/ The permission table: its own tab, open. */}
                    <div role="tabpanel" hidden={tab !== "matrix"}>
                        <ShareModalPermissionMatrix defaultOpen />
                    </div>
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
