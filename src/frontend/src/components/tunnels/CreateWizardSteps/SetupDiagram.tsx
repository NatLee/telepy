/**
 * 建立通道頁上方的「網路場景」：裝置在私有網路（家裡 / 公司 LAN）裡，前面一道路由器 / 防火牆。
 * 從外面直接連進去會被擋（沒有公開 IP、擋連入），但裝置可以「往外」連；所以它主動連到 Telepy、把線留著，
 * 你再經 Telepy 沿這條線反向進去。全部是直線與直角：Telepy、牆上的缺口、裝置排在同一列，通道是一條直線；
 * 「你」在下面一列，被擋的直接連線也是直線撞上牆。兩種模式：
 * - 故事（Step 1、或按「怎麼運作」）：① 直接連被擋 → ② 裝置往外撥 → ③ 你經通道進來，自動輪播。
 * - 即時：跟著目前步驟與真實連線狀態（未建立 / 撥號中 / 上線），Step 3 有 Telepy 的鑰匙送進裝置。
 * 不能擠到表單：手機預設、或一聚焦表單欄位就收成一行（SceneStrip），可再展開。
 *
 * The create page's network scene: the device sits in a private network (home / office LAN) behind a router /
 * firewall. Connecting in from outside is blocked (no public IP, inbound dropped), but the device may connect *out*,
 * so it dials Telepy, keeps that line open, and you come back in along it. Straight lines and right angles only:
 * Telepy, the gap in the wall and the device share one row, so the tunnel is a single straight line; "you" sit on a
 * lower row and the blocked direct connection runs straight into the wall. Two modes:
 * - story (step 1, or "How it works"): ① direct connection blocked → ② the device dials out → ③ you come in through
 *   the tunnel, auto-playing;
 * - live: follows the current step and the real connection (not open / dialing / online); step 3 sends Telepy's key in.
 * It must not crowd the form: on phones, and as soon as a form field gets focus, it folds into one row (SceneStrip).
 */
"use client";

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
    ArrowUpRight,
    ChevronUp,
    Globe,
    House,
    KeyRound,
    Laptop,
    Maximize2,
    Pause,
    Play,
    PlayCircle,
    Server,
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
    lan: { x: number; y: number; w: number; h: number };
    wall: { x: number; y: number; w: number; h: number };
    gate: Pt;
    block: Pt;
    direct: string;
    tunnel: string;
    access: string;
    /** 標籤在節點上方（直式時，線從節點下方出去）。/ Labels above the node (portrait, where lines leave below). */
    labelAbove: { you: boolean; telepy: boolean };
    at: Record<"internet" | "lan" | "tunnel" | "access" | "gate" | "block" | "firewall", { p: Pt; a: Anchor }>;
}

// 橫向：Telepy ─ 牆的缺口 ─ 裝置 一列；「你」在下一列，往上一個直角接到 Telepy，往右直直撞牆。
// Landscape: Telepy ─ gap ─ device on one row; "you" on the row below, one right angle up to Telepy, straight into the wall.
const WIDE: Layout = {
    w: 800,
    h: 272,
    tall: false,
    you: { x: 96, y: 198 },
    telepy: { x: 340, y: 82 },
    device: { x: 686, y: 82 },
    lan: { x: 566, y: 12, w: 222, h: 248 },
    wall: { x: 554, y: 20, w: 12, h: 232 },
    gate: { x: 560, y: 82 },
    block: { x: 560, y: 198 },
    direct: "M 96 198 L 560 198",
    tunnel: "M 686 82 L 340 82",
    access: "M 96 198 L 96 82 L 340 82",
    labelAbove: { you: false, telepy: false },
    at: {
        internet: { p: { x: 24, y: 24 }, a: "left" },
        lan: { p: { x: 582, y: 30 }, a: "left" },
        tunnel: { p: { x: 452, y: 82 }, a: "center" },
        access: { p: { x: 218, y: 82 }, a: "center" },
        gate: { p: { x: 548, y: 56 }, a: "right" },
        block: { p: { x: 546, y: 198 }, a: "right" },
        firewall: { p: { x: 546, y: 140 }, a: "right" },
    },
};

