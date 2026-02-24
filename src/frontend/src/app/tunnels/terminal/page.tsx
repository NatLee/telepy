"use client";

/**
 * 終端機頁面：連線、xterm 與檔案管理。
 * Terminal page: connection, xterm and file manager.
 */
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Terminal as TerminalIcon, X, Server } from "lucide-react";
import { TerminalHeader } from "@/components/tunnels/TerminalHeader";
import { TerminalContent } from "@/components/tunnels/TerminalContent";
import { StatusCard } from "@/components/ui/StatusCard";
import "xterm/css/xterm.css";

import { useTerminalPage } from "@/hooks/useTerminalPage";

export default function TerminalPage() {
    const searchParams = useSearchParams();
    const serverId = searchParams.get("serverId");
    const port = searchParams.get("port");
    const router = useRouter();
    const { accessToken } = useAuth();

    const { refs, state, actions } = useTerminalPage(serverId, accessToken);

    const { terminalRef, xtermRef, wsRef } = refs;
    const {
        connected, connecting, permissionDenied, noUsers,
        showFileManager, setShowFileManager,
        showRemoteBrowser, setShowRemoteBrowser,
        isBrowserActive, setIsBrowserActive,
        keyboardExpanded, setKeyboardExpanded,
        headerExpanded, setHeaderExpanded,
        activeTab, setActiveTab,
        syncedPath, setSyncedPath,
        serviceKeyModalOpen, setServiceKeyModalOpen,
        serviceKeys, setServiceKeys,
        loadingServiceKeys, setLoadingServiceKeys,
        username, setUsername,
        availableUsernames, setAvailableUsernames
    } = state;
    const { fetchServiceKeys } = actions;
    if (!serverId || !accessToken) {
        return (
            <StatusCard
                title="No Connection Selected"
                message="Please select a server from the tunnels list to open the terminal."
                icon={<TerminalIcon className="text-muted-foreground" size={20} />}
                variant="default"
                actionLabel="Return to Tunnels List"
                onAction={() => router.push("/tunnels")}
            />
        );
    }
    if (permissionDenied) {
        return (
            <StatusCard
                title="Access Denied"
                message={permissionDenied}
                icon={<X size={20} />}
                variant="destructive"
                actionLabel="Return to Tunnels List"
                onAction={() => router.push("/tunnels")}
            />
        );
    }
    if (noUsers) {
        return (
            <StatusCard
                title="No Target Server Users"
                message={
                    <>
                        This tunnel does not have any target server users configured. Please add at least one user in the tunnel&apos;s <strong>Target Server Users</strong> settings before connecting.
                    </>
                }
                icon={<Server size={20} />}
                variant="warning"
                actionLabel="Return to Tunnels List"
                onAction={() => router.push("/tunnels")}
            />
        );
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
                    availableUsernames={availableUsernames}
                    username={username}
                    setUsername={setUsername}
                    syncedPath={syncedPath ?? null}
                    showFileManager={showFileManager}
                    setShowFileManager={setShowFileManager}
                    showRemoteBrowser={showRemoteBrowser}
                    setShowRemoteBrowser={setShowRemoteBrowser}
                    isBrowserActive={isBrowserActive}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    onLoadServiceKeys={fetchServiceKeys}
                />

                <TerminalContent
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    connected={connected}
                    connecting={connecting}
                    showFileManager={showFileManager}
                    setShowFileManager={setShowFileManager}
                    showRemoteBrowser={showRemoteBrowser}
                    setShowRemoteBrowser={setShowRemoteBrowser}
                    setIsBrowserActive={setIsBrowserActive}
                    keyboardExpanded={keyboardExpanded}
                    setKeyboardExpanded={setKeyboardExpanded}
                    terminalRef={terminalRef}
                    xtermRef={xtermRef}
                    wsRef={wsRef}
                    serverId={serverId!}
                    username={username}
                    accessToken={accessToken}
                    syncedPath={syncedPath}
                    serviceKeyModalOpen={serviceKeyModalOpen}
                    setServiceKeyModalOpen={setServiceKeyModalOpen}
                    loadingServiceKeys={loadingServiceKeys}
                    serviceKeys={serviceKeys}
                />
            </div>
        </div>
    );
}
