"use client";

/**
 * 通道的對話框狀態（SSH 設定、安裝腳本、登入帳號、分享、申請存取、刪除、離開）：通道列表和通道頁面共用，畫在
 * `components/tunnels/TunnelModals.tsx`。
 * The tunnel dialogs' state (SSH config, install script, login accounts, sharing, access requests, delete, leave),
 * shared by the tunnel list and the tunnel page; drawn by `components/tunnels/TunnelModals.tsx`.
 */
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";

export function useTunnelModals() {
    const [configModal, setConfigModal] = useState<{ isOpen: boolean; tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [scriptModal, setScriptModal] = useState<{ isOpen: boolean; tunnelId: number | null; sshPort: number | null }>({ isOpen: false, tunnelId: null, sshPort: null });
    const [usersModal, setUsersModal] = useState<{ isOpen: boolean; tunnelId: number | null; readOnly: boolean }>({ isOpen: false, tunnelId: null, readOnly: false });
    const [shareModal, setShareModal] = useState<{ isOpen: boolean; tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [requestModal, setRequestModal] = useState<{ isOpen: boolean; tunnelId: number | null }>({ isOpen: false, tunnelId: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; tunnelId: number | null; name: string }>({ isOpen: false, tunnelId: null, name: "" });
    const [leaveConfirm, setLeaveConfirm] = useState<{ isOpen: boolean; tunnelId: number | null; name: string }>({ isOpen: false, tunnelId: null, name: "" });
    return {
        configModal, setConfigModal,
        scriptModal, setScriptModal,
        usersModal, setUsersModal,
        shareModal, setShareModal,
        requestModal, setRequestModal,
        deleteConfirm, setDeleteConfirm,
        leaveConfirm, setLeaveConfirm,
    };
}

export type TunnelModalsState = ReturnType<typeof useTunnelModals>;

/** 離開分享給我的通道；成功後呼叫 `after`。/ Leave a tunnel shared with me; `after` runs on success. */
export function useLeaveTunnel(after: () => void) {
    const { t } = useI18n();
    const { user } = useAuth();
    const { showSuccess, showError } = useToast();
    return async (tunnelId: number, tunnelName: string) => {
        if (!user?.id) {
            showError(t("tunnels.getCurrentUserFailed"));
            return;
        }
        try {
            const res = await apiFetch(`/tunnels/unshare/${tunnelId}/${user.id}`, { method: "DELETE" });
            if (res.ok) {
                showSuccess(t("tunnels.left", { name: tunnelName }));
                after();
            } else {
                showError(t("tunnels.leaveFailed"));
            }
        } catch (e) {
            showError((e instanceof Error && e.message) || t("tunnels.leaveFailed"));
        }
    };
}
