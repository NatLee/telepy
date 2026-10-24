/**
 * 建立通道頁上方的「網路場景」：裝置在私有網路（家裡 / 公司 LAN）裡，前面一道路由器 / 防火牆。
 * 從外面直接連進去會被擋（沒有公開 IP、擋連入），但裝置可以「往外」連；所以它主動連到 Telepy、把線留著，
 * 你再經 Telepy 沿這條線反向進去。全部是直線與直角：Telepy、牆上的缺口、裝置排在同一列，通道是一條直線；
 * 「你」在下面一列，被擋的直接連線也是直線撞上牆。兩種模式：
 * - 原理（一行指令等待中、或按「原理是什麼？」）：直接連被擋 → 裝置往外撥 → 你經通道進來，自動輪播。
 *   分頁不編號：逐步設定上方就是編號的步驟 1–5，這三段是原理、不是步驟。
 * - 即時：跟著目前步驟與真實連線狀態（未建立 / 撥號中 / 上線）。逐步設定一律是即時圖，說明列標出
 *   「步驟 N · 名稱」，和上方的步驟列同名；Step 1 裝置的金鑰送到 Telepy，Step 3 Telepy 的鑰匙送進裝置。
 * 不能擠到表單：手機預設、或一聚焦表單欄位就收成一行（SceneStrip），可再展開。
 *
 * The create page's network scene: the device sits in a private network (home / office LAN) behind a router /
 * firewall. Connecting in from outside is blocked (no public IP, inbound dropped), but the device may connect *out*,
 * so it dials Telepy, keeps that line open, and you come back in along it. Straight lines and right angles only:
 * Telepy, the gap in the wall and the device share one row, so the tunnel is a single straight line; "you" sit on a
 * lower row and the blocked direct connection runs straight into the wall. Two modes:
 * - how it works (the one-command page while waiting, or "How it works"): direct connection blocked → the device dials
 *   out → you come in through the tunnel, auto-playing. Its tabs are not numbered: the step-by-step wizard right above
 *   is numbered 1–5, and these three parts explain the idea, they are not steps;
 * - live: follows the current step and the real connection (not open / dialing / online). The step-by-step wizard
 *   always shows the live scene, captioned "Step N · name" exactly like the stepper; step 1 sends the device's key to
 *   Telepy, step 3 sends Telepy's key in.
 * It must not crowd the form: on phones, and as soon as a form field gets focus, it folds into one row (SceneStrip).
 */
"use client";

import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    ArrowUpRight,
    ChevronUp,
    Globe,
    House,
    KeyRound,
    Laptop,
    Lightbulb,
    Maximize2,
    MonitorSmartphone,
    Pause,
    Play,
    PlayCircle,
    Server,
    ShieldCheck,
    ShieldHalf,
    User,
    X,
    type LucideIcon,
} from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { WIZARD_STEPS } from "./WizardStepper";
import type { TranslationKey } from "@/locales/en";
import type { WizardStep } from "@/hooks/useCreateTunnelWizard";

type Pt = { x: number; y: number };
type Anchor = "center" | "left" | "right";

interface Layout {
    w: number;
    h: number;
    tall: boolean;
    you: Pt;
    telepy: Pt;
    device: Pt;
    /** 網路上的其他裝置：直接連進來會被擋。/ Other devices on the internet: their direct connection is blocked. */
    others: Pt;
    lan: { x: number; y: number; w: number; h: number };
    wall: { x: number; y: number; w: number; h: number };
    gate: Pt;
    block: Pt;
    direct: string;
    tunnel: string;
    access: string;
    /** 標籤在節點上方（直式時，線從節點下方出去）。/ Labels above the node (portrait, where lines leave below). */
    labelAbove: { you: boolean; telepy: boolean; others: boolean };
    at: Record<"internet" | "lan" | "tunnel" | "access" | "gate" | "block" | "firewall", { p: Pt; a: Anchor }>;
}

// 橫向：你 ─ Telepy ─ 牆的缺口 ─ 裝置 一條直線；下一列是網路上的其他裝置，直直撞上牆（內網隔離）。
// 牆身不貼任何字：「路由器 · 防火牆」是牆頂上的牌子，其他標籤都離牆和牆上的標記一段距離，說明文字也有自己的位置。
// Landscape: you ─ Telepy ─ gap ─ device on one straight line; the row below holds other devices on the internet,
// running straight into the wall (the private network's isolation). Nothing sits against the wall: "Router · firewall"
// is a sign on top of it, every other tag keeps clear of the wall and its markers, and the descriptions have room.
const WIDE: Layout = {
    w: 800,
    h: 340,
    tall: false,
    you: { x: 80, y: 132 },
    telepy: { x: 300, y: 132 },
    device: { x: 690, y: 132 },
    others: { x: 80, y: 262 },
    lan: { x: 566, y: 40, w: 224, h: 292 },
    wall: { x: 554, y: 48, w: 12, h: 276 },
    gate: { x: 560, y: 132 },
    block: { x: 560, y: 262 },
    direct: "M 80 262 L 560 262",
    tunnel: "M 690 132 L 300 132",
    access: "M 80 132 L 300 132",
    labelAbove: { you: false, telepy: false, others: false },
    at: {
        internet: { p: { x: 24, y: 22 }, a: "left" },
        lan: { p: { x: 582, y: 72 }, a: "left" },
        tunnel: { p: { x: 436, y: 132 }, a: "center" },
        access: { p: { x: 190, y: 132 }, a: "center" },
        gate: { p: { x: 540, y: 172 }, a: "right" },
        block: { p: { x: 532, y: 262 }, a: "right" },
        firewall: { p: { x: 560, y: 22 }, a: "center" },
    },
};

