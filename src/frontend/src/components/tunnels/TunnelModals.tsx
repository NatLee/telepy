import React from "react";
import { ConfigModal } from "@/components/tunnels/ConfigModal";
import { ServerScriptModal } from "@/components/tunnels/ServerScriptModal";
import { ManageUsersModal } from "@/components/tunnels/ManageUsersModal";
import { TunnelDetailsModal } from "@/components/tunnels/TunnelDetailsModal";
import { ShareModal } from "@/components/tunnels/ShareModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tunnel } from "@/types/tunnel";
import { useTunnelsPage } from "@/hooks/useTunnelsPage";
import { useI18n } from "@/lib/i18n";

interface TunnelModalsProps {
    modals: ReturnType<typeof useTunnelsPage>["modals"];
    tunnels: Tunnel[];
    fetchData: () => void;
    handleDelete: () => void;
    handleLeaveTunnel: (tunnelId: number, name: string) => void;
}

export function TunnelModals({ modals, tunnels, fetchData, handleDelete, handleLeaveTunnel }: TunnelModalsProps) {
    const { t, tn } = useI18n();
    const {
        configModal, setConfigModal,
        scriptModal, setScriptModal,
        usersModal, setUsersModal,
        detailsModal, setDetailsModal,
        shareModal, setShareModal,
        deleteConfirm, setDeleteConfirm,
        leaveConfirm, setLeaveConfirm
    } = modals;

    return (
        <>
            <ConfigModal
                isOpen={configModal.isOpen}
                onClose={() => setConfigModal({ isOpen: false, tunnelId: null })}
                tunnelId={configModal.tunnelId}
            />
            <ServerScriptModal
                isOpen={scriptModal.isOpen}
                onClose={() => setScriptModal({ isOpen: false, tunnelId: null, sshPort: null })}
                tunnelId={scriptModal.tunnelId}
                sshPort={scriptModal.sshPort}
            />
            <ManageUsersModal
                isOpen={usersModal.isOpen}
                onClose={() => setUsersModal({ isOpen: false, tunnelId: null, readOnly: usersModal.readOnly })}
                tunnelId={usersModal.tunnelId}
                readOnly={usersModal.readOnly}
            />
            <TunnelDetailsModal
                isOpen={detailsModal.isOpen}
                onClose={() => setDetailsModal({ isOpen: false, tunnelId: null })}
                tunnelId={detailsModal.tunnelId}
                onUpdate={fetchData}
            />
            <ShareModal
                isOpen={shareModal.isOpen}
                onClose={() => setShareModal({ isOpen: false, tunnelId: null })}
                tunnelId={shareModal.tunnelId}
                readOnly={shareModal.tunnelId ? !tunnels.find(t => t.id === shareModal.tunnelId)?.is_owner : false}
            />

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, tunnelId: null, name: "" })}
                onConfirm={handleDelete}
                title={t("tunnels.deleteTitle")}
                message={
                    <span>
                        {tn("tunnels.deleteMessage", { name: <strong className="font-semibold">{deleteConfirm.name}</strong> })}
                    </span>
                }
                confirmText={t("common.delete")}
                isDestructive={true}
            />
            <ConfirmDialog
                isOpen={leaveConfirm.isOpen}
                onClose={() => setLeaveConfirm({ isOpen: false, tunnelId: null, name: "" })}
                onConfirm={() => {
                    if (leaveConfirm.tunnelId && leaveConfirm.name) {
                        handleLeaveTunnel(leaveConfirm.tunnelId, leaveConfirm.name);
                    }
                    setLeaveConfirm({ isOpen: false, tunnelId: null, name: "" });
                }}
                title={t("tunnels.leaveTitle")}
                message={
                    <span>
                        {tn("tunnels.leaveMessage", { name: <strong className="font-semibold">{leaveConfirm.name}</strong> })}
                    </span>
                }
                confirmText={t("tunnels.leave")}
                isDestructive={true}
            />
        </>
    );
}
