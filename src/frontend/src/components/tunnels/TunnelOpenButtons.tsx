/**
 * 「開啟」四顆按鈕：終端機 / 檔案 / 瀏覽器 / 遠端桌面，一律帶文字標籤（卡片是圖示在上的方塊，標籤可換行不截斷；
 * 表格是精簡橫排）。線上時終端機是實色主色、其餘外框；離線一律淡色。沒有光暈、位移或放大。
 * The four "open" actions — Terminal / Files / Browser / Desktop — always labelled (tiles on cards, where labels
 * wrap instead of truncating; a compact row in the table). Online: Terminal is solid primary, the others outlined;
 * offline: all muted. No glow, lift or scale.
 *
 * prefetch={false}：terminal 是「點了才進」的重頁（xterm/VNC），每條隧道三條連結，N 條隧道 = 3N 次 route
 * prefetch，載入時一次湧出把伺服器/連線塞爆，害真正在等的 dashboard/profile 排隊變慢。點擊時才載入。
 * Don't prefetch the heavy terminal route for every tunnel — the prefetch storm starves the requests that
 * actually gate the list spinner.
 */
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderOpen, MonitorPlay, ScreenShare, TerminalSquare, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { getTerminalPageUrl, type TerminalMainView } from "@/lib/tunnelUrls";
import { Tunnel } from "@/types/tunnel";
import { requestStepUp, stepUpToken } from "@/lib/stepUp";
import { useFeatures } from "@/hooks/useFeatures";
import type { FeatureId } from "@/lib/features";

type OpenAction = { view: TerminalMainView | "desktop"; icon: LucideIcon; label: TranslationKey; hint: TranslationKey; feature: FeatureId };
const OPEN_ACTIONS: OpenAction[] = [
    { view: "terminal", icon: TerminalSquare, label: "common.terminal", hint: "tunnelActions.terminalHint", feature: "terminal" },
    { view: "files", icon: FolderOpen, label: "common.files", hint: "tunnelActions.filesHint", feature: "files" },
    { view: "browser", icon: MonitorPlay, label: "common.browser", hint: "tunnelActions.browserHint", feature: "remote_browser" },
    // 遠端桌面頁（RDP / VNC / RustDesk）：裝置預選好。/ The remote desktop page with this device preselected.
    { view: "desktop", icon: ScreenShare, label: "common.desktop", hint: "tunnelActions.desktopHint", feature: "remote_desktop" },
];
/** 按鈕數 → 方塊排法（四顆的照舊；少了就平均分）。/ Tile columns per button count. */
const TILE_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 @[19rem]:grid-cols-4" };

/** 每顆按鈕去哪：三個主畫面進終端機頁，桌面進遠端桌面頁。/ Where each action goes. */
function actionHref(tunnel: Tunnel, view: OpenAction["view"]): string {
    return view === "desktop" ? `/tunnels/desktop?tunnel=${tunnel.id}` : getTerminalPageUrl(tunnel, { mainView: view });
}

interface TunnelOpenButtonsProps {
    tunnel: Tunnel;
    online: boolean;
    /** 隧道在但 sshd 沒回應：看起來跟離線一樣（點了也連不上），提示換成降級的說明。/ Degraded: styled as offline, with the degraded hint. */
    degraded?: boolean;
    variant?: "tiles" | "compact";
}

export function TunnelOpenButtons({ tunnel, online, degraded = false, variant = "tiles" }: TunnelOpenButtonsProps) {
    const { t } = useI18n();
    const router = useRouter();
    // 管理員替這個人關掉的功能不顯示（API 也會拒絕）。/ Features turned off for this person are not shown.
    const { has } = useFeatures();
    const actions = OPEN_ACTIONS.filter((a) => has(a.feature));
    // 敏感隧道：先確認是你再進去（免得一進去就被擋）；按著修飾鍵開新分頁就照常，交給那一頁處理。
    // Sensitive tunnel: confirm it's you before navigating (instead of failing on arrival); modified clicks pass through.
    const gate = (href: string) => (e: React.MouseEvent) => {
        if (!tunnel.require_step_up || stepUpToken() || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        void requestStepUp().then((ok) => ok && router.push(href));
    };
    // 離線時仍可點（terminal 頁會自己顯示錯誤），但以淡色 + 提示說明現在連不上。
    // Still clickable while offline (the terminal page reports it), but muted with a hint explaining why.
    const offlineHint = degraded ? ` — ${t("tunnels.degradedHint")}` : online ? "" : ` — ${t("tunnelActions.offlineHint")}`;
    online = online && !degraded;

    if (actions.length === 0) return null;

    if (variant === "compact") {
        // 表格列：表格夠寬（容器 ≥ 84rem，日文的四個標籤也放得下）才顯示文字，不然只有圖示（名稱在 title / aria-label）。
        // 四顆帶字的按鈕要 300–420px，窄一點的表格就被它們撐到要橫向捲動。
        // Table rows: labels only where the table is wide enough (container ≥ 84rem, room for the Japanese labels too),
        // icons alone otherwise (the name stays in title / aria-label) — four labelled buttons take 300–420px and
        // forced narrower tables into horizontal scrolling.
        return (
            <div className="inline-flex items-center rounded-md border border-border bg-surface p-0.5">
                {actions.map(({ view, icon: Icon, label, hint }) => (
                    <Link
                        key={view}
                        href={actionHref(tunnel, view)}
                        onClick={gate(actionHref(tunnel, view))}
                        prefetch={false}
                        title={`${t(hint)}${offlineHint}`}
                        aria-label={t(label)}
                        className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs transition-colors @[84rem]:px-2.5",
                            online
                                ? "text-foreground hover:bg-card hover:ring-1 hover:ring-border"
                                : "text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground"
                        )}
                    >
                        <Icon size={14} className={online && view === "terminal" ? "text-success" : undefined} />
                        <span className="hidden @[84rem]:inline">{t(label)}</span>
                    </Link>
                ))}
            </div>
        );
    }

    return (
        // 四顆一排要 19rem 才放得下（日文的「ターミナル」/「デスクトップ」），更窄（或放大顯示）就排成 2×2，
        // 標籤不會被拆成一字一行。/ Four across needs 19rem (Japanese labels); narrower cards (or a larger display
        // size) fall back to 2×2 so a label never breaks into one character per line.
        <div className="@container">
        <div className={cn("grid gap-2", TILE_COLS[actions.length])}>
            {actions.map(({ view, icon: Icon, label, hint }) => {
                const primary = view === "terminal";
                return (
                    <Link
                        key={view}
                        href={actionHref(tunnel, view)}
                        onClick={gate(actionHref(tunnel, view))}
                        prefetch={false}
                        title={`${t(hint)}${offlineHint}`}
                        className={cn(
                            "flex flex-col items-center justify-center gap-1 rounded-md border px-1 py-2.5 text-xs transition-colors duration-150",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !online && "border-border bg-surface text-muted-foreground/80 hover:bg-muted hover:text-muted-foreground",
                            online && primary && "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
                            online && !primary && "border-input bg-card text-foreground hover:bg-muted hover:border-foreground/30"
                        )}
                    >
                        <Icon size={18} />
                        {/* 四顆並排時標籤可以換行（日文的「ターミナル」），不截成「…」。/ Labels wrap in four columns instead of truncating. */}
                        <span className="max-w-full text-center leading-tight [overflow-wrap:anywhere]">{t(label)}</span>
                    </Link>
                );
            })}
        </div>
        </div>
    );
}