// 直式：你 ─ Telepy 在上面一列，Telepy 與裝置上下一直線穿過橫牆；左邊的其他裝置往下直直撞牆。
// 牆上兩個標記之間放不下最長的牆名（日文），所以牆名貼在牆下、私有網路的左上角。
// Portrait: you ─ Telepy on the top row, Telepy and the device in one vertical line through the horizontal wall;
// other devices on the left run straight down into the wall. The longest wall label (Japanese) doesn't fit between
// the two markers, so it hangs just under the wall, top-left of the private network.
const TALL: Layout = {
    w: 320,
    h: 616,
    tall: true,
    you: { x: 64, y: 112 },
    telepy: { x: 232, y: 112 },
    device: { x: 232, y: 462 },
    others: { x: 64, y: 226 },
    lan: { x: 8, y: 324, w: 304, h: 282 },
    wall: { x: 12, y: 312, w: 296, h: 12 },
    gate: { x: 232, y: 318 },
    block: { x: 64, y: 318 },
    direct: "M 64 226 L 64 318",
    tunnel: "M 232 462 L 232 112",
    access: "M 64 112 L 232 112",
    labelAbove: { you: true, telepy: true, others: true },
    at: {
        internet: { p: { x: 12, y: 22 }, a: "left" },
        lan: { p: { x: 20, y: 398 }, a: "left" },
        tunnel: { p: { x: 232, y: 200 }, a: "center" },
        access: { p: { x: 148, y: 112 }, a: "center" },
        gate: { p: { x: 232, y: 288 }, a: "center" },
        block: { p: { x: 64, y: 288 }, a: "center" },
        firewall: { p: { x: 16, y: 352 }, a: "left" },
    },
};

// 版面的 1 單位 = 100% 顯示大小時的 1px。直式的 320 是最長的字（日文牆名、英文通道）還放得下的最窄寬度，
// 402px 寬的手機幾乎不用縮小；橫式要 800。
// One layout unit = 1px at 100 % display size. Portrait's 320 is the narrowest that still fits the longest labels
// (the Japanese wall label, the English tunnel label), so a 402px phone barely scales it; landscape needs 800.

const ANCHOR: Record<Anchor, string> = {
    center: "-translate-x-1/2 -translate-y-1/2",
    left: "-translate-y-1/2",
    right: "-translate-x-full -translate-y-1/2",
};

const pos = (l: Layout, p: Pt): React.CSSProperties => ({ left: `${(p.x / l.w) * 100}%`, top: `${(p.y / l.h) * 100}%` });

type Wire = "off" | "pending" | "live";

interface View {
    tunnel: Wire;
    access: "off" | "live";
    gate: "idle" | "pending" | "open";
    /** 直接連線的封包撞牆動畫。/ Animate a packet hitting the wall on the direct path. */
    blockedActive: boolean;
    /** 沿通道走的鑰匙：out = 裝置 → Telepy，in = Telepy → 裝置。/ Key travelling along the tunnel. */
    token: null | "out" | "in";
    active: { you: boolean; telepy: boolean; device: boolean; others: boolean };
}

// ① 內網把裝置隔離起來：其他裝置連不進去（你也一樣）② 裝置往外撥 ③ 你經通道進來，其他裝置仍然擋在外面。
// ① The private network isolates the device: other devices can't get in (nor can you) ② the device dials out
// ③ you come in through the tunnel while other devices are still kept out.
const STORY: View[] = [
    { tunnel: "off", access: "off", gate: "idle", blockedActive: true, token: null, active: { you: false, telepy: false, device: true, others: true } },
    { tunnel: "pending", access: "off", gate: "open", blockedActive: false, token: "out", active: { you: false, telepy: true, device: true, others: false } },
    { tunnel: "live", access: "live", gate: "open", blockedActive: true, token: null, active: { you: true, telepy: true, device: true, others: false } },
];

const STORY_TEXT: { title: TranslationKey; body: TranslationKey }[] = [
    { title: "wizard.scene.story1Title", body: "wizard.scene.story1" },
    { title: "wizard.scene.story2Title", body: "wizard.scene.story2" },
    { title: "wizard.scene.story3Title", body: "wizard.scene.story3" },
];

const STORY_MS = 5200;

function liveView(step: WizardStep, created: boolean, connected: boolean): View {
    const tunnel: Wire = connected ? "live" : created && step >= 4 ? "pending" : "off";
    return {
        tunnel,
        access: step === 5 && connected ? "live" : "off",
        gate: connected ? "open" : tunnel === "pending" ? "pending" : "idle",
        blockedActive: false,
        // Step 1 把裝置的公鑰交給 Telepy；Step 3 把 Telepy 的金鑰放進裝置。
        // Step 1 hands the device's public key to Telepy; step 3 puts Telepy's key on the device.
        token: step === 3 ? "in" : step === 1 && !connected ? "out" : null,
        active: { you: step === 5, telepy: step !== 2, device: true, others: false },
    };
}