// 直式：Telepy 與裝置上下一直線穿過橫牆；「你」在左上，往右接 Telepy，往下直直撞牆。
// Portrait: Telepy and the device in one vertical line through the horizontal wall; "you" top-left, right to Telepy, straight down into the wall.
const TALL: Layout = {
    w: 360,
    h: 560,
    tall: true,
    you: { x: 80, y: 130 },
    telepy: { x: 264, y: 130 },
    device: { x: 264, y: 440 },
    lan: { x: 10, y: 334, w: 340, h: 216 },
    wall: { x: 16, y: 322, w: 328, h: 12 },
    gate: { x: 264, y: 328 },
    block: { x: 80, y: 328 },
    direct: "M 80 130 L 80 328",
    tunnel: "M 264 440 L 264 130",
    access: "M 80 130 L 264 130",
    labelAbove: { you: true, telepy: true },
    at: {
        internet: { p: { x: 16, y: 20 }, a: "left" },
        lan: { p: { x: 24, y: 360 }, a: "left" },
        tunnel: { p: { x: 264, y: 232 }, a: "center" },
        access: { p: { x: 172, y: 130 }, a: "center" },
        gate: { p: { x: 264, y: 300 }, a: "center" },
        block: { p: { x: 80, y: 300 }, a: "center" },
        firewall: { p: { x: 172, y: 328 }, a: "center" },
    },
};

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
    active: { you: boolean; telepy: boolean; device: boolean };
}

const STORY: View[] = [
    { tunnel: "off", access: "off", gate: "idle", blockedActive: true, token: null, active: { you: true, telepy: false, device: true } },
    { tunnel: "pending", access: "off", gate: "open", blockedActive: false, token: "out", active: { you: false, telepy: true, device: true } },
    { tunnel: "live", access: "live", gate: "open", blockedActive: false, token: null, active: { you: true, telepy: true, device: true } },
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
        token: step === 3 ? "in" : null,
        active: { you: step === 5, telepy: step !== 2, device: true },
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
                        l.tall ? "w-32" : roomy ? "w-52" : "w-40",
                        above ? "bottom-full mb-2" : "top-full mt-2"
                    )}
                >
                    <span className="max-w-full truncate text-sm text-foreground" title={title}>{title}</span>
                    {!l.tall && <span className="hidden text-xs leading-snug text-muted-foreground @min-[760px]:block">{detail}</span>}
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
                <span className={cn("whitespace-nowrap text-xs text-muted-foreground", !l.tall && "hidden @min-[760px]:block")}>{t("wizard.scene.lanDetail")}</span>
            </span>

            {/* 牆上的標示 / Signs on the wall */}
            <Tag l={l} at={l.at.firewall} className={l.tall ? undefined : "hidden @min-[760px]:inline-flex"}>
                <ShieldHalf aria-hidden /> {t("wizard.scene.firewall")}
            </Tag>
            <Marker l={l} p={l.block} className="bg-destructive text-white">
                <X size={12} strokeWidth={3} aria-hidden />
            </Marker>
            <Tag l={l} at={l.at.block} className="border-destructive/30 text-destructive">
                <X strokeWidth={3} aria-hidden /> {t("wizard.scene.blocked")}
            </Tag>
            <Marker
                l={l}
                p={l.gate}
                className={view.gate === "open" ? "bg-success text-white" : view.gate === "pending" ? "bg-warning text-warning-foreground" : "bg-card text-muted-foreground ring-border"}
            >
                <ArrowUpRight size={12} strokeWidth={2.5} className={cn(l.tall && "-rotate-45")} aria-hidden />
            </Marker>
            <Tag l={l} at={l.at.gate} className={cn(view.gate !== "idle" && "border-success/35 text-success", !l.tall && "hidden @min-[760px]:inline-flex")}>
                <ArrowUpRight strokeWidth={2.5} aria-hidden /> {t("wizard.scene.outbound")}
            </Tag>

            {/* 線上的標籤：點 + 文字 / Labels on the lines: dot + text */}
            <Tag l={l} at={l.at.tunnel} className={cn(view.tunnel === "live" && "border-success/35", view.tunnel === "pending" && "border-warning/50")}>
                <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} aria-hidden />
                <span className={status.tone}>{status.text}</span>
            </Tag>
            {view.access === "live" && (
                <Tag l={l} at={l.at.access} className="border-info/35 text-info">
                    {t("wizard.scene.access")}
                </Tag>
            )}

            {/* 節點 / Nodes */}
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

