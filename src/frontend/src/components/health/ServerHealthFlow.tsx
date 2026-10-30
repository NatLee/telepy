"use client";

/**
 * 「伺服器狀態」的即時說明圖：一台 Telepy 伺服器的各個部分，依最新的檢查結果亮起。
 * 主線（訪客的請求怎麼走）：訪客的瀏覽器 ─ 代理 / Traefik ─ Telepy 後端 ─ 磁碟上的資料；
 * 從後端往下分出去：SSH 閘道 ─ 裝置、guacd、kasm-browser、GeoIP + OUI 檔。只用直線與直角。
 * 寬容器：主線橫排、旁支是後端下方的一條匯流線；窄容器：直排，旁支是後端下面的樹。每一站都能點（鍵盤可聚焦），
 * 點了呼叫 `onPick(分頁)`。狀態算法在 lib/serverHealthFlow（純函式，有測試）。
 * Live Server health diagram: the parts of a Telepy server, lit by the latest check results. Main path (how a
 * visitor's request travels): visitor's browser ─ proxy / Traefik ─ backend ─ data on disk; branches down from the
 * backend: SSH gateway ─ devices, guacd, kasm-browser, GeoIP + OUI files. Straight lines and right angles only.
 * Wide container: the main path in a row and the branches on a bus below the backend; narrow: one column with the
 * branches as a tree under the backend. Every spot is a button that calls `onPick(tab)`.
 */
