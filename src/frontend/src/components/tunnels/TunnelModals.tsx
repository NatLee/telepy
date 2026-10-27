import React from "react";
import { ConfigModal } from "@/components/tunnels/ConfigModal";
import { ServerScriptModal } from "@/components/tunnels/ServerScriptModal";
import { ManageUsersModal } from "@/components/tunnels/ManageUsersModal";
import { TunnelDetailsModal } from "@/components/tunnels/TunnelDetailsModal";
import { ShareModal } from "@/components/tunnels/ShareModal";
import { RequestAccessDialog } from "@/components/tunnels/AccessRequests";
import { DeleteTunnelDialog } from "@/components/tunnels/DeleteTunnelDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tunnel } from "@/types/tunnel";
import { useTunnelsPage } from "@/hooks/useTunnelsPage";
import { useI18n } from "@/lib/i18n";

interface TunnelModalsProps {
    modals: ReturnType<typeof useTunnelsPage>["modals"];
    tunnels: Tunnel[];
    fetchData: () => void;
    handleLeaveTunnel: (tunnelId: number, name: string) => void;
    /** 從單台的 SSH config 跳到多台的。/ Switch from one device's SSH config to the bulk one. */
    onBulkConfig?: () => void;
}

export function TunnelModals({ modals, tunnels, fetchData, handleLeaveTunnel, onBulkConfig }: TunnelModalsProps) {
    const { t, tn } = useI18n();
    const {
        configModal, setConfigModal,
        scriptModal, setScriptModal,
        usersModal, setUsersModal,
        detailsModal, setDetailsModal,
        shareModal, setShareModal,
        requestModal, setRequestModal,
        deleteConfirm, setDeleteConfirm,
        leaveConfirm, setLeaveConfirm
    } = modals;

    return (
        <>
            <ConfigModal
                isOpen={configModal.isOpen}
                onClose={() => setConfigModal({ isOpen: false, tunnelId: null })}
                tunnelId={configModal.tunnelId}
                onBulk={
                    onBulkConfig &&
                    (() => {
                        setConfigModal({ isOpen: false, tunnelId: null });
                        onBulkConfig();
                    })
                }
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

            <RequestAccessDialog
                isOpen={requestModal.isOpen}
                onClose={() => setRequestModal({ ...requestModal, isOpen: false })}
                tunnelId={requestModal.tunnelId}
                tunnelName={tunnels.find((tn) => tn.id === requestModal.tunnelId)?.host_friendly_name}
            />

            {/* 關閉時保留 id / 名稱，關閉動畫期間內容不會消失；換一條隧道就重新掛載（選項與結果重來）。
                Keep id / name while closing so the content survives the close animation; remount per tunnel. */}
            <DeleteTunnelDialog
                key={deleteConfirm.tunnelId ?? "none"}
                isOpen={deleteConfirm.isOpen}
                tunnelId={deleteConfirm.tunnelId}
                name={deleteConfirm.name}
                onClose={() => setDeleteConfirm({ ...deleteConfirm, isOpen: false })}
                onDeleted={fetchData}
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
                        {tn("tunnels.leaveMessage", { name: <strong>{leaveConfirm.name}</strong> })}
                    </span>
                }
                confirmText={t("tunnels.leave")}
                isDestructive={true}
            />
        </>
    );
}