/** 通道狀態的文字與點的顏色（線上標籤、精簡條共用）。/ Tunnel state text + dot colour (line label and strip). */
function useTunnelStatus(tunnel: Wire, rttMs: number | null) {
    const { t } = useI18n();
    if (tunnel === "live") return { dot: "bg-success", text: rttMs !== null ? t("wizard.scene.tunnelLiveRtt", { ms: Math.round(rttMs) }) : t("wizard.scene.tunnelLive"), tone: "text-success" };
    if (tunnel === "pending") return { dot: "bg-warning", text: t("wizard.scene.tunnelPending"), tone: "text-foreground" };
    return { dot: "bg-muted-foreground/40", text: t("wizard.scene.tunnelOff"), tone: "text-muted-foreground" };
}

// ── HTML 疊層 / HTML overlay ─────────────────────────────────────────────

/** 線上 / 牆上的小標籤：細框、白底、小圓角。/ Small label on a line or the wall: hairline, card, small radius. */
function Tag({ l, at, className, children }: { l: Layout; at: { p: Pt; a: Anchor }; className?: string; children: React.ReactNode }) {
    return (
        <span
            className={cn(
                "absolute z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-border bg-card px-1.5 py-px text-xs text-muted-foreground transition-colors duration-500 [&>svg]:size-3",
                ANCHOR[at.a],
                className
            )}
            style={pos(l, at.p)}
        >
            {children}
        </span>
    );
}

/**
 * 只在「 · 」換行：每一段是 inline-block，放不下才換到下一行（日文、中文不會斷在字中間，留下一個字）。
 * lead（例如狀態點）放進第一段，換行後也貼著字。
 * Breaks only at " · ": each part is an inline-block that moves to the next line when it doesn't fit, so Japanese and
 * Chinese never break mid-phrase and leave one character behind. `lead` (e.g. the status dot) rides in the first part.
 */
function AtDots({ text, lead }: { text: string; lead?: React.ReactNode }) {
    return (
        <>
            {text.split(" · ").map((part, i, parts) => (
                <React.Fragment key={i}>
                    {i > 0 && " "}
                    <span className="inline-block">
                        {i === 0 && lead}
                        {i < parts.length - 1 ? `${part} ·` : part}
                    </span>
                </React.Fragment>
            ))}
        </>
    );
}

function Marker({ l, p, className, children }: { l: Layout; p: Pt; className: string; children: React.ReactNode }) {
    return (
        <span className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={pos(l, p)}>
            <span className={cn("grid size-5 place-items-center rounded-full ring-2 ring-card transition-colors duration-500", className)}>{children}</span>
        </span>
    );
}

