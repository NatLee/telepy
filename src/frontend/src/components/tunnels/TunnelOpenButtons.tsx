/**
 * 「開啟」三顆按鈕：終端機 / 檔案 / 瀏覽器，一律帶文字標籤（卡片是圖示在上的方塊，表格是精簡橫排）。
 * The three "open" actions — Terminal / Files / Browser — always labelled (tiles on cards, a compact row in the table).
 *
 * prefetch={false}：terminal 是「點了才進」的重頁（xterm/VNC），每條隧道三條連結，N 條隧道 = 3N 次 route
 * prefetch，載入時一次湧出把伺服器/連線塞爆，害真正在等的 dashboard/profile 排隊變慢。點擊時才載入。
 * Don't prefetch the heavy terminal route for every tunnel — the prefetch storm starves the requests that
 * actually gate the list spinner.
 */
import React from "react";
import Link from "next/link";
import { FolderOpen, MonitorPlay, TerminalSquare, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { getTerminalPageUrl, type TerminalMainView } from "@/lib/tunnelUrls";
import { Tunnel } from "@/types/tunnel";

const OPEN_ACTIONS: { view: TerminalMainView; icon: LucideIcon; label: TranslationKey; hint: TranslationKey }[] = [
    { view: "terminal", icon: TerminalSquare, label: "common.terminal", hint: "tunnelActions.terminalHint" },
    { view: "files", icon: FolderOpen, label: "common.files", hint: "tunnelActions.filesHint" },
    { view: "browser", icon: MonitorPlay, label: "common.browser", hint: "tunnelActions.browserHint" },
];

interface TunnelOpenButtonsProps {
    tunnel: Tunnel;
    online: boolean;
    variant?: "tiles" | "compact";
}

export function TunnelOpenButtons({ tunnel, online, variant = "tiles" }: TunnelOpenButtonsProps) {
    const { t } = useI18n();
    // 離線時仍可點（terminal 頁會自己顯示錯誤），但以淡色 + 提示說明現在連不上。
    // Still clickable while offline (the terminal page reports it), but muted with a hint explaining why.
    const offlineHint = online ? "" : ` — ${t("tunnelActions.offlineHint")}`;

    if (variant === "compact") {
        return (
            <div className="inline-flex items-center rounded-lg border border-border bg-background/60 p-0.5">
                {OPEN_ACTIONS.map(({ view, icon: Icon, label, hint }) => (
                    <Link
                        key={view}
                        href={getTerminalPageUrl(tunnel, { mainView: view })}
                        prefetch={false}
                        title={`${t(hint)}${offlineHint}`}
                        className={cn(
                            "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors",
                            online
                                ? "text-foreground hover:bg-primary/10 hover:text-primary"
                                : "text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground"
                        )}
                    >
                        <Icon size={14} className={online && view === "terminal" ? "text-primary" : undefined} />
                        {t(label)}
                    </Link>
                ))}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-3 gap-2">
            {OPEN_ACTIONS.map(({ view, icon: Icon, label, hint }) => {
                const primary = view === "terminal";
                return (
                    <Link
                        key={view}
                        href={getTerminalPageUrl(tunnel, { mainView: view })}
                        prefetch={false}
                        title={`${t(hint)}${offlineHint}`}
                        className={cn(
                            "group/open flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-medium transition-all duration-200",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !online && "border-dashed border-border text-muted-foreground/80 hover:bg-muted/60",
                            online && primary && "border-transparent bg-primary text-primary-foreground shadow-glow hover:-translate-y-px hover:bg-primary/90",
                            online && !primary && "border-border bg-background/60 text-foreground hover:-translate-y-px hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                        )}
                    >
                        <Icon size={18} className="transition-transform group-hover/open:scale-110" />
                        <span className="truncate max-w-full">{t(label)}</span>
                    </Link>
                );
            })}
        </div>
    );
}
