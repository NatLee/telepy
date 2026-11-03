"use client";

/**
 * 網路頁的終端機 dock：在這頁開區網主機的終端機，不必跳到終端機頁。它是一塊**浮在內容上方**的面板（fixed，
 * 離視窗底一點距離、四角圓角、有陰影、彈出動畫），寬度跟著頁面那一欄（`anchorRef` 量出來的），不是貼在內容
 * 下面的一條。每個 session 一個分頁（狀態點 + 帳號@主機），「+」在同一台機器再開一個 shell，換分頁 / 換主機都
 * 不會斷；可縮小成一條、一般高度、或放大成整個視窗的覆蓋層（Esc 還原）。「在終端機頁開啟」把作用中的那台帶到
 * 完整的終端機頁。所有 session 都掛著，只顯示作用中的那個。
 * The network page's terminal dock: LAN-host terminals open right here. It is a panel **floating above the
 * content** (fixed, a little off the bottom edge, rounded on every corner, shadowed, popping in), as wide as the
 * page column (`anchorRef` is measured), not a strip glued under the tree. One tab per session, "+" opens another
 * shell on the same machine, switching never disconnects. Minimise to a bar, normal height, or maximise into a
 * full-window overlay (Esc restores). "Open in the terminal page" takes the active machine to the full page.
 * Every session stays mounted.
 *
 * 也放網頁：一個遠端瀏覽器分頁（地球圖示 + 網址），同一台裝置再開的網頁是它裡面的新分頁。分頁的 × 就是停止，
 * IME 開關在標題列；縮小時畫面保持原本的大小只是被藏起來（KasmVNC 不會被要求縮成 0）。
 * Web pages too: one remote-browser tab (globe + URL); more pages on the same device open as tabs inside it. The
 * tab's × stops it and the IME switch sits in the bar; when minimised it keeps its size, just hidden (KasmVNC is
 * never asked to shrink to nothing).
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Globe, Languages, Maximize2, Minimize2, Plus, RotateCw, SquareArrowOutUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { lanAuthParam } from "@/lib/lanAuth";
import { LanTerminal } from "@/components/network/LanTerminal";
import { RemoteBrowserPanel, type RemoteBrowserPhase } from "@/components/tunnels/RemoteBrowserPanel";
import { shortUrl } from "@/lib/lanWeb";
import { MAX_LAN_TERMINALS, type DockSize, type LanBrowserSession, type LanTerminalSession, type LanTerminalStatus } from "@/hooks/useLanTerminals";

/** dock 本體高度（頁面底部要留這麼多空間，免得被蓋住）。放大是覆蓋層，不佔版面。/ Body height; the page keeps that much room below. */
export const DOCK_HEIGHT: Record<DockSize, string> = {
    min: "0px",
    normal: "min(24rem, 45vh)",
    max: "0px",
};
/** dock 本體現在的高度（瀏覽器跟終端機一樣高：更高的話頁面上面只剩標題；要大就放大）。
 *  The dock body's height (the browser as tall as terminals: any taller leaves the page above with only its title; maximise for more). */
export function dockBodyHeight(size: DockSize): string {
    return DOCK_HEIGHT[size];
}

const BROWSER_DOT: Record<RemoteBrowserPhase, string> = {
    connecting: "bg-warning animate-pulse",
    connected: "bg-success",
    idle: "bg-muted-foreground/45",
};

/** 標題列高度。/ Header bar height. */
export const DOCK_BAR = "2.75rem";
/** 浮動面板離視窗底的距離。/ The floating panel's gap from the bottom edge. */
export const DOCK_GAP = "1rem";

const DOT: Record<LanTerminalStatus, string> = {
    connecting: "bg-warning animate-pulse",
    connected: "bg-success",
    closed: "bg-muted-foreground/45",
};

interface Props {
    sessions: LanTerminalSession[];
    activeKey: number | null;
    size: DockSize;
    onSelect: (key: number) => void;
    onDuplicate: (key: number) => boolean;
    onClose: (key: number) => void;
    onCloseAll: () => void;
    onReconnect: (key: number) => void;
    onStatus: (key: number, status: LanTerminalStatus) => void;
    /** 分頁的 shell id 變了（斷線保留）。/ A tab's kept shell id changed. */
    onShell?: (key: number, shellId: string | null) => void;
    setSize: (size: DockSize) => void;
    /** 頁面那一欄：浮動面板的左右邊跟著它。/ The page column the floating panel aligns with. */
    anchorRef: React.RefObject<HTMLElement | null>;
    /** dock 裡的遠端瀏覽器（沒有 = null）。/ The dock's remote browser (null = none). */
    browser?: LanBrowserSession | null;
    onCloseBrowser?: () => void;
    onBrowserPhase?: (phase: RemoteBrowserPhase) => void;
}

