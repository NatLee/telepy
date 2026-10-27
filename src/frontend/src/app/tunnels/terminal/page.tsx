"use client";

/**
 * 終端機頁面：帶 `serverId` 時是連線、xterm 與檔案管理；沒帶時是連線選擇器（側欄的「終端機」），
 * 用路徑圖選裝置 / 帳號 / 區網主機後再進來。「怎麼運作」打開作用中分頁的即時路徑圖（卡在哪一段）。
 * Terminal page: with `serverId` the connection, xterm and file manager; without it the connect picker (the
 * sidebar's Terminal entry), a path diagram that picks the device / account / LAN host first. The info button
 * opens the active tab's live path diagram (where it stopped).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Terminal as TerminalIcon, X, Server, Wrench } from "lucide-react";
import { TerminalHeader } from "@/components/tunnels/TerminalHeader";
import { TerminalContent, type SideTab } from "@/components/tunnels/TerminalContent";
import { ToolboxPanel } from "@/components/toolbox/ToolboxPanel";
import { useFeatures } from "@/hooks/useFeatures";
import { Modal } from "@/components/ui/Modal";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { ToolboxTarget } from "@/lib/snippets";
import { CommandHoldBanner } from "@/components/commands/CommandHoldBanner";
import { WatchersChip, WatchRequestBanner } from "@/components/watch/WatchersBar";
import { pendingRequests, controller } from "@/lib/terminalWatch";
import { ReconnectBanner } from "@/components/tunnels/ReconnectBanner";
import { ReconnectWhy } from "@/components/tunnels/ReconnectWhy";
import { useTerminalDetach } from "@/hooks/useTerminalDetach";
import { detachLayers } from "@/lib/terminalDetach";
import { TerminalAppearanceDialog } from "@/components/tunnels/TerminalAppearance";
import { TerminalInfoDialog } from "@/components/tunnels/TerminalInfoDialog";
import { TerminalConnectPage } from "@/components/tunnels/TerminalConnectPanel";
import type { TerminalFlowContext } from "@/components/tunnels/TerminalFlow";
import { terminalPhase } from "@/lib/terminalFlow";
import { lanAuthFromValue, lanAuthParam } from "@/lib/lanAuth";
import { useSavedLogins } from "@/hooks/useSavedLogins";
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
    const searchParams = useSearchParams();
    const serverId = searchParams.get("serverId");
    // 沒選裝置：連線選擇器。/ No device chosen: the connect picker.
    if (!serverId) return <TerminalConnectPage />;
    return <TerminalSession serverId={serverId} />;
}

function TerminalSession({ serverId }: { serverId: string }) {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const port = searchParams.get("port");
    // 區網主機（經裝置跳過去）。/ Optional LAN host reached through the device.
    const lanHostId = searchParams.get("lanHost");
    const lanUser = searchParams.get("lanUser");
    // 區網那一跳怎麼登入（網址帶的；物件只建一次，免得 hook 以為目標變了）。/ How the hop logs in (from the URL; one stable object).
    const lanAuthRaw = searchParams.get("lanAuth");
    const lanAuth = useMemo(() => lanAuthFromValue(lanAuthRaw), [lanAuthRaw]);
    const router = useRouter();
    const { accessToken } = useAuth();

    const lanTarget = useMemo(() => (lanHostId ? { hostId: lanHostId, username: lanUser, auth: lanAuth } : null), [lanHostId, lanUser, lanAuth]);
    const { refs, state, actions } = useTerminalPage(serverId, accessToken, lanTarget);
    // 存的登入的名稱（info 路徑圖要說「用哪一組」）。/ The saved login's name for the info diagram.
    const savedLogins = useSavedLogins(lanHostId && lanAuth.kind === "credential" ? { tunnelId: Number(serverId), hostId: Number(lanHostId), protocol: "ssh" } : null, lanAuth.kind === "credential");
    const savedLabel = lanAuth.kind === "credential" ? savedLogins.list.find((c) => c.id === lanAuth.id)?.label ?? null : null;

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
        tunnelName,
        recorded,
        appearance,
        commandBanner,
        reconnecting,
        detachPolicy,
    } = state;
    const detachPref = useTerminalDetach();
    const [whyOpen, setWhyOpen] = useState(false);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    // 作用中分頁的階段 → 路徑圖。/ The active tab's phase → the path diagram.
    const activeTab = tabs.find((x) => x.id === activeTabId) ?? null;
    const { phase, failure } = terminalPhase(activeTab?.status ?? null, activeTab?.closeCode, !!lanHostId);
    const flowCtx: TerminalFlowContext = {
        phase: !activeTab && (permissionDenied || noUsers) ? "failed" : phase,
        failure,
        deviceName: tunnelName ?? (serverId || "").slice(0, 8),
        account: username ?? "",
        lanHost: lanHostId ? { name: lanHost ? (lanHost.label || lanHost.address) : t("terminal.lanHostFallback"), address: lanHost?.address ?? "?", port: lanHost?.ssh_port ?? 22, login: lanUser || lanHost?.username || "", auth: lanAuth.kind, savedLabel } : null,
        youToServerMs: latencyMs,
        serverToDeviceMs,
        recorded,
    };
    const switchHref = `/tunnels/terminal?tunnel=${serverId}${lanHostId ? `&lanHost=${lanHostId}` : ""}${lanHostId && lanAuthParam(lanAuth) ? `&lanAuth=${lanAuthParam(lanAuth)}` : ""}`;
    const { fetchServiceKeys, reconnect, addTab, closeTab, selectTab, withdrawCommand, dismissCommandBanner, reconnectNow, answerWatch, revokeWatch } = actions;
    const watchers = state.watchers;

    // 工具箱：桌機 = 側欄的第二個分頁（跟檔案共用一塊），手機 = 底部面板（送出後自動收起，看得到結果）。
    // Toolbox: on desktop the side panel's second tab (sharing the files panel), on phones a bottom sheet that closes
    // after sending so the output is visible.
    const isDesktop = useMediaQuery("(min-width: 768px)");
    // 「工具箱」被管理員關掉就沒有這個面板（終端機頁本身已經要「網頁終端機」）。/ No toolbox when an admin turned it off.
    const canToolbox = useFeatures().has("toolbox");
    const [sideTab, setSideTab] = useState<SideTab>(searchParams.get("toolbox") && canToolbox ? "toolbox" : "files");
    const [toolboxSheet, setToolboxSheet] = useState(false);
    const toolboxOpen = isDesktop ? showFiles && sideTab === "toolbox" : toolboxSheet;
    const toggleToolbox = useCallback(() => {
        if (!isDesktop) {
            setToolboxSheet((v) => !v);
            return;
        }
        if (showFiles && sideTab === "toolbox") setShowFiles(false);
        else {
            setSideTab("toolbox");
            setShowFiles(true);
        }
    }, [isDesktop, showFiles, sideTab, setShowFiles]);
    // ?toolbox=1（隧道選單的「工具箱」）：量到斷點後打開一次。/ ?toolbox=1 opens it once the breakpoint is known.
    const toolboxParamDone = useRef(false);
    useEffect(() => {
        if (toolboxParamDone.current || isDesktop === undefined || !searchParams.get("toolbox") || !canToolbox) return;
        toolboxParamDone.current = true;
        if (isDesktop) {
            setSideTab("toolbox");
            setShowFiles(true);
        } else setToolboxSheet(true);
    }, [isDesktop, searchParams, setShowFiles, canToolbox]);
    // 工具箱讀最新的提示（面板收起來之後也讀得到）。/ The toolbox reads the latest banner, even after its panel closes.
    const bannerRef = useRef(commandBanner);
    useEffect(() => { bannerRef.current = commandBanner; }, [commandBanner]);
    const toolboxTarget: ToolboxTarget = useMemo(() => ({
        tunnelId: Number(serverId),
        send: (input: string) => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return false;
            // 跟鍵盤一樣的 pty_input（不是括號貼上），指令規則照樣讀得到每一行。/ The keyboard's pty_input, never a bracketed paste.
            ws.send(JSON.stringify({ action: "pty_input", payload: { input } }));
            return true;
        },
        onOutput: (cb: () => void) => {
            const term = xtermRef.current as { onWriteParsed?: (fn: () => void) => { dispose: () => void } } | null;
            const sub = term?.onWriteParsed?.(cb);
            return () => sub?.dispose();
        },
        connected,
        banner: () => bannerRef.current,
        where: lanHostId
            ? `${lanUser || lanHost?.username || "?"}@${lanHost ? (lanHost.label || lanHost.address) : t("terminal.lanHostFallback")}`
            : `${username ?? "?"}@${tunnelName ?? (serverId || "").slice(0, 8)}`,
    }), [serverId, wsRef, xtermRef, connected, lanHostId, lanUser, lanHost, username, tunnelName, t]);
    const afterToolboxSend = useCallback(() => {
        setToolboxSheet(false);
        setMainView("terminal");
        const term = xtermRef.current as { focus?: () => void; scrollToBottom?: () => void } | null;
        setTimeout(() => {
            try { term?.scrollToBottom?.(); term?.focus?.(); } catch { /* noop */ }
        }, 50);
    }, [setMainView, xtermRef]);
    const toolboxPanel = (
        <ToolboxPanel target={toolboxTarget} tunnelName={tunnelName ?? (serverId || "").slice(0, 8)} onSent={afterToolboxSend} />
    );

    // Set initial tab from URL param (mount only)
    useEffect(() => {
        const mv = searchParams.get("mainView");
        if (mv === "browser" || mv === "terminal" || mv === "files") {
            setMainView(mv);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!accessToken) {
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
                    tunnelName={tunnelName}
                    onOpenInfo={() => setInfoOpen(true)}
                    switchHref={switchHref}
                    sideTab={sideTab}
                    onSideTab={setSideTab}
                    onToolbox={canToolbox ? toggleToolbox : undefined}
                    toolboxOpen={toolboxOpen}
                    watchers={<WatchersChip frame={watchers} onRevoke={revokeWatch} />}
                />

                <TerminalContent
                    tunnelName={tunnelName}
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
                    serverId={serverId}
                    username={username}
                    accessToken={accessToken}
                    syncedPath={syncedPath}
                    serviceKeyModalOpen={serviceKeyModalOpen}
                    setServiceKeyModalOpen={setServiceKeyModalOpen}
                    loadingServiceKeys={loadingServiceKeys}
                    serviceKeys={serviceKeys}
                    onReconnect={reconnect}
                    palette={appearance.resolved.scheme.theme}
                    sideTab={sideTab}
                    onSideTab={setSideTab}
                    toolbox={isDesktop && canToolbox ? toolboxPanel : null}
                    commandBanner={(commandBanner || reconnecting || pendingRequests(watchers).length > 0 || controller(watchers)) && (
                        <div className="space-y-2">
                            {/* 斷線、shell 還留著：重新連線中。/ Dropped with the shell kept: reconnecting. */}
                            {reconnecting && (
                                <ReconnectBanner state={reconnecting} onWhy={() => setWhyOpen(true)} onRetry={reconnectNow} />
                            )}
                            {commandBanner && <CommandHoldBanner banner={commandBanner} onWithdraw={withdrawCommand} onDismiss={dismissCommandBanner} />}
                            {/* 看的人想打字 / 正在一起打字。/ A watcher asks to type, or is typing along. */}
                            <WatchRequestBanner frame={watchers} onAnswer={answerWatch} onRevoke={revokeWatch} />
                        </div>
                    )}
                />
            </div>

            <ReconnectWhy
                isOpen={whyOpen}
                onClose={() => setWhyOpen(false)}
                reconnecting={reconnecting}
                ended={activeTab?.status === "closed"}
                layers={detachLayers(detachPref.choice, detachPref.limit, detachPolicy)}
            />
            <TerminalAppearanceDialog isOpen={appearanceOpen} onClose={() => setAppearanceOpen(false)} appearance={appearance} />
            <TerminalInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} ctx={flowCtx} />
            {isDesktop === false && (
                <Modal isOpen={toolboxSheet} onClose={() => setToolboxSheet(false)} title={t("toolbox.title")} icon={<Wrench />} size="lg" bodyClassName="px-2 py-2 sm:px-3">
                    <ToolboxPanel target={toolboxTarget} tunnelName={tunnelName ?? (serverId || "").slice(0, 8)} onSent={afterToolboxSend} embedded />
                </Modal>
            )}
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