function SceneNode({ l, at, icon: Icon, glyph, title, detail, active, online, above, roomy, children }: {
    l: Layout;
    at: Pt;
    icon?: LucideIcon;
    glyph?: boolean;
    title: string;
    detail: string;
    active: boolean;
    online?: boolean | null;
    above?: boolean;
    /** 標籤可以寬一點（Telepy 與裝置旁邊有空間）。/ A wider label (Telepy and the device have room). */
    roomy?: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div className="absolute z-20" style={pos(l, at)}>
            <div className={cn("relative -translate-x-1/2 -translate-y-1/2 transition-opacity duration-500", !active && "opacity-50")}>
                <span
                    className={cn(
                        "relative grid place-items-center rounded-xl",
                        l.tall ? "size-11" : "size-12",
                        glyph ? "bg-brand-gradient text-white" : "border border-border bg-card text-foreground/80 shadow-card"
                    )}
                >
                    {glyph ? <TelepyGlyph size={l.tall ? 20 : 22} /> : Icon && <Icon size={l.tall ? 20 : 22} strokeWidth={1.75} />}
                    {online != null && (
                        <span className={cn("absolute -right-1 -top-1 size-3 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />
                    )}
                </span>
                <div
                    className={cn(
                        "absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-0.5 text-center",
                        l.tall ? (roomy ? "w-36" : "w-28") : roomy ? "w-48" : "w-40",
                        above ? "bottom-full mb-2" : "top-full mt-2"
                    )}
                >
                    <span className="max-w-full truncate text-sm text-foreground" title={title}>{title}</span>
                    {!l.tall && <span className="text-xs leading-snug text-muted-foreground"><AtDots text={detail} /></span>}
                    {children && <span className="mt-1 flex max-w-full flex-wrap justify-center gap-1">{children}</span>}
                </div>
            </div>
        </div>
    );
}

// ── SVG / SVG ────────────────────────────────────────────────────────────

/** 沿路徑移動的封包。reverse = 從路徑終點走回起點。/ A packet moving along a path; reverse = end → start. */
function Packet({ path, dur, begin, reverse, className, r = 3.5 }: { path: string; dur: number; begin: number; reverse?: boolean; className: string; r?: number }) {
    return (
        <circle r={r} className={cn("stroke-card", className)} strokeWidth={1.5} opacity={0}>
            <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
            <animate attributeName="opacity" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.1;0.88;1" />
        </circle>
    );
}

function KeyToken({ path, reverse }: { path: string; reverse: boolean }) {
    return (
        <g opacity={0}>
            <animateMotion dur="3s" repeatCount="indefinite" path={path} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
            <animate attributeName="opacity" dur="3s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.1;0.85;1" />
            <rect x={-11} y={-11} width={22} height={22} rx={6} className="fill-warning stroke-card" strokeWidth={2} />
            <KeyRound x={-6.5} y={-6.5} width={13} height={13} className="text-warning-foreground" strokeWidth={2.5} />
        </g>
    );
}

function SceneSvg({ l, view, reduced }: { l: Layout; view: View; reduced: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const hatch = `hatch-${uid}`;
    const vertical = l.wall.h > l.wall.w;
    const gateCut = vertical
        ? { x: l.wall.x - 1, y: l.gate.y - 11, width: l.wall.w + 2, height: 22 }
        : { x: l.gate.x - 11, y: l.wall.y - 1, width: 22, height: l.wall.h + 2 };
    const animate = !reduced;
    const line = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

    return (
        <svg viewBox={`0 0 ${l.w} ${l.h}`} className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <defs>
                {/* 牆的斜線紋：灰色，不搶色。/ Diagonal hatch for the wall, grey so it doesn't compete. */}
                <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="6" height="6" className="fill-muted" />
                    <line x1="0" y1="0" x2="0" y2="6" className="stroke-muted-foreground/35" strokeWidth={2.5} />
                </pattern>
            </defs>

            {/* 私有網路區 / private network zone */}
            <rect x={l.lan.x} y={l.lan.y} width={l.lan.w} height={l.lan.h} rx={10} className="fill-muted/40 stroke-foreground/20" strokeWidth={1} strokeDasharray="5 5" />

            {/* 直接連線：一路撞到牆 / Direct connection: runs straight into the wall */}
            <path d={l.direct} {...line} className="stroke-destructive" strokeWidth={2} strokeDasharray="6 6" opacity={view.blockedActive ? 0.9 : 0.35} style={{ transition: "opacity 0.5s" }} />
            {view.blockedActive && animate && (
                <>
                    <circle r={4} className="fill-destructive stroke-card" strokeWidth={1.5} opacity={0}>
                        <animateMotion dur="1.8s" repeatCount="indefinite" path={l.direct} keyPoints="0;1;1" keyTimes="0;0.8;1" calcMode="linear" />
                        <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.1;0.8;0.86;1" />
                    </circle>
                    <circle cx={l.block.x} cy={l.block.y} r={0} fill="none" className="stroke-destructive" strokeWidth={2}>
                        <animate attributeName="r" dur="1.8s" repeatCount="indefinite" values="0;0;18" keyTimes="0;0.8;1" />
                        <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0;0.8;0" keyTimes="0;0.8;1" />
                    </circle>
                </>
            )}

            {/* 你 → Telepy / You → Telepy */}
            {view.access === "live" ? (
                <>
                    <path d={l.access} {...line} className="stroke-info" strokeWidth={2.5} />
                    {animate && [0, 0.8, 1.6].map((b) => <Packet key={b} path={l.access} dur={2.4} begin={b} className="fill-info" />)}
                </>
            ) : (
                <path d={l.access} {...line} className="stroke-muted-foreground/40" strokeWidth={2} strokeDasharray="1 6" />
            )}

            {/* 牆（路由器 / 防火牆）與通道穿過的缺口 / The wall (router / firewall) and the gap the tunnel passes through */}
            <rect x={l.wall.x} y={l.wall.y} width={l.wall.w} height={l.wall.h} rx={3} fill={`url(#${hatch})`} className="stroke-border" strokeWidth={1} />
            <rect {...gateCut} rx={3} className={cn("fill-card", view.gate === "open" ? "stroke-success" : view.gate === "pending" ? "stroke-warning" : "stroke-border")} strokeWidth={1.5} style={{ transition: "stroke 0.5s" }} />

            {/* 通道：裝置往外撥出的一條直線 / The tunnel: one straight line dialed out by the device */}
            {view.tunnel === "off" && <path d={l.tunnel} {...line} className="stroke-muted-foreground/40" strokeWidth={2} strokeDasharray="1 6" />}
            {view.tunnel === "pending" && (
                <>
                    <path d={l.tunnel} {...line} className="stroke-warning" strokeWidth={2.5} strokeDasharray="8 7">
                        {animate && <animate attributeName="stroke-dashoffset" values="30;0" dur="0.9s" repeatCount="indefinite" />}
                    </path>
                    {animate && [0, 1.1].map((b) => <Packet key={b} path={l.tunnel} dur={2.2} begin={b} className="fill-warning" />)}
                </>
            )}
            {view.tunnel === "live" && (
                <>
                    <path d={l.tunnel} {...line} className="stroke-success" strokeWidth={3} />
                    {animate && [0, 0.8, 1.6].map((b) => <Packet key={b} path={l.tunnel} dur={2.4} begin={b} reverse className="fill-success" />)}
                </>
            )}
            {view.token && animate && <KeyToken path={l.tunnel} reverse={view.token === "in"} />}
        </svg>
    );
}

// ── 完整場景 / The full scene ────────────────────────────────────────────

function Scene({ l, view, reduced, name, sshPort, reversePort, accounts, connected, created, step, rttMs, allLoginsOk }: {
    l: Layout;
    view: View;
    reduced: boolean;
    name: string;
    sshPort: string;
    reversePort: number | null;
    accounts: string[];
    connected: boolean;
    created: boolean;
    step: WizardStep;
    rttMs: number | null;
    allLoginsOk: boolean;
}) {
    const { t } = useI18n();
    const shown = accounts.slice(0, 2);
    const more = accounts.length - shown.length;
    const status = useTunnelStatus(view.tunnel, connected ? rttMs : null);

    return (
        <div className="relative w-full" style={{ aspectRatio: `${l.w} / ${l.h}` }}>
            <SceneSvg l={l} view={view} reduced={reduced} />

            {/* 區域標籤 / Zone labels */}
            <span className={cn("absolute inline-flex items-center gap-1.5 text-xs text-muted-foreground", ANCHOR[l.at.internet.a])} style={pos(l, l.at.internet.p)}>
                <Globe size={13} aria-hidden /> {t("wizard.scene.internet")}
            </span>
            <span className={cn("absolute flex flex-col items-start gap-0.5", ANCHOR[l.at.lan.a])} style={pos(l, l.at.lan.p)}>
                <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80">
                    <House size={13} aria-hidden /> {t("wizard.scene.lan")}
                </span>
                {/* 折行：直式別碰到通道，橫式留在私有網路框裡。/ Wraps: clear of the tunnel in portrait, inside the zone in landscape. */}
                <span className={cn("text-xs text-muted-foreground", l.tall ? "max-w-[12rem]" : "max-w-[12.5rem]")}><AtDots text={t("wizard.scene.lanDetail")} /></span>
            </span>

            {/* 牆上的標示 / Signs on the wall */}
            <Tag l={l} at={l.at.firewall}>
                <ShieldHalf aria-hidden /> {t("wizard.scene.firewall")}
            </Tag>
            <Marker l={l} p={l.block} className="bg-destructive text-white">
                <X size={12} strokeWidth={3} aria-hidden />
            </Marker>
            <Tag l={l} at={l.at.block} className="border-destructive/30 text-destructive">
                <ShieldCheck aria-hidden /> {t("wizard.scene.blocked")}
            </Tag>
            <Marker
                l={l}
                p={l.gate}
                className={view.gate === "open" ? "bg-success text-white" : view.gate === "pending" ? "bg-warning text-warning-foreground" : "bg-card text-muted-foreground ring-border"}
            >
                <ArrowUpRight size={12} strokeWidth={2.5} className={cn(l.tall && "-rotate-45")} aria-hidden />
            </Marker>
            <Tag l={l} at={l.at.gate} className={cn(view.gate !== "idle" && "border-success/35 text-success")}>
                <ArrowUpRight strokeWidth={2.5} aria-hidden /> {t("wizard.scene.outbound")}
            </Tag>

            {/* 線上的標籤：點 + 文字 / Labels on the lines: dot + text */}
            <Tag
                l={l}
                at={l.at.tunnel}
                className={cn(
                    view.tunnel === "live" && "border-success/35",
                    view.tunnel === "pending" && "border-warning/50",
                    // 長句在「·」折成兩行，不會蓋到牆上的標記；w-max：靠右邊的絕對定位不會被擠成窄欄。
                    // Long text wraps at the "·" instead of running onto the wall's marker; w-max keeps an absolute box
                    // near the right edge from shrinking to the space left of it.
                    "w-max max-w-[10.5rem] whitespace-normal text-center"
                )}
            >
                <span className={status.tone}>
                    <AtDots text={status.text} lead={<span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", status.dot)} aria-hidden />} />
                </span>
            </Tag>
            {view.access === "live" && (
                <Tag l={l} at={l.at.access} className="border-info/35 text-info">
                    {t("wizard.scene.access")}
                </Tag>
            )}

            {/* 節點 / Nodes */}
            <SceneNode l={l} at={l.others} icon={MonitorSmartphone} title={t("wizard.scene.others")} detail={t("wizard.scene.othersDetail")} active={view.active.others} above={l.labelAbove.others} />
            <SceneNode l={l} at={l.you} icon={Laptop} title={t("wizard.scene.you")} detail={t("wizard.scene.youDetail")} active={view.active.you} above={l.labelAbove.you} />
            <SceneNode l={l} at={l.telepy} glyph roomy title="Telepy" detail={t("wizard.scene.telepyDetail")} active={view.active.telepy} above={l.labelAbove.telepy}>
                {reversePort !== null && <Chip mono title={t("wizard.scene.reservedPort")}>:{reversePort}</Chip>}
            </SceneNode>
            <SceneNode l={l} at={l.device} icon={Server} roomy title={name} detail={t("wizard.scene.deviceDetail")} active={view.active.device} online={created ? connected : null}>
                <Chip mono title={t("wizard.scene.sshdPort")}>sshd :{sshPort || "22"}</Chip>
                {step >= 2 && shown.map((a) => <Chip key={a} mono><User aria-hidden />{a}</Chip>)}
                {step >= 2 && more > 0 && <Chip>+{more}</Chip>}
                {step >= 4 && (
                    <Chip mono tone={allLoginsOk ? "success" : "neutral"} title={t("wizard.scene.keysPlaced")}>
                        <KeyRound aria-hidden />authorized_keys
                    </Chip>
                )}
            </SceneNode>
        </div>
    );
}

/**
 * 節點與線照比例縮放，標籤卻是 rem 字級；容器比設計寬度窄（手機、或顯示大小調大）時標籤會互相壓到。
 * 所以比設計寬度窄就照設計寬度排版、整張等比例縮小，任何寬度與顯示大小看起來都一樣。
 * Nodes and lines scale with the width but the labels are rem-sized, so a container narrower than the design width
 * (phones, or a larger display size) makes them collide. Below the design width the scene is laid out at that width
 * and scaled down as a whole, so it looks the same at any width and display size.
 */
function FitScene({ l, children }: { l: Layout; children: React.ReactNode }) {
    const outer = useRef<HTMLDivElement>(null);
    // 看不見的探針，寬度就是設計寬度（rem）：顯示大小一改它就變寬變窄，ResizeObserver 會叫我們重算。
    // An invisible probe exactly the design width (rem): it resizes whenever the display size changes, which
    // re-triggers the measurement even when the diagram itself keeps its width.
    const probe = useRef<HTMLSpanElement>(null);
    const [scale, setScale] = useState(1);
    const designRem = `${l.w / 16}rem`;

    useLayoutEffect(() => {
        const box = outer.current;
        const design = probe.current;
        if (!box || !design) return;
        const measure = () => {
            // 另一種版面時這張是藏起來的（寬度 0），不用量。/ Hidden (zero width) while the other layout shows.
            if (!box.clientWidth || !design.offsetWidth) return;
            setScale(Math.min(1, box.clientWidth / design.offsetWidth));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(box);
        ro.observe(design);
        return () => ro.disconnect();
    }, []);

    const fit = scale < 1;
    return (
        <div ref={outer} className="relative w-full" style={{ aspectRatio: `${l.w} / ${l.h}` }}>
            <span ref={probe} className="pointer-events-none invisible absolute left-0 top-0 h-0" style={{ width: designRem }} aria-hidden />
            <div className="absolute left-0 top-0 origin-top-left" style={fit ? { width: designRem, transform: `scale(${scale})` } : { width: "100%" }}>
                {children}
            </div>
        </div>
    );
}

// ── 精簡條 / Compact strip ───────────────────────────────────────────────
// 一行：圖示 + 名稱、中間的線、線上一小段防火牆、右邊是「點 + 文字」的狀態。
// One row: icon + name, the lines between them, a short firewall bar on the tunnel, and a dot + text status.

function StripNode({ icon: Icon, glyph, label, online, hideLabelBelow, shrink }: {
    icon?: LucideIcon;
    glyph?: boolean;
    label: string;
    online?: boolean | null;
    hideLabelBelow?: boolean;
    /** 擠的時候讓它讓位（名字截斷）。/ Gives way when tight (the name truncates). */
    shrink?: boolean;
}) {
    return (
        <span className={cn("flex min-w-0 items-center gap-2", shrink ? "shrink" : "shrink-0")}>
            <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-md", glyph ? "bg-brand-gradient text-white" : "border border-border bg-card text-foreground/80")}>
                {glyph ? <TelepyGlyph size={13} /> : Icon && <Icon size={15} strokeWidth={1.75} />}
                {online != null && <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />}
            </span>
            <span className={cn("max-w-[8rem] truncate text-xs text-foreground/80", hideLabelBelow && "hidden @min-[520px]:inline")} title={label}>{label}</span>
        </span>
    );
}

function StripLine({ state, inbound, wall, className }: { state: Wire; inbound?: boolean; wall?: string; className?: string }) {
    const anim = inbound ? "animate-flow-x" : "animate-flow-x-rev";
    return (
        <span className={cn("relative mx-2 h-5 min-w-6 flex-1", className)} aria-hidden={!wall}>
            <span
                className={cn(
                    "absolute inset-x-0 top-1/2 -translate-y-1/2",
                    state === "off" && "border-t-2 border-dotted border-muted-foreground/35",
                    state === "pending" && "border-t-2 border-dashed border-warning",
                    state === "live" && "h-0.5 rounded-full bg-success"
                )}
            />
            {state !== "off" && ["0s", "0.9s"].map((d) => (
                <span key={d} className={cn("absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full opacity-0 ring-2 ring-card", state === "live" ? "bg-success" : "bg-warning", anim)} style={{ animationDelay: d }} />
            ))}
            {/* 線上的一小段牆：防火牆。/ A short wall on the line: the firewall. */}
            {wall && (
                <span
                    className="absolute right-[18%] top-1/2 h-5 w-1.5 -translate-y-1/2 rounded-sm border border-border [background-image:repeating-linear-gradient(45deg,var(--muted)_0_2px,color-mix(in_oklch,var(--muted-foreground)_35%,transparent)_2px_3.5px)]"
                    title={wall}
                    role="img"
                    aria-label={wall}
                />
            )}
        </span>
    );
}

function SceneStrip({ view, name, connected, created, rttMs }: { view: View; name: string; connected: boolean; created: boolean; rttMs: number | null }) {
    const { t } = useI18n();
    const status = useTunnelStatus(view.tunnel, rttMs);
    return (
        <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center">
                {/* 很窄時省掉「你」：一眼要看的是通道、牆和裝置。不設 min-w-0：這一段不能被擠得比內容窄，否則「你」會疊到 Telepy 上。
                    Very narrow: drop "You"; the tunnel, wall and device matter at a glance. No min-w-0: this part must
                    never get narrower than its content, or "You" runs into Telepy. */}
                <span className="hidden flex-1 items-center @min-[440px]:flex">
                    <StripNode icon={Laptop} label={t("wizard.scene.you")} hideLabelBelow />
                    <StripLine state={view.access === "live" ? "live" : "off"} inbound />
                </span>
                <StripNode glyph label="Telepy" hideLabelBelow />
                <StripLine state={view.tunnel} wall={`${t("wizard.scene.firewall")} · ${t("wizard.scene.outbound")}`} className="flex-[2]" />
                <StripNode icon={Server} label={name} online={created ? connected : null} shrink />
            </div>
            <span className={cn("hidden shrink-0 items-center gap-1.5 text-xs @min-[600px]:inline-flex", status.tone)}>
                <span className={cn("size-1.5 rounded-full", status.dot)} aria-hidden /> {status.text}
            </span>
        </div>
    );
}

// ── 偏好 / Preference ────────────────────────────────────────────────────
// 完整插圖或一行精簡條；記在 localStorage。沒選過：手機精簡、桌面第一次看完整的。
// Full illustration or the one-row strip, remembered in localStorage. No choice yet: compact on phones, full on desktop.
type SceneMode = "full" | "compact";
const SCENE_KEY = "telepy.createScene";

function subscribeScene(onChange: () => void) {
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
}
function readScene(): SceneMode {
    try {
        const v = localStorage.getItem(SCENE_KEY);
        if (v === "full" || v === "compact") return v;
    } catch {
        /* 沒有 localStorage 就用預設 / defaults without storage */
    }
    // 手機直拿（窄）或橫拿（矮）都先給一行。/ Phones in portrait (narrow) or landscape (short) start with the strip.
    return window.matchMedia("(max-width: 639px), (max-height: 500px)").matches ? "compact" : "full";
}
function storeScene(m: SceneMode) {
    try {
        localStorage.setItem(SCENE_KEY, m);
    } catch {
        /* 只記在這頁 / page-only */
    }
}

export interface SetupDiagramProps {
    /**
     * wizard：逐步設定，即時圖 + 「步驟 N」說明；join：一行指令，等待時播原理。
     * wizard: step-by-step, live scene captioned "Step N"; join: the one-command page, which plays how it works while waiting.
     */
    variant?: "wizard" | "join";
    step: WizardStep;
    deviceName: string;
    sshPort: string;
    reversePort: number | null;
    accounts: string[];
    connected: boolean;
    rttMs: number | null;
    allLoginsOk: boolean;
}

export function SetupDiagram({ variant = "wizard", step, deviceName, sshPort, reversePort, accounts, connected, rttMs, allLoginsOk }: SetupDiagramProps) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const created = reversePort !== null;
    const name = deviceName || t("wizard.scene.yourDevice");
    const sentenceName = deviceName || t("wizard.scene.theDevice");

    // 原理：只有一行指令在等裝置時預設播放；逐步設定要按「原理是什麼？」才打開，換步驟就自動收起，
    // 免得編號的步驟上面又自己播另一套。
    // How it works: plays by default only on the one-command page while it waits for the device; the step-by-step
    // wizard opens it from "How it works" until the step changes, so it never plays a sequence of its own over the
    // numbered steps.
    const storyDefault = variant === "join" && step === 1 && !connected;
    const [storyStep, setStoryStep] = useState<WizardStep | null>(null);
    const story = storyDefault || storyStep === step;
    const [phase, setPhase] = useState(0);
    const [paused, setPaused] = useState(false);

    const stored = useSyncExternalStore(subscribeScene, readScene, () => "full" as SceneMode);
    const [override, setOverride] = useState<SceneMode | null>(null);
    // 使用者自己展開的：之後打字也不自動收。/ Expanded by hand: stay open while typing.
    const [pinned, setPinned] = useState(false);
    const mode = override ?? stored;
    const figure = useRef<HTMLElement>(null);
    const playing = story && mode === "full" && !paused && !reduced;

    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setPhase((p) => (p + 1) % STORY.length), STORY_MS);
        return () => clearInterval(timer);
    }, [playing]);

    // 一開始填表就收成一行，別把輸入框擠到下面去；被聚焦的欄位維持在畫面裡。
    // Fold into one row as soon as the user starts filling in the form, and keep the focused field on screen.
    useEffect(() => {
        if (mode !== "full" || pinned) return;
        const onFocus = (e: FocusEvent) => {
            const el = e.target;
            if (!(el instanceof HTMLElement) || figure.current?.contains(el)) return;
            if (!el.matches("input, textarea, select, [contenteditable='true']")) return;
            setOverride("compact");
            storeScene("compact");
            requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
        };
        document.addEventListener("focusin", onFocus);
        return () => document.removeEventListener("focusin", onFocus);
    }, [mode, pinned]);

    const expand = (withStory: boolean) => {
        setOverride("full");
        setPinned(true);
        storeScene("full");
        if (withStory) {
            setStoryStep(step);
            setPhase(0);
            setPaused(false);
        }
    };
    const collapse = () => {
        setOverride("compact");
        setPinned(false);
        storeScene("compact");
    };

    const live = liveView(step, created, connected);
    const view = story ? STORY[phase] : live;

    // 目前狀態的一句話：點的顏色跟著狀態。/ One sentence for the current state; the dot follows the status.
    let caption: string;
    let captionDot = "bg-primary";
    switch (step) {
        case 1:
            if (connected) {
                caption = t("wizard.scene.caption4Online", { name: sentenceName });
                captionDot = "bg-success";
            } else {
                caption = t("wizard.scene.caption1");
            }
            break;
        case 2:
            caption = t("wizard.scene.caption2", { name: sentenceName });
            break;
        case 3:
            caption = t("wizard.scene.caption3", { name: sentenceName });
            break;
        case 4:
            caption = connected ? t("wizard.scene.caption4Online", { name: sentenceName }) : t("wizard.scene.caption4Waiting", { name: sentenceName });
            captionDot = connected ? "bg-success" : "bg-warning";
            break;
        default:
            if (allLoginsOk) {
                caption = t("wizard.scene.caption5Ready", { name: sentenceName });
                captionDot = "bg-success";
            } else if (connected) {
                caption = t("wizard.scene.caption5Checking", { name: sentenceName });
            } else {
                caption = t("wizard.scene.caption5Offline", { name: sentenceName });
                captionDot = "bg-warning";
            }
    }

    const collapseButton = (
        <Button type="button" variant="ghost" size="sm" onClick={collapse}>
            <ChevronUp /> {t("wizard.scene.collapse")}
        </Button>
    );

    const sceneProps = { view, reduced, name, sshPort, reversePort, accounts, connected, created, step, rttMs, allLoginsOk };

    return (
        <figure
            ref={figure}
            className={cn("@container relative rounded-xl border border-border bg-surface", mode === "full" ? "px-3 pb-3 pt-4 sm:px-5" : "px-3 py-2.5 sm:px-4")}
            aria-label={t("wizard.scene.aria")}
        >
            {mode === "compact" ? (
                <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <SceneStrip view={live} name={name} connected={connected} created={created} rttMs={rttMs} />
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => expand(storyDefault)} aria-label={t("wizard.scene.showDiagram")} className="shrink-0">
                        <Maximize2 /> <span className="hidden @min-[400px]:inline">{t("wizard.scene.showDiagram")}</span>
                    </Button>
                </div>
            ) : (
                <>
                    {/* 橫式從 700px 起：縮到剛好時字還有 11px 多；更窄就用直式。
                        Landscape from 700px, where fitting it still leaves 11px+ text; narrower gets the portrait one. */}
                    <div className="relative hidden @min-[700px]:block">
                        <FitScene l={WIDE}>
                            <Scene l={WIDE} {...sceneProps} />
                        </FitScene>
                    </div>
                    <div className="relative mx-auto max-w-[400px] @min-[700px]:hidden">
                        <FitScene l={TALL}>
                            <Scene l={TALL} {...sceneProps} />
                        </FitScene>
                    </div>

                    <div className="mt-4 border-t border-border pt-3">
                        {story ? (
                            <div className="space-y-2.5">
                                <div className="flex flex-wrap items-center gap-2">
                                    {/* 標明這是「原理」，不是設定步驟。/ Says this is how it works, not a setup step. */}
                                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Lightbulb size={14} aria-hidden /> {t("wizard.scene.howItWorksLabel")}
                                    </span>
                                    <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
                                        <Segmented
                                            kind="tabs"
                                            size="sm"
                                            value={String(phase)}
                                            onChange={(v) => {
                                                setPhase(Number(v));
                                                setPaused(true);
                                            }}
                                            aria-label={t("wizard.scene.aria")}
                                            options={STORY_TEXT.map((s, i) => ({
                                                value: String(i),
                                                title: t(s.title),
                                                // 不編號（上面的步驟列才是 1–5）：窄的時候一個點，寬了顯示標題。
                                                // No numbers (the stepper above owns 1–5): a dot when narrow, the title when wide.
                                                label: (
                                                    <>
                                                        <span className="inline-block size-1.5 rounded-full bg-current @min-[520px]:hidden" aria-hidden />
                                                        <span className="hidden @min-[520px]:inline">{t(s.title)}</span>
                                                    </>
                                                ),
                                            }))}
                                        />
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => setPaused((p) => !p)}
                                        aria-label={paused || reduced ? t("wizard.scene.play") : t("wizard.scene.pause")}
                                    >
                                        {paused || reduced ? <Play /> : <Pause />}
                                    </Button>
                                    <span className="ml-auto flex items-center gap-1">
                                        {!storyDefault && (
                                            <Button type="button" variant="link" size="sm" onClick={() => setStoryStep(null)}>
                                                {t("wizard.scene.liveView")}
                                            </Button>
                                        )}
                                        {collapseButton}
                                    </span>
                                </div>
                                <p className="text-sm leading-relaxed text-foreground/85">
                                    <span className="block text-foreground">{t(STORY_TEXT[phase].title)}</span>
                                    {t(STORY_TEXT[phase].body, { name: sentenceName })}
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                                {/* basis-60：放不下時按鈕換到下一行，句子不會被擠成一字一行。
                                    basis-60: when both don't fit the buttons wrap below instead of squeezing the sentence. */}
                                <p className="flex min-w-0 flex-1 basis-60 items-baseline gap-2 text-sm leading-relaxed text-foreground/85" aria-live="polite">
                                    <span className={cn("relative top-[-1px] size-2 shrink-0 rounded-full", captionDot)} aria-hidden />
                                    <span>
                                        {/* 逐步設定：和上方步驟列同一個名字，一看就知道圖在講哪一步。
                                            Step-by-step: the stepper's own name, so it's clear which step the scene shows. */}
                                        {variant === "wizard" && (
                                            <Chip className="mr-2 align-[1px]">
                                                {t("wizard.stepN", { n: step })} · {t(WIZARD_STEPS[step - 1].title)}
                                            </Chip>
                                        )}
                                        {caption}
                                    </span>
                                </p>
                                <span className="ml-auto flex shrink-0 items-center gap-1">
                                    <Button type="button" variant="outline" size="sm" onClick={() => expand(true)}>
                                        <PlayCircle /> {t("wizard.scene.howItWorks")}
                                    </Button>
                                    {collapseButton}
                                </span>
                            </div>
                        )}
                    </div>
                </>
            )}
        </figure>
    );
}
