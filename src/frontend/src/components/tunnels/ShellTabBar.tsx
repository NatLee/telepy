/**
 * Shell 分頁列：多個獨立 shell session 的切換 / 新增 / 關閉。
 * Shell tab bar: switch / add / close independent shell sessions.
 *
 * - 桌面與手機共用；手機加大觸控目標（h-8）並可橫向捲動（隱藏捲軸）。
 *   Shared across desktop & mobile; larger touch targets and horizontal scroll on mobile.
 * - 狀態點：黃（連線中）/ 綠（已連線）/ 紅（已結束）。/ Status dot: yellow / green / red.
 * - 關閉鈕用 span（非 button）避免巢狀 button 的無效 HTML。/ Close is a span to avoid nested buttons.
 */
import React from "react";
import { Plus, X } from "lucide-react";
import { ShellTab, MAX_SHELL_TABS } from "@/hooks/useTerminalPage";
import { useI18n } from "@/lib/i18n";

interface ShellTabBarProps {
    tabs: ShellTab[];
    activeTabId: number | null;
    onSelect: (id: number) => void;
    onAdd: () => void;
    onClose: (id: number) => void;
}

function statusDotClass(status: ShellTab["status"]): string {
    switch (status) {
        case "connecting":
            return "bg-warning animate-pulse";
        case "connected":
            return "bg-success";
        default:
            return "bg-destructive";
    }
}

export function ShellTabBar({ tabs, activeTabId, onSelect, onAdd, onClose }: ShellTabBarProps) {
    const { t } = useI18n();
    const canAdd = tabs.length < MAX_SHELL_TABS;

    return (
        <div
            className="flex items-center gap-1 px-1.5 pt-1.5 pb-1 shrink-0 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label={t("terminal.shellTabsAria")}
        >
            {tabs.map((tab) => {
                const active = tab.id === activeTabId;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onSelect(tab.id)}
                        title={`${t("terminal.shellTabTitle", { title: tab.title, user: tab.username })}${tab.status === "closed" ? t("terminal.shellDisconnectedSuffix") : ""}`}
                        className={`group flex items-center gap-1.5 h-8 md:h-7 px-2.5 rounded-md text-xs font-mono whitespace-nowrap transition-colors select-none ${
                            active
                                ? "bg-white/15 text-white"
                                : "text-white/50 hover:text-white/80 hover:bg-white/5"
                        }`}
                    >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${statusDotClass(tab.status)}`} />
                        <span className="shrink-0">{tab.title}</span>
                        <span className="max-w-[72px] md:max-w-[96px] truncate opacity-70">{tab.username}</span>
                        <span
                            role="button"
                            aria-label={t("terminal.closeShell", { title: tab.title })}
                            onClick={(e) => {
                                e.stopPropagation();
                                onClose(tab.id);
                            }}
                            className={`ml-0.5 -mr-1 rounded p-0.5 transition-opacity hover:bg-white/20 ${
                                active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70 max-md:opacity-50"
                            }`}
                        >
                            <X size={12} />
                        </span>
                    </button>
                );
            })}

            <button
                type="button"
                onClick={onAdd}
                disabled={!canAdd}
                title={canAdd ? t("terminal.newShell") : t("terminal.maxShells", { max: MAX_SHELL_TABS })}
                aria-label={t("terminal.newShell")}
                className="flex items-center justify-center h-8 w-8 md:h-7 md:w-7 rounded-md text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent shrink-0 transition-colors"
            >
                <Plus size={14} />
            </button>
        </div>
    );
}
