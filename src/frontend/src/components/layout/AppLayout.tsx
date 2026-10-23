"use client";

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useNotificationWebSocket, type SocketPhase } from "@/lib/websocket";

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
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    // Establish global notification websocket when logged in
    const { isConnected, phase, messageCount, reconnect } = useNotificationWebSocket();
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

    return (
        <NotificationWsContext.Provider value={wsStatus}>
            <div className="flex min-h-screen w-full bg-background font-sans">
                <Sidebar />
                <div className="relative flex flex-col flex-1 w-full min-w-0">
                    <Header />
                    <main className={`flex-1 w-full ${isTerminalPage ? 'p-0 flex flex-col' : 'mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8'}`}>
                        {children}
                    </main>
                </div>
            </div>
        </NotificationWsContext.Provider>
    );
}