import React from "react";
import { CheckCircle2, CircleDashed, Cpu, Database, FileSearch, Globe, KeyRound, Laptop, Network, ScreenShare, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { healthSpots, type HealthSpot, type HealthSpotState, type SpotInfo } from "@/lib/serverHealthFlow";
import type { HealthTab, ServerHealth } from "@/lib/serverHealth";
import type { TranslationKey } from "@/locales/en";

const TONE: Record<HealthSpotState, string> = {
    waiting: "text-muted-foreground",
    ok: "text-success",
    warn: "text-warning",
    failed: "text-destructive",
};

const BORDER: Record<HealthSpotState, string> = {
    waiting: "border-border",
    ok: "border-success/50",
    warn: "border-warning/60",
    failed: "border-destructive/70",
};

/** 線：通 = 實線、要注意 = 虛線、壞了 = 點線、沒資料 = 淡虛線。/ Lines: solid / dashed / dotted / faint dashed. */
const LINE: Record<HealthSpotState, string> = {
    waiting: "border-dashed border-border",
    ok: "border-solid border-success/60",
    warn: "border-dashed border-warning/70",
    failed: "border-dotted border-destructive/70",
};

export const STATE_ICON: Record<HealthSpotState, LucideIcon> = { waiting: CircleDashed, ok: CheckCircle2, warn: TriangleAlert, failed: XCircle };

const STATUS_TEXT: Record<string, TranslationKey> = {
    ok: "health.status.ok",
    info: "health.status.info",
    warn: "health.status.warn",
    fail: "health.status.fail",
};

interface SpotMeta {
    icon?: LucideIcon;
    brand?: boolean;
    title: TranslationKey;
    sub: TranslationKey;
}

export const SPOT_META: Record<HealthSpot, SpotMeta> = {
    visitor: { icon: Laptop, title: "health.flow.visitor", sub: "health.flow.visitorSub" },
    proxy: { icon: Network, title: "health.flow.proxy", sub: "health.flow.proxySub" },
    backend: { brand: true, title: "health.flow.backend", sub: "health.flow.backendSub" },
    disk: { icon: Database, title: "health.flow.disk", sub: "health.flow.diskSub" },
    gateway: { icon: KeyRound, title: "health.flow.gateway", sub: "health.flow.gatewaySub" },
    devices: { icon: Cpu, title: "health.flow.devices", sub: "health.flow.devicesSub" },
    guacd: { icon: ScreenShare, title: "health.flow.guacd", sub: "health.flow.guacdSub" },
    kasm: { icon: Globe, title: "health.flow.kasm", sub: "health.flow.kasmSub" },
    lookups: { icon: FileSearch, title: "health.flow.lookups", sub: "health.flow.lookupsSub" },
};

/** 一站的狀態文字：還在跑 / 這裡不檢查 / 沒回報 / 最嚴重那級（+ 出問題的檢查名）。/ A spot's status text. */
function useStateText() {
    const { t } = useI18n();
    return (info: SpotInfo, loaded: boolean): string => {
        if (info.unchecked && info.status === null) return t(loaded ? "health.flow.state.notChecked" : "health.flow.state.checking");
        if (!loaded) return t("health.flow.state.checking");
        if (info.status === null) return t("health.flow.state.missing");
        // 確認過的 ⚠ / ✗ 不讓這站變色，只說「已確認」。/ Acknowledged problems don't colour the spot; they read "Acknowledged".
        const bad = info.checks.filter((c) => (c.status === "fail" || c.status === "warn") && !info.acked.includes(c));
        if (bad.length) return `${t(STATUS_TEXT[info.status])} · ${bad.map((c) => c.name).join(", ")}`;
        if (info.acked.length) return `${t("health.ack.state")} · ${info.acked.map((c) => c.name).join(", ")}`;
        return t(STATUS_TEXT[info.status]);
    };
}

function StateText({ state, text }: { state: HealthSpotState; text: string }) {
    const Icon = STATE_ICON[state];
    return (
        <span className={cn("inline-flex min-w-0 items-start gap-1 text-xs leading-snug", TONE[state])}>
            <Icon size={13} className="mt-px shrink-0" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        </span>
    );
}

function Tile({ meta, size }: { meta: SpotMeta; size: "lg" | "sm" }) {
    const Icon = meta.icon;
    return (
        <span className={cn("grid shrink-0 place-items-center rounded-lg", size === "lg" ? "size-10" : "size-8", meta.brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
            {meta.brand ? <TelepyGlyph size={size === "lg" ? 22 : 18} /> : Icon ? <Icon size={size === "lg" ? 20 : 16} /> : null}
        </span>
    );
}

interface NodeProps {
    spot: HealthSpot;
    info: SpotInfo;
    loaded: boolean;
    onPick: (tab: HealthTab) => void;
    /** tile = 置中的大格（主線）；row = 圖示在左的矮列（旁支、窄畫面）。/ tile = centred (main row); row = icon left. */
    layout: "tile" | "row";
    className?: string;
}

/** 可點的一站。/ One clickable spot. */
function Node({ spot, info, loaded, onPick, layout, className }: NodeProps) {
    const { t } = useI18n();
    const stateText = useStateText();
    const meta = SPOT_META[spot];
    const text = stateText(info, loaded);
    return (
        <button
            type="button"
            onClick={() => onPick(info.tab)}
            title={t("health.flow.pickHint")}
            className={cn(
                "flex w-full min-w-0 rounded-xl border bg-card transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                info.unchecked && "border-dashed",
                layout === "tile" ? "h-full flex-col items-center gap-1.5 px-3 py-3 text-center" : "items-start gap-2.5 px-3 py-2 text-left",
                BORDER[info.state],
                className,
            )}
        >
            <Tile meta={meta} size={layout === "tile" ? "lg" : "sm"} />
            <span className={cn("flex min-w-0 flex-col gap-0.5", layout === "tile" ? "items-center" : "flex-1")}>
                <span className="max-w-full text-sm text-foreground [overflow-wrap:break-word]">{t(meta.title)}</span>
                <span className="text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{t(meta.sub)}</span>
                <StateText state={info.state} text={text} />
            </span>
        </button>
    );
}

/** 主線上兩站之間的橫線（寬畫面），標籤可點（代理那段本身就是一站）。/ A horizontal link of the main row. */
function HLink({ state, label, note, onClick }: { state: HealthSpotState; label: string; note?: string; onClick?: () => void }) {
    const body = (
        <>
            <span className={cn("block w-full border-t-2", LINE[state])} aria-hidden />
            <span className={cn("text-xs leading-tight", state === "failed" ? "text-destructive" : state === "warn" ? "text-warning" : "text-muted-foreground")}>
                {label}
                {note && <span className="block font-mono text-[0.7rem] text-foreground/80">{note}</span>}
            </span>
        </>
    );
    const cls = "flex min-w-0 flex-col items-center gap-1.5 self-center px-1.5 text-center";
    return onClick ? (
        <button type="button" onClick={onClick} className={cn(cls, "rounded-md py-1 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
            {body}
        </button>
    ) : (
        <div className={cls}>{body}</div>
    );
}

/** 窄畫面主線的直線段（標籤在右）。/ A vertical link of the narrow column, label on the right. */
function VLink({ state, label, note, onClick }: { state: HealthSpotState; label: string; note?: string; onClick?: () => void }) {
    const body = (
        <>
            <span className={cn("h-9 border-l-2", LINE[state])} aria-hidden />
            <span className={cn("text-xs leading-tight", state === "failed" ? "text-destructive" : state === "warn" ? "text-warning" : "text-muted-foreground")}>
                {label}
                {note && <span className="ml-1.5 font-mono text-[0.7rem] text-foreground/80">{note}</span>}
            </span>
        </>
    );
    const cls = "flex items-center gap-3 pl-[1.625rem] text-left";
    return onClick ? (
        <button type="button" onClick={onClick} className={cn(cls, "w-full rounded-md hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
            {body}
        </button>
    ) : (
        <div className={cls}>{body}</div>
    );
}

const BRANCHES: HealthSpot[] = ["gateway", "guacd", "kasm", "lookups"];

export function ServerHealthFlow({ health, onPick }: { health: ServerHealth | null; onPick: (tab: HealthTab) => void }) {
    const { t } = useI18n();
    const spots = healthSpots(health);
    const loaded = health !== null;
    const node = (spot: HealthSpot, layout: "tile" | "row", className?: string) => <Node spot={spot} info={spots[spot]} loaded={loaded} onPick={onPick} layout={layout} className={className} />;
    const proxyLabel = t("health.flow.proxy");
    const proxyNote = t("health.flow.proxySub");

    return (
        <div className="@container" aria-label={t("health.flow.title")} role="group">
            {/* 寬：主線橫排 + 後端下方的匯流線。中間欄的中心 = 50%，匯流線從第一欄中心到最後一欄中心（12.5%–87.5%）。
                Wide: the main row + a bus under the backend. The middle column's centre is 50%; the bus runs from the
                first branch column's centre to the last one's (12.5%–87.5%). */}
            <div className="hidden @3xl:block">
                <div className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_7rem_minmax(0,1fr)] items-stretch">
                    {node("visitor", "tile")}
                    <HLink state={spots.proxy.state} label={proxyLabel} note={proxyNote} onClick={() => onPick(spots.proxy.tab)} />
                    {node("backend", "tile")}
                    <HLink state={spots.disk.state} label={t("health.flow.diskLink")} />
                    {node("disk", "tile")}
                </div>
                <div className="flex flex-col items-center" aria-hidden>
                    <span className="h-5 border-l-2 border-border" />
                </div>
                <div className="relative grid grid-cols-4">
                    <span className="absolute top-0 right-[12.5%] left-[12.5%] border-t-2 border-border" aria-hidden />
                    <span className="absolute -top-2.5 left-1/2 ml-2 bg-card px-1 text-xs text-muted-foreground">{t("health.flow.branches")}</span>
                    {BRANCHES.map((spot) => (
                        <div key={spot} className="flex min-w-0 flex-col items-center px-1.5">
                            <span className={cn("h-5 border-l-2", LINE[spots[spot].state])} aria-hidden />
                            {node(spot, "row")}
                            {spot === "gateway" && (
                                <>
                                    <span className="flex flex-col items-center py-1" aria-hidden>
                                        <span className={cn("h-3 border-l-2", LINE[spots.gateway.state])} />
                                    </span>
                                    <span className="pb-1 text-center text-xs text-muted-foreground">{t("health.flow.tunnelLink")}</span>
                                    <span className="flex flex-col items-center pb-1" aria-hidden>
                                        <span className={cn("h-3 border-l-2", LINE.waiting)} />
                                    </span>
                                    {node("devices", "row")}
                                </>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* 窄：一欄；旁支是後端下面的樹（直線 + 直角的分枝）。/ Narrow: one column, the branches a tree under the backend. */}
            <div className="@3xl:hidden">
                {node("visitor", "row")}
                <VLink state={spots.proxy.state} label={proxyLabel} note={proxyNote} onClick={() => onPick(spots.proxy.tab)} />
                {node("backend", "row")}
                <ul className="ml-[1.625rem]">
                    {(["disk", ...BRANCHES] as HealthSpot[]).map((spot, i, all) => {
                        const last = i === all.length - 1;
                        return (
                            <li key={spot} className="relative pt-2 pl-6">
                                <span className={cn("absolute top-0 left-0 border-l-2 border-border", last ? "h-8" : "bottom-0")} aria-hidden />
                                <span className={cn("absolute top-8 left-0 w-6 border-t-2", LINE[spots[spot].state])} aria-hidden />
                                {node(spot, "row")}
                                {spot === "gateway" && (
                                    <>
                                        <VLink state={spots.gateway.state} label={t("health.flow.tunnelLink")} />
                                        {node("devices", "row")}
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}
