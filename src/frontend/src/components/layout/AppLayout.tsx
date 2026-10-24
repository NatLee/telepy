"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useNotificationWebSocket, type SocketPhase } from "@/lib/websocket";
import { useDesktopNotifications } from "@/hooks/useDesktopNotifications";
import { EnrollmentGate } from "@/components/auth/EnrollmentGate";
import { SessionEndedNotice } from "@/components/layout/SessionEndedNotice";
import { StepUpProvider } from "@/components/auth/StepUpProvider";
import { CommandApprovalCenter, CommandApprovalsProvider } from "@/components/commands/CommandApprovals";

type NotificationWsStatus = {
    isConnected: boolean;
    phase: SocketPhase;
    /** 已收到的訊息數，每多一則代表剛有更新進來。/ Messages received; each increment means an update just arrived. */
    messageCount: number;
    reconnect: () => void;
};

/** Context exposing the notification WebSocket connection status */
const NotificationWsContext = createContext<NotificationWsStatus>({
    isConnected: false,
    phase: { state: "connecting" },
    messageCount: 0,
    reconnect: () => {},
});
export const useNotificationWsStatus = () => useContext(NotificationWsContext);

export function AppLayout({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading, user } = useAuth();
    const missing = user?.mfa_missing ?? [];
    // 管理員要求兩步驟而帳號還沒設好 → 設定畫面；設好後等使用者按「繼續」才放行（見 EnrollmentGate）。
    // Required factors missing → the enrollment gate, held until the user presses Continue.
    const [gated, setGated] = useState(false);
    if (missing.length > 0 && !gated) setGated(true);
    if (!user && gated) setGated(false);
    const router = useRouter();

    // Establish global notification websocket when logged in
    const { isConnected, phase, messageCount, reconnect } = useNotificationWebSocket();
    // 背景分頁的桌面通知（偏好設定裡每台瀏覽器自己開）。/ Desktop notifications for background tabs (opt-in per browser).
    useDesktopNotifications();
    const wsStatus = useMemo(
        () => ({ isConnected, phase, messageCount, reconnect }),
        [isConnected, phase, messageCount, reconnect],
    );
    const pathname = usePathname();
    const isTerminalPage = pathname?.startsWith("/tunnels/terminal");

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, isLoading, router]);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="size-8 rounded-full border-2 border-border border-t-primary animate-spin" aria-hidden></div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return null; // Will redirect in useEffect
    }

    if (gated) {
        return (
            <NotificationWsContext.Provider value={wsStatus}>
                <EnrollmentGate missing={missing} onDone={() => setGated(false)} />
            </NotificationWsContext.Provider>
        );
    }

    return (
        <NotificationWsContext.Provider value={wsStatus}>
            <CommandApprovalsProvider>
            <div className="flex min-h-screen w-full bg-background font-sans">
                {/* 敏感隧道的「確認是你」流程（REST 403 / WebSocket 4008 時開）。/ Step-up prompts for sensitive tunnels. */}
                <StepUpProvider />
                {/* 有人結束了你的 session 時提醒。/ A heads-up when someone ends one of your sessions. */}
                <SessionEndedNotice />
                {/* 等你核准的指令（任何頁面右下角）。/ Commands waiting for your approval, bottom right on any page. */}
                <CommandApprovalCenter />
                <Sidebar />
                <div className="relative flex flex-col flex-1 w-full min-w-0">
                    <Header />
                    <main className={`flex-1 w-full ${isTerminalPage ? 'p-0 flex flex-col' : 'mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8'}`}>
                        {children}
                    </main>
                </div>
            </div>
            </CommandApprovalsProvider>
        </NotificationWsContext.Provider>
    );
}
