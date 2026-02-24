/**
 * Shared props interface for all terminal layout components.
 * Each layout receives the same set of props and renders Terminal / Files / Remote panels differently.
 */
import { RefObject } from "react";

export interface LayoutProps {
    activeTab: "terminal" | "files" | "remote";
    setActiveTab: (tab: "terminal" | "files" | "remote") => void;
    connected: boolean;
    connecting: boolean;
    showFileManager: boolean;
    setShowFileManager: (show: boolean) => void;
    showRemoteBrowser: boolean;
    setShowRemoteBrowser: (show: boolean) => void;
    setIsBrowserActive: (isActive: boolean) => void;
    terminalRef: RefObject<HTMLDivElement | null>;
    serverId: string;
    username: string | null;
    accessToken: string | null;
    syncedPath: string | undefined;
}