/** 量 anchor 的左緣與寬度（側欄收合、視窗縮放時會變）。/ The anchor's left edge and width (sidebar collapse, resizes). */
function useAnchorBox(anchorRef: React.RefObject<HTMLElement | null>, enabled: boolean) {
    const [box, setBox] = useState<{ left: number; width: number } | null>(null);
    useEffect(() => {
        if (!enabled) return;
        const el = anchorRef.current;
        if (!el) return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            setBox((prev) => (prev && prev.left === r.left && prev.width === r.width ? prev : { left: r.left, width: r.width }));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        // 側欄收合是 200 ms 的寬度動畫，ResizeObserver 會一路跟著；視窗縮放另外聽。/ The sidebar animates; the observer follows.
        window.addEventListener("resize", measure);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [anchorRef, enabled]);
    return box;
}

export function sessionLabel(s: LanTerminalSession): string {
    return s.login ? `${s.login}@${s.hostName}` : s.hostName;
}

export function TerminalDock({ sessions, activeKey, size, onSelect, onDuplicate, onClose, onCloseAll, onReconnect, onStatus, onShell, setSize, anchorRef, browser = null, onCloseBrowser, onBrowserPhase }: Props) {
    const { t } = useI18n();
    const maximized = size === "max";
    const open = sessions.length > 0 || !!browser;
    const box = useAnchorBox(anchorRef, open && !maximized);
    // 瀏覽器的中日文輸入（預設開）。/ The browser's IME input (on by default).
    const [ime, setIme] = useState(true);

    // 放大時 Esc 還原（沒有對話框開著時）。Esc 打在終端機或網頁裡是給它們的（vim、網頁的對話框），不還原。
    // Esc restores from the overlay — except when typed into a terminal or the web page, where it belongs to them (vim, a page's dialog).
    useEffect(() => {
        if (!maximized) return;
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement | null;
            if (el?.closest?.(".xterm, [data-dock-keys]")) return;
            if (e.key === "Escape" && !document.querySelector("[role=dialog]")) setSize("normal");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [maximized, setSize]);

    if (!open) return null;
    const active = sessions.find((s) => s.key === activeKey) ?? null;
    const browserActive = !!browser && browser.key === activeKey;
    const canAdd = sessions.length < MAX_LAN_TERMINALS && !!active;
    const pageHref = active
        ? getTerminalPageUrl({ id: active.tunnelId, reverse_port: active.reversePort }, { lanHost: active.hostId, lanUser: active.login || undefined, lanAuth: lanAuthParam(active.auth) })
        : browserActive && browser
            ? getTerminalPageUrl({ id: browser.tunnelId, reverse_port: browser.reversePort }, { mainView: "browser", browserUrl: browser.url, account: browser.deviceUser })
            : null;

    return (
        <section
            aria-label={t("network.dock.title")}
            className={cn(
                "fixed z-40 flex flex-col overflow-hidden border-border bg-card",
                maximized
                    ? "inset-0 border-0"
                    : "rounded-xl border shadow-dialog animate-pop-in",
            )}
            // 浮在頁面那一欄上方：左右跟著欄、離底一點距離（量不到時先貼齊視窗左右）。/ Floats over the page column; falls back to the viewport edges.
            style={maximized ? undefined : { bottom: DOCK_GAP, left: box ? box.left : 16, width: box ? box.width : "calc(100vw - 2rem)" }}
        >
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5" style={{ height: DOCK_BAR }}>
                <div role="tablist" aria-label={t("network.dock.title")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {browser && (
                        <div className={cn("group flex shrink-0 items-center rounded-md border text-sm", browserActive ? "border-border bg-surface text-foreground" : "border-transparent text-muted-foreground hover:bg-muted")}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={browserActive}
                                onClick={() => onSelect(browser.key)}
                                title={t("network.dock.browserVia", { url: browser.url, device: browser.tunnelName, user: browser.deviceUser })}
                                className="flex items-center gap-2 py-1 pl-2.5 pr-1"
                            >
                                <span className={cn("size-1.5 shrink-0 rounded-full", BROWSER_DOT[browser.phase])} aria-hidden />
                                <Globe size={13} className="hidden shrink-0 sm:block" aria-hidden />
                                <span className="max-w-[14rem] truncate font-mono text-[0.8125rem]">{shortUrl(browser.url)}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => onCloseBrowser?.()}
                                aria-label={t("network.dock.closeBrowser")}
                                title={t("network.dock.closeBrowser")}
                                className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <X size={13} />
                            </button>
                        </div>
                    )}
                    {sessions.map((s) => {
                        const selected = s.key === activeKey;
                        const label = sessionLabel(s);
                        return (
                            <div
                                key={s.key}
                                className={cn(
                                    "group flex shrink-0 items-center rounded-md border text-sm",
                                    selected ? "border-border bg-surface text-foreground" : "border-transparent text-muted-foreground hover:bg-muted"
                                )}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    onClick={() => onSelect(s.key)}
                                    title={t("network.dock.via", { device: s.tunnelName, user: s.deviceUser })}
                                    className="flex items-center gap-2 py-1 pl-2.5 pr-1"
                                >
                                    <span className={cn("size-1.5 shrink-0 rounded-full", DOT[s.status])} aria-hidden />
                                    <span className="max-w-[14rem] truncate font-mono text-[0.8125rem]">{label}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onClose(s.key)}
                                    aria-label={t("network.dock.closeSession", { name: label })}
                                    className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        );
                    })}
                    {!browserActive && <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        disabled={!canAdd}
                        onClick={() => active && onDuplicate(active.key)}
                        aria-label={t("network.dock.newShell")}
                        title={canAdd ? t("network.dock.newShell") : t("network.terminalLimit", { count: MAX_LAN_TERMINALS })}
                    >
                        <Plus size={16} />
                    </Button>}
                </div>
                <div className="flex shrink-0 items-center">
                    {browserActive && browser?.phase === "connected" && (
                        <Button
                            variant={ime ? "secondary" : "ghost"}
                            size="sm"
                            className="h-8 gap-1 px-2"
                            onClick={() => setIme((v) => !v)}
                            aria-pressed={ime}
                            aria-label="IME"
                            title={t("browser.imeTitle")}
                        >
                            <Languages size={14} /> <span className="hidden sm:inline">IME</span>
                        </Button>
                    )}
                    {pageHref && (
                        <Button variant="ghost" size="icon" className="size-8" asChild title={browserActive ? t("network.dock.openBrowserPage") : t("network.dock.openPage")} aria-label={browserActive ? t("network.dock.openBrowserPage") : t("network.dock.openPage")}>
                            <Link href={pageHref} prefetch={false}>
                                <SquareArrowOutUpRight size={15} />
                            </Link>
                        </Button>
                    )}
                    {!maximized && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setSize(size === "min" ? "normal" : "min")}
                            aria-label={size === "min" ? t("network.dock.restore") : t("network.dock.minimize")}
                            title={size === "min" ? t("network.dock.restore") : t("network.dock.minimize")}
                        >
                            {size === "min" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setSize(maximized ? "normal" : "max")}
                        aria-label={maximized ? t("network.dock.restore") : t("network.dock.maximize")}
                        title={maximized ? t("network.dock.restore") : t("network.dock.maximize")}
                    >
                        {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </Button>
                    <Button variant="ghost" size="icon" className="size-8" onClick={onCloseAll} aria-label={t("network.dock.closeAll")} title={t("network.dock.closeAll")}>
                        <X size={16} />
                    </Button>
                </div>
            </div>
            <div className={cn("relative overflow-hidden bg-black", maximized ? "min-h-0 flex-1" : "transition-[height] duration-200")} style={maximized ? undefined : { height: dockBodyHeight(size) }}>
                {browser && (
                    // 不顯示時只藏起來、大小不變：KasmVNC 會照容器大小改遠端畫面。/ Hidden, never resized: KasmVNC resizes the remote screen to its box.
                    <div
                        data-dock-keys
                        className={cn("absolute inset-x-0 top-0 flex flex-col", browserActive && size !== "min" ? "z-10" : "invisible pointer-events-none")}
                        style={{ height: maximized ? "100%" : DOCK_HEIGHT.normal }}
                    >
                        <RemoteBrowserPanel
                            key={browser.key}
                            serverId={String(browser.tunnelId)}
                            username={browser.deviceUser}
                            startUrl={browser.startUrl}
                            autoStart
                            openRequest={{ url: browser.url, n: browser.openN }}
                            onPhase={onBrowserPhase}
                            bare
                            ime={ime}
                        />
                    </div>
                )}
                {sessions.map((s) => (
                    <LanTerminal key={`${s.key}`} session={s} visible={size !== "min" && s.key === activeKey} onStatus={onStatus} onShell={onShell} />
                ))}
                {active && active.status === "closed" && size !== "min" && (
                    <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-pop">
                        <span className="text-muted-foreground">{t("network.dock.closed")}</span>
                        <Button size="sm" variant="outline" onClick={() => onReconnect(active.key)}>
                            <RotateCw size={14} /> {t("network.dock.reconnect")}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}
