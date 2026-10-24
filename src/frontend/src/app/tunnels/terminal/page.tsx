"use client";

/**
 * 終端機頁面：連線、xterm 與檔案管理。
 * Terminal page: connection, xterm and file manager.
 */
import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Terminal as TerminalIcon, X, Server } from "lucide-react";
import { TerminalHeader } from "@/components/tunnels/TerminalHeader";
import { TerminalContent } from "@/components/tunnels/TerminalContent";
import { TerminalAppearanceDialog } from "@/components/tunnels/TerminalAppearance";
import { StatusCard } from "@/components/ui/StatusCard";
import "xterm/css/xterm.css";

import { useTerminalPage } from "@/hooks/useTerminalPage";
import { useTunnelConnectionWebSocket } from "@/lib/websocket";
import { useI18n } from "@/lib/i18n";
import { useAccessRequests } from "@/hooks/useAccessRequests";
import { RequestAccessDialog } from "@/components/tunnels/AccessRequests";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";

export default function TerminalPage() {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const serverId = searchParams.get("serverId");
    const port = searchParams.get("port");
    // 區網主機（經裝置跳過去）。/ Optional LAN host reached through the device.
    const lanHostId = searchParams.get("lanHost");
    const lanUser = searchParams.get("lanUser");
    const router = useRouter();
    const { accessToken } = useAuth();

    const { refs, state, actions } = useTerminalPage(serverId, accessToken, lanHostId ? { hostId: lanHostId, username: lanUser } : null);

    // 「伺服器→裝置」的 kernel RTT：訂閱該隧道的 tunnel_connection socket（首屏帶入 + 每 ~5s 更新）。
    const { status: connStatus } = useTunnelConnectionWebSocket(serverId);
    const serverToDeviceMs = (connStatus?.rtt_ms ?? null) as number | null;

    const { terminalRef, xtermRef, wsRef } = refs;
    const {
        tabs, activeTabId,
        connected, connecting, permissionDenied, noUsers,
        latencyMs,
        showFiles, setShowFiles,
        isBrowserActive, setIsBrowserActive,
        keyboardExpanded, setKeyboardExpanded,
        keyboardMode, setKeyboardMode,
        headerExpanded, setHeaderExpanded,
        mainView, setMainView,
        syncedPath,
        serviceKeyModalOpen, setServiceKeyModalOpen,
        serviceKeys,
        loadingServiceKeys,
        username, setUsername,
        availableUsernames,
        lanHost,
        appearance,
    } = state;
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const { fetchServiceKeys, reconnect, addTab, closeTab, selectTab } = actions;

    // Set initial tab from URL param (mount only)
    useEffect(() => {
        const mv = searchParams.get("mainView");
        if (mv === "browser" || mv === "terminal" || mv === "files") {
            setMainView(mv);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!serverId || !accessToken) {
        return (
            <StatusCard
                title={t("terminal.noConnectionTitle")}
                message={t("terminal.noConnectionMessage")}
                icon={<TerminalIcon className="text-muted-foreground" size={20} />}
                variant="default"
                actionLabel={t("terminal.returnToList")}
                onAction={() => router.push("/tunnels")}
            />
        );
    }
    if (permissionDenied) {
        return (
            <StatusCard
                title={t("terminal.accessDenied")}
                message={permissionDenied}
                icon={<X size={20} />}
                variant="destructive"
                actionLabel={t("terminal.returnToList")}
                onAction={() => router.push("/tunnels")}
            />
        );
    }
    if (noUsers) {
        return <NoAccounts tunnelId={Number(serverId)} />;
    }

    return (
        <div className="flex flex-col h-[calc(100dvh-4rem)] md:h-[calc(100dvh-5rem)] w-full overflow-hidden bg-background relative">
            <div className="flex flex-col flex-1 min-h-0 p-1 sm:p-2 md:p-4">
                <TerminalHeader
                    serverId={serverId}
                    port={port}
                    headerExpanded={headerExpanded}
                    setHeaderExpanded={setHeaderExpanded}
                    connecting={connecting}
                    connected={connected}
                    youToServerMs={latencyMs}
                    serverToDeviceMs={serverToDeviceMs}
                    availableUsernames={availableUsernames}
                    username={username}
                    setUsername={setUsername}
                    syncedPath={syncedPath ?? null}
                    mainView={mainView}
                    setMainView={setMainView}
                    showFiles={showFiles}
                    setShowFiles={setShowFiles}
                    isBrowserActive={isBrowserActive}
                    onLoadServiceKeys={fetchServiceKeys}
                    onOpenAppearance={() => setAppearanceOpen(true)}
                    appearanceCustomized={appearance.customized}
                    lan={lanHostId ? { host: lanHost, login: lanUser || lanHost?.username || null } : null}
                />

                <TerminalContent
                    mainView={mainView}
                    setMainView={setMainView}
                    connected={connected}
                    connecting={connecting}
                    showFiles={showFiles}
                    setShowFiles={setShowFiles}
                    isBrowserActive={isBrowserActive}
                    setIsBrowserActive={setIsBrowserActive}
                    keyboardExpanded={keyboardExpanded}
                    setKeyboardExpanded={setKeyboardExpanded}
                    keyboardMode={keyboardMode}
                    setKeyboardMode={setKeyboardMode}
                    terminalRef={terminalRef}
                    xtermRef={xtermRef}
                    wsRef={wsRef}
                    shellTabs={tabs}
                    activeShellTabId={activeTabId}
                    onSelectShellTab={selectTab}
                    onAddShellTab={addTab}
                    onCloseShellTab={closeTab}
                    serverId={serverId!}
                    username={username}
                    accessToken={accessToken}
                    syncedPath={syncedPath}
                    serviceKeyModalOpen={serviceKeyModalOpen}
                    setServiceKeyModalOpen={setServiceKeyModalOpen}
                    loadingServiceKeys={loadingServiceKeys}
                    serviceKeys={serviceKeys}
                    onReconnect={reconnect}
                    palette={appearance.resolved.scheme.theme}
                />
            </div>

            <TerminalAppearanceDialog isOpen={appearanceOpen} onClose={() => setAppearanceOpen(false)} appearance={appearance} />
        </div>
    );
}

/**
 * 沒有可用的帳號：被分享的人可以直接申請（核准後重新載入就能連）；owner 照舊提示去加帳號。
 * No usable account: a sharee can ask for one right here (the page reloads once it is approved); owners are told to add one.
 */
function NoAccounts({ tunnelId }: { tunnelId: number }) {
    const { t, tn } = useI18n();
    const router = useRouter();
    const { data } = useAccessRequests(tunnelId, true);
    const [open, setOpen] = useState(false);
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED]: (msg) => {
            if (msg.tunnel_id === tunnelId && msg.status === "approved") window.location.reload();
        },
    });
    if (data?.can_request) {
        return (
            <>
                <StatusCard
                    title={t("terminal.noUsersTitle")}
                    message={t("share.request.noAccountsSharee")}
                    icon={<Server size={20} />}
                    variant="warning"
                    actionLabel={t("share.request.menu")}
                    onAction={() => setOpen(true)}
                />
                <RequestAccessDialog isOpen={open} onClose={() => setOpen(false)} tunnelId={tunnelId} />
            </>
        );
    }
    return (
        <StatusCard
            title={t("terminal.noUsersTitle")}
            message={tn("terminal.noUsersMessage", { targetServerUsers: <strong>{t("terminal.noUsersMessageHighlight")}</strong> })}
            icon={<Server size={20} />}
            variant="warning"
            actionLabel={t("terminal.returnToList")}
            onAction={() => router.push("/tunnels")}
        />
    );
}
