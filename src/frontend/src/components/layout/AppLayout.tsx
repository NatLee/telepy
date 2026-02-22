"use client";

import React, { createContext, useContext, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useNotificationWebSocket } from "@/lib/websocket";

/** Context exposing the notification WebSocket connection status */
const NotificationWsContext = createContext<{ isConnected: boolean }>({ isConnected: false });
export const useNotificationWsStatus = () => useContext(NotificationWsContext);

export function AppLayout({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    // Establish global notification websocket when logged in
    const { isConnected } = useNotificationWebSocket();
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
                <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin"></div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return null; // Will redirect in useEffect
    }

    return (
        <NotificationWsContext.Provider value={{ isConnected }}>
            <div className="flex min-h-screen w-full bg-background font-sans">
                <Sidebar />
                <div className="flex flex-col flex-1 w-full min-w-0">
                    <Header />
                    <main className={`flex-1 w-full ${isTerminalPage ? 'p-0 flex flex-col' : 'px-4 sm:px-6 lg:px-8 py-8'}`}>
                        {children}
                    </main>
                </div>
            </div>
        </NotificationWsContext.Provider>
    );
}
