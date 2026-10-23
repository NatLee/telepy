"use client";

/**
 * 網路頁底部的終端機 dock：在這頁開區網主機的終端機，不必跳到終端機頁。每個 session 一個分頁（狀態點 + 帳號@主機），
 * 換分頁 / 換主機都不會斷；可縮小成一條、一般高度、或放大。所有 session 都掛著，只顯示作用中的那個。
 * The network page's terminal dock: LAN-host terminals open right here. One tab per session; switching
 * never disconnects. Minimise to a bar, normal height, or maximise. Every session stays mounted.
 */
import React from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { LanTerminal } from "@/components/network/LanTerminal";
import type { DockSize, LanTerminalSession, LanTerminalStatus } from "@/hooks/useLanTerminals";

/** dock 本體高度（給主機面板扣掉，免得被蓋住）。/ Body height, also subtracted from the host panel. */
export const DOCK_HEIGHT: Record<DockSize, string> = {
    min: "0px",
    normal: "min(22rem, 40vh)",
    max: "calc(100vh - 10rem)",
};
/** 標題列高度。/ Header bar height. */
export const DOCK_BAR = "2.75rem";

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
    onClose: (key: number) => void;
    onCloseAll: () => void;
    onReconnect: (key: number) => void;
    onStatus: (key: number, status: LanTerminalStatus) => void;
    setSize: (size: DockSize) => void;
}

export function sessionLabel(s: LanTerminalSession): string {
    return s.login ? `${s.login}@${s.hostName}` : s.hostName;
}

export function TerminalDock({ sessions, activeKey, size, onSelect, onClose, onCloseAll, onReconnect, onStatus, setSize }: Props) {
    const { t } = useI18n();
    if (sessions.length === 0) return null;
    const active = sessions.find((s) => s.key === activeKey) ?? null;

    return (
        <section
            aria-label={t("network.dock.title")}
            className="sticky bottom-0 z-30 mt-6 overflow-hidden rounded-t-xl border border-b-0 border-border bg-card shadow-dialog"
        >
            <div className="flex items-center gap-1 border-b border-border px-1.5" style={{ height: DOCK_BAR }}>
                <div role="tablist" aria-label={t("network.dock.title")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
                </div>
                <div className="flex shrink-0 items-center">
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
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setSize(size === "max" ? "normal" : "max")}
                        aria-label={size === "max" ? t("network.dock.restore") : t("network.dock.maximize")}
                        title={size === "max" ? t("network.dock.restore") : t("network.dock.maximize")}
                    >
                        {size === "max" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </Button>
                    <Button variant="ghost" size="icon" className="size-8" onClick={onCloseAll} aria-label={t("network.dock.closeAll")} title={t("network.dock.closeAll")}>
                        <X size={16} />
                    </Button>
                </div>
            </div>
            <div className="relative bg-black transition-[height] duration-200" style={{ height: DOCK_HEIGHT[size] }}>
                {sessions.map((s) => (
                    <LanTerminal key={`${s.key}`} session={s} visible={size !== "min" && s.key === activeKey} onStatus={onStatus} />
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