// ── 精簡條 / Compact strip ───────────────────────────────────────────────
// 一行：圖示 + 名稱、中間的線、線上一小段防火牆、右邊是「點 + 文字」的狀態。
// One row: icon + name, the lines between them, a short firewall bar on the tunnel, and a dot + text status.

function StripNode({ icon: Icon, glyph, label, online, hideLabelBelow }: { icon?: LucideIcon; glyph?: boolean; label: string; online?: boolean | null; hideLabelBelow?: boolean }) {
    return (
        <span className="flex min-w-0 shrink-0 items-center gap-2">
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
                {/* 很窄時省掉「你」：一眼要看的是通道、牆和裝置。/ Very narrow: drop "You"; the tunnel, wall and device matter at a glance. */}
                <span className="hidden min-w-0 flex-1 items-center @min-[440px]:flex">
                    <StripNode icon={Laptop} label={t("wizard.scene.you")} hideLabelBelow />
                    <StripLine state={view.access === "live" ? "live" : "off"} inbound />
                </span>
                <StripNode glyph label="Telepy" hideLabelBelow />
                <StripLine state={view.tunnel} wall={`${t("wizard.scene.firewall")} · ${t("wizard.scene.outbound")}`} className="flex-[2]" />
                <StripNode icon={Server} label={name} online={created ? connected : null} />
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
    return window.matchMedia("(max-width: 639px)").matches ? "compact" : "full";
}
function storeScene(m: SceneMode) {
    try {
        localStorage.setItem(SCENE_KEY, m);
    } catch {
        /* 只記在這頁 / page-only */
    }
}

export interface SetupDiagramProps {
    step: WizardStep;
    deviceName: string;
    sshPort: string;
    reversePort: number | null;
    accounts: string[];
    connected: boolean;
    rttMs: number | null;
    allLoginsOk: boolean;
}

export function SetupDiagram({ step, deviceName, sshPort, reversePort, accounts, connected, rttMs, allLoginsOk }: SetupDiagramProps) {
    const { t } = useI18n();
    const reduced = useReducedMotion();
    const created = reversePort !== null;
    const name = deviceName || t("wizard.scene.yourDevice");
    const sentenceName = deviceName || t("wizard.scene.theDevice");

    // 故事模式：Step 1（還沒連上）預設播放；其他步驟可以按「怎麼運作」打開，換步驟就自動收起。
    // Story mode: plays by default on step 1 (until connected); elsewhere "How it works" opens it until the step changes.
    const storyDefault = step === 1 && !connected;
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
            // Step 1 沒連上時播故事，這裡只剩「已連上」。/ Step 1 plays the story until connected, so only "online" lands here.
            caption = t("wizard.scene.caption4Online", { name: sentenceName });
            captionDot = "bg-success";
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
                    <Button type="button" variant="ghost" size="sm" onClick={() => expand(step === 1 && !connected)} aria-label={t("wizard.scene.showDiagram")} className="shrink-0">
                        <Maximize2 /> <span className="hidden @min-[400px]:inline">{t("wizard.scene.showDiagram")}</span>
                    </Button>
                </div>
            ) : (
                <>
                    <div className="relative hidden @min-[600px]:block">
                        <Scene l={WIDE} {...sceneProps} />
                    </div>
                    <div className="relative mx-auto max-w-[400px] @min-[600px]:hidden">
                        <Scene l={TALL} {...sceneProps} />
                    </div>

                    <div className="mt-4 border-t border-border pt-3">
                        {story ? (
                            <div className="space-y-2.5">
                                <div className="flex flex-wrap items-center gap-2">
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
                                                label: (
                                                    <>
                                                        {i + 1}
                                                        <span className="hidden @min-[520px]:inline"> · {t(s.title)}</span>
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
                                <p className="flex min-w-0 flex-1 items-baseline gap-2 text-sm leading-relaxed text-foreground/85" aria-live="polite">
                                    <span className={cn("relative top-[-1px] size-2 shrink-0 rounded-full", captionDot)} aria-hidden />
                                    <span>{caption}</span>
                                </p>
                                <span className="flex shrink-0 items-center gap-1">
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
