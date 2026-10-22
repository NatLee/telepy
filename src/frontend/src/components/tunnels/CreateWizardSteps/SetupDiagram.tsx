/**
 * 建立通道頁上方的「網路場景」：裝置在私有網路（家裡 / 公司 LAN）裡，前面有路由器 / 防火牆。
 * 從外面直接連進去會被擋（沒有公開 IP、擋連入），但裝置可以「往外」連；所以它主動連到 Telepy、把線留著，
 * 你再經 Telepy 沿這條線反向進去。兩種模式：
 * - 故事（Step 1、或按「怎麼運作」）：① 直接連被擋 → ② 裝置往外撥 → ③ 你經通道進來，自動輪播。
 * - 即時：跟著目前步驟與真實連線狀態（未建立 / 撥號中 / 上線），Step 3 有 Telepy 的鑰匙送進裝置。
 * 寬版是橫向構圖，容器窄時（container query）換成直式；節點與文字是 HTML（不縮放），線與牆是 SVG。
 *
 * The create page's network scene: the device sits in a private network (home / office LAN) behind a router /
 * firewall. Connecting in from outside is blocked (no public IP, inbound dropped), but the device may connect *out*,
 * so it dials Telepy, keeps that line open, and you come back in along it. Two modes:
 * - story (step 1, or "How it works"): ① direct connection blocked → ② the device dials out → ③ you come in through
 *   the tunnel, auto-playing;
 * - live: follows the current step and the real connection (not open / dialing / online); step 3 sends Telepy's key in.
 * Landscape when wide, portrait in a narrow container (container query). Nodes and text are HTML (they don't scale);
 * lines and the wall are SVG.
 */
"use client";

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
    ArrowUpRight,
    CheckCircle2,
    ChevronUp,
    Globe,
    Hourglass,
    House,
    KeyRound,
    Laptop,
    Lock,
    Maximize2,
    Pause,
    Play,
    PlayCircle,
    Radio,
    Server,
    ShieldHalf,
    Sparkles,
    User,
    X,
    type LucideIcon,
} from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
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
    at: Record<"internet" | "lan" | "tunnel" | "access" | "gate" | "block" | "firewall", { p: Pt; a: Anchor }>;
}

// 橫向：網際網路在左，私有網路在右，中間一道牆。/ Landscape: internet left, private network right, a wall between.
const WIDE: Layout = {
    w: 800,
    h: 270,
    tall: false,
    you: { x: 112, y: 170 },
    telepy: { x: 342, y: 74 },
    device: { x: 678, y: 126 },
    lan: { x: 566, y: 10, w: 222, h: 252 },
    wall: { x: 550, y: 18, w: 16, h: 236 },
    gate: { x: 558, y: 86 },
    block: { x: 558, y: 214 },
    direct: "M 112 170 L 558 214",
    tunnel: "M 678 126 C 636 116, 604 86, 558 86 C 496 86, 424 74, 342 74",
    access: "M 112 170 C 150 118, 240 78, 342 74",
    at: {
        internet: { p: { x: 24, y: 22 }, a: "left" },
        lan: { p: { x: 677, y: 34 }, a: "center" },
        tunnel: { p: { x: 456, y: 81 }, a: "center" },
        access: { p: { x: 196, y: 112 }, a: "center" },
        gate: { p: { x: 576, y: 60 }, a: "left" },
        block: { p: { x: 536, y: 214 }, a: "right" },
        firewall: { p: { x: 558, y: 150 }, a: "center" },
    },
};

// 直式：網際網路在上，私有網路在下，牆是橫的。/ Portrait: internet on top, private network below, a horizontal wall.
const TALL: Layout = {
    w: 360,
    h: 540,
    tall: true,
    you: { x: 78, y: 122 },
    telepy: { x: 276, y: 122 },
    device: { x: 180, y: 380 },
    lan: { x: 10, y: 258, w: 340, h: 274 },
    wall: { x: 16, y: 250, w: 328, h: 16 },
    gate: { x: 264, y: 258 },
    block: { x: 92, y: 258 },
    direct: "M 78 122 L 92 258",
    tunnel: "M 180 380 C 192 340, 264 312, 264 258 C 264 206, 276 166, 276 122",
    access: "M 78 122 L 276 122",
    at: {
        internet: { p: { x: 16, y: 18 }, a: "left" },
        lan: { p: { x: 24, y: 288 }, a: "left" },
        tunnel: { p: { x: 270, y: 192 }, a: "center" },
        access: { p: { x: 177, y: 122 }, a: "center" },
        gate: { p: { x: 264, y: 233 }, a: "center" },
        block: { p: { x: 92, y: 233 }, a: "center" },
        firewall: { p: { x: 178, y: 258 }, a: "center" },
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

// ── HTML 疊層 / HTML overlay ─────────────────────────────────────────────

function Chip({ children, tone = "muted", icon: Icon, title }: { children: React.ReactNode; tone?: "muted" | "primary" | "ok"; icon?: LucideIcon; title?: string }) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-mono text-[0.75rem]",
                tone === "muted" && "bg-muted text-foreground/80",
                tone === "primary" && "bg-primary/10 text-primary",
                tone === "ok" && "bg-success/12 text-success"
            )}
        >
            {Icon && <Icon size={10} className="shrink-0" aria-hidden />}
            <span className="truncate">{children}</span>
        </span>
    );
}

function Pill({ l, at, className, children }: { l: Layout; at: { p: Pt; a: Anchor }; className?: string; children: React.ReactNode }) {
    return (
        <span
            className={cn(
                "absolute z-10 inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-card px-2 py-0.5 text-[0.75rem] shadow-sm transition-colors duration-500",
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
            <span className={cn("relative grid size-6 place-items-center rounded-full ring-2 ring-card shadow-sm transition-colors duration-500", className)}>{children}</span>
        </span>
    );
}

function SceneNode({ l, at, icon: Icon, glyph, tint, title, detail, active, online, above, children }: {
    l: Layout;
    at: Pt;
    icon?: LucideIcon;
    glyph?: boolean;
    tint?: string;
    title: string;
    detail: string;
    active: boolean;
    online?: boolean | null;
    above?: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div className="absolute z-20" style={pos(l, at)}>
            <div className={cn("relative -translate-x-1/2 -translate-y-1/2 transition-[opacity,filter] duration-500", !active && "opacity-55 saturate-50")}>
                <span
                    className={cn(
                        "relative grid place-items-center overflow-hidden rounded-xl shadow-card ring-1 ring-inset transition-shadow duration-500",
                        l.tall ? "size-12" : "size-14",
                        glyph ? "bg-brand-gradient text-white ring-white/25" : "bg-card",
                        active && ""
                    )}
                >
                    {tint && <span className={cn("absolute inset-0", tint)} aria-hidden />}
                    {glyph ? <TelepyGlyph size={l.tall ? 22 : 26} /> : Icon && <Icon className="relative" size={l.tall ? 22 : 26} strokeWidth={1.75} />}
                </span>
                {online != null && (
                    <span className="absolute -right-1 -top-1 flex size-3.5" aria-hidden>
                        {online && <span className="absolute inline-flex size-full rounded-full bg-success animate-status-ping" />}
                        <span className={cn("relative inline-flex size-3.5 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/40")} />
                    </span>
                )}
                <div
                    className={cn(
                        "absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-0.5 text-center",
                        l.tall ? "w-32" : "w-44",
                        above ? "bottom-full mb-2" : "top-full mt-2"
                    )}
                >
                    <span className="max-w-full truncate text-sm text-foreground" title={title}>{title}</span>
                    <span className="text-[0.75rem] leading-snug text-muted-foreground">{detail}</span>
                    {children && <span className="mt-1 flex max-w-full flex-wrap justify-center gap-1">{children}</span>}
                </div>
            </div>
        </div>
    );
}

// ── SVG 動畫 / SVG animation ─────────────────────────────────────────────

/** 沿路徑移動的封包。reverse = 從路徑終點走回起點。/ A packet moving along a path; reverse = end → start. */
function Packet({ path, dur, begin, reverse, className, r = 4 }: { path: string; dur: number; begin: number; reverse?: boolean; className: string; r?: number }) {
    return (
        <circle r={r} className={className} opacity={0}>
            <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
            <animate attributeName="opacity" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.12;0.85;1" />
        </circle>
    );
}

function KeyToken({ path, reverse }: { path: string; reverse: boolean }) {
    return (
        <g opacity={0}>
            <animateMotion dur="3s" repeatCount="indefinite" path={path} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
            <animate attributeName="opacity" dur="3s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.1;0.85;1" />
            <circle r={12} className="fill-warning" style={{ filter: "drop-shadow(0 0 6px rgb(251 191 36 / 0.8))" }} />
            <KeyRound x={-7} y={-7} width={14} height={14} className="text-warning-foreground" strokeWidth={2.5} />
        </g>
    );
}

function SceneSvg({ l, view, reduced }: { l: Layout; view: View; reduced: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const brick = `brick-${uid}`;
    const vertical = l.wall.h > l.wall.w;
    const gateCut = vertical
        ? { x: l.wall.x - 1, y: l.gate.y - 12, width: l.wall.w + 2, height: 24 }
        : { x: l.gate.x - 12, y: l.wall.y - 1, width: 24, height: l.wall.h + 2 };
    const animate = !reduced;

    return (
        <svg viewBox={`0 0 ${l.w} ${l.h}`} className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <defs>
                <pattern id={brick} width="18" height="12" patternUnits="userSpaceOnUse">
                    <rect width="18" height="12" className="fill-warning/20" />
                    <path d="M0 6H18M9 0V6M0 6V12M18 6V12" fill="none" className="stroke-card" strokeWidth="1.6" />
                </pattern>
            </defs>

            {/* 私有網路區 / private network zone */}
            <rect x={l.lan.x} y={l.lan.y} width={l.lan.w} height={l.lan.h} rx={22} className="fill-foreground/[0.03] stroke-foreground/25" strokeWidth={1.5} strokeDasharray="6 6" />

            {/* 直接連線：一路撞到牆 / Direct connection: runs straight into the wall */}
            <path d={l.direct} fill="none" className="stroke-destructive" strokeWidth={2.5} strokeDasharray="6 7" strokeLinecap="round" opacity={view.blockedActive ? 0.85 : 0.3} style={{ transition: "opacity 0.5s" }} />
            {view.blockedActive && animate && (
                <>
                    <circle r={5} className="fill-destructive" opacity={0}>
                        <animateMotion dur="1.8s" repeatCount="indefinite" path={l.direct} keyPoints="0;1;1" keyTimes="0;0.8;1" calcMode="linear" />
                        <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.1;0.8;0.86;1" />
                    </circle>
                    <circle cx={l.block.x} cy={l.block.y} r={0} fill="none" className="stroke-destructive" strokeWidth={3}>
                        <animate attributeName="r" dur="1.8s" repeatCount="indefinite" values="0;0;22" keyTimes="0;0.8;1" />
                        <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0;0.9;0" keyTimes="0;0.8;1" />
                    </circle>
                </>
            )}

            {/* 你 → Telepy / You → Telepy */}
            {view.access === "live" ? (
                <>
                    <path d={l.access} fill="none" className="stroke-info/15" strokeWidth={12} strokeLinecap="round" />
                    <path d={l.access} fill="none" className="stroke-info" strokeWidth={3.5} strokeLinecap="round" />
                    {animate && [0, 0.7, 1.4].map((b) => <Packet key={b} path={l.access} dur={2.1} begin={b} className="fill-info" />)}
                </>
            ) : (
                <path d={l.access} fill="none" className="stroke-muted-foreground/30" strokeWidth={3} strokeDasharray="1 9" strokeLinecap="round" />
            )}

            {/* 牆（路由器 / 防火牆）與通道穿過的缺口 / The wall (router / firewall) and the gap the tunnel passes through */}
            <rect x={l.wall.x} y={l.wall.y} width={l.wall.w} height={l.wall.h} rx={4} fill={`url(#${brick})`} className="stroke-warning/40" strokeWidth={1} />
            <rect {...gateCut} rx={3} className={cn("fill-card", view.gate === "open" ? "stroke-success" : view.gate === "pending" ? "stroke-warning" : "stroke-border")} strokeWidth={1.5} style={{ transition: "stroke 0.5s" }} />

            {/* 通道：裝置往外撥出 / The tunnel: dialed out by the device */}
            {view.tunnel === "off" && (
                <path d={l.tunnel} fill="none" className="stroke-muted-foreground/35" strokeWidth={3} strokeDasharray="1 9" strokeLinecap="round" />
            )}
            {view.tunnel === "pending" && (
                <>
                    <path d={l.tunnel} fill="none" className="stroke-warning/20" strokeWidth={12} strokeLinecap="round" />
                    <path d={l.tunnel} fill="none" className="stroke-warning" strokeWidth={3.5} strokeDasharray="10 10" strokeLinecap="round">
                        {animate && <animate attributeName="stroke-dashoffset" values="40;0" dur="0.9s" repeatCount="indefinite" />}
                    </path>
                    {animate && [0, 1.1].map((b) => <Packet key={b} path={l.tunnel} dur={2.2} begin={b} r={3.5} className="fill-warning" />)}
                </>
            )}
            {view.tunnel === "live" && (
                <>
                    <path d={l.tunnel} fill="none" className="stroke-success/15" strokeWidth={18} strokeLinecap="round" />
                    <path d={l.tunnel} fill="none" className="stroke-success" strokeWidth={7} strokeLinecap="round" />
                    <path d={l.tunnel} fill="none" className="stroke-white/45" strokeWidth={2} strokeDasharray="2 14" strokeLinecap="round">
                        {animate && <animate attributeName="stroke-dashoffset" values="0;32" dur="1s" repeatCount="indefinite" />}
                    </path>
                    {animate && [0, 0.8, 1.6].map((b) => <Packet key={b} path={l.tunnel} dur={2.4} begin={b} reverse className="fill-success" />)}
                </>
            )}
            {view.token && animate && <KeyToken path={l.tunnel} reverse={view.token === "in"} />}
        </svg>
    );
}

// ── 精簡條 / Compact strip ───────────────────────────────────────────────
// 預設只佔一行高：一樣看得到牆、通道狀態、裝置在不在線；要看完整插圖再展開。
// One row tall by default: the wall, the tunnel state and whether the device is online; expand for the full picture.

function MiniNode({ icon: Icon, glyph, label, suffix, active, online, tint }: { icon?: LucideIcon; glyph?: boolean; label: string; suffix?: string; active: boolean; online?: boolean | null; tint?: string }) {
    return (
        <span className={cn("flex min-w-0 shrink-0 flex-col items-center gap-1 transition-opacity duration-500", !active && "opacity-55")}>
            <span className={cn("relative grid size-9 place-items-center rounded-xl ring-1 ring-inset ring-border", glyph ? "bg-brand-gradient text-white ring-white/25" : "bg-card")}>
                {tint && <span className={cn("absolute inset-0 rounded-xl", tint)} aria-hidden />}
                {glyph ? <TelepyGlyph size={16} /> : Icon && <Icon size={17} strokeWidth={1.75} className="relative" />}
                {online != null && (
                    <span className={cn("absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />
                )}
            </span>
            <span className="max-w-[4.5rem] truncate text-[0.75rem] leading-none text-muted-foreground @min-[480px]:max-w-[6rem]" title={suffix ? `${label} ${suffix}` : label}>
                {label}
                {suffix && <span className="hidden @min-[480px]:inline"> {suffix}</span>}
            </span>
        </span>
    );
}

function MiniLine({ state, inbound, className }: { state: Wire | "off"; inbound?: boolean; className?: string }) {
    const anim = inbound ? "animate-flow-x" : "animate-flow-x-rev";
    return (
        <span className={cn("relative mx-1 mb-4 h-1.5 min-w-5 flex-1", className)} aria-hidden>
            {state === "off" && <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t-2 border-dotted border-muted-foreground/35" />}
            {state === "pending" && <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t-2 border-dashed border-warning" />}
            {state === "live" && <span className="absolute inset-0 rounded-full bg-success/80" />}
            {state !== "off" && ["0s", "0.9s"].map((d) => (
                <span key={d} className={cn("absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full opacity-0", state === "live" ? "bg-white" : "bg-warning", anim)} style={{ animationDelay: d }} />
            ))}
        </span>
    );
}

function SceneStrip({ view, name, connected, created, rttMs, reversePort }: { view: View; name: string; connected: boolean; created: boolean; rttMs: number | null; reversePort: number | null }) {
    const { t } = useI18n();
    const status =
        view.tunnel === "live" ? { cls: "text-success", icon: CheckCircle2, text: rttMs !== null ? t("wizard.scene.tunnelLiveRtt", { ms: Math.round(rttMs) }) : t("wizard.scene.tunnelLive") }
        : view.tunnel === "pending" ? { cls: "text-warning", icon: Radio, text: t("wizard.scene.tunnelPending") }
        : { cls: "text-muted-foreground", icon: Lock, text: t("wizard.scene.tunnelOff") };
    return (
        <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-1 items-end">
                {/* 很窄時省掉「你」：一眼要看的是通道、牆和裝置。/ Very narrow: drop "You"; the tunnel, wall and device matter at a glance. */}
                <span className="hidden min-w-0 flex-1 items-end @min-[420px]:flex">
                    <MiniNode icon={Laptop} tint="bg-info/12 text-info" label={t("wizard.scene.you")} active={view.active.you} />
                    <MiniLine state={view.access === "live" ? "live" : "off"} inbound />
                </span>
                <MiniNode glyph label="Telepy" suffix={reversePort !== null ? `:${reversePort}` : undefined} active={view.active.telepy} />
                <MiniLine state={view.tunnel} />
                {/* 私有網路：牆 + 裝置 / Private network: the wall and the device */}
                <span className="relative flex shrink-0 items-end rounded-xl border border-dashed border-foreground/25 bg-foreground/[0.03] px-2 pb-1.5 pt-2.5" title={t("wizard.scene.lanDetail")}>
                    <span className="absolute -top-2 left-2 whitespace-nowrap bg-card px-1 text-[0.6875rem] uppercase leading-none tracking-wider text-foreground/70">{t("wizard.scene.lan")}</span>
                    <span className="relative mb-4 h-9 w-2 shrink-0 rounded-sm bg-warning/25 ring-1 ring-warning/40 [background-image:repeating-linear-gradient(0deg,transparent_0_5px,var(--card)_5px_6px)]" title={t("wizard.scene.firewall")}>
                        <span className={cn("absolute -left-1 top-0.5 grid size-4 place-items-center rounded-full ring-2 ring-card", view.gate === "open" ? "bg-success text-white" : view.gate === "pending" ? "bg-warning text-warning-foreground" : "bg-card text-muted-foreground ring-border")} title={t("wizard.scene.outbound")}>
                            <ArrowUpRight size={10} strokeWidth={3} />
                        </span>
                        <span className="absolute -left-1 bottom-0.5 grid size-4 place-items-center rounded-full bg-destructive text-white ring-2 ring-card" title={t("wizard.scene.blocked")}>
                            <X size={10} strokeWidth={3} />
                        </span>
                    </span>
                    <MiniLine state={view.tunnel} className="min-w-4 max-w-8" />
                    <MiniNode icon={Server} tint="bg-muted/70" label={name} active={view.active.device} online={created ? connected : null} />
                </span>
            </div>
            <span className={cn("hidden shrink-0 items-center gap-1.5 text-xs @min-[560px]:inline-flex", status.cls)}>
                <status.icon size={14} aria-hidden /> {status.text}
            </span>
        </div>
    );
}

// ── 場景 / The scene ─────────────────────────────────────────────────────

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
    const tunnelPill = {
        off: { cls: "border-border text-muted-foreground", icon: Lock, text: t("wizard.scene.tunnelOff") },
        pending: { cls: "border-warning/40 text-foreground/80", icon: Radio, text: t("wizard.scene.tunnelPending") },
        live: { cls: "border-success/40 text-success", icon: Lock, text: rttMs !== null && connected ? t("wizard.scene.tunnelLiveRtt", { ms: Math.round(rttMs) }) : t("wizard.scene.tunnelLive") },
    }[view.tunnel];

    return (
        <div className="relative w-full" style={{ aspectRatio: `${l.w} / ${l.h}` }}>
            <SceneSvg l={l} view={view} reduced={reduced} />

            {/* 區域標籤 / Zone labels */}
            <span className={cn("absolute inline-flex items-center gap-1.5 text-[0.75rem] uppercase tracking-[0.14em] text-muted-foreground", ANCHOR[l.at.internet.a])} style={pos(l, l.at.internet.p)}>
                <Globe size={13} aria-hidden /> {t("wizard.scene.internet")}
            </span>
            <span className={cn("absolute flex flex-col gap-0.5", l.at.lan.a === "center" ? "items-center text-center" : "items-start", ANCHOR[l.at.lan.a])} style={pos(l, l.at.lan.p)}>
                <span className="inline-flex items-center gap-1.5 text-[0.75rem] uppercase tracking-[0.14em] text-foreground/70">
                    <House size={13} aria-hidden /> {t("wizard.scene.lan")}
                </span>
                <span className="whitespace-nowrap text-[0.75rem] text-muted-foreground">{t("wizard.scene.lanDetail")}</span>
            </span>

            {/* 牆上的標示 / Signs on the wall */}
            <Pill l={l} at={l.at.firewall} className="border-warning/30 text-muted-foreground">
                <ShieldHalf size={12} className="text-warning" aria-hidden /> {t("wizard.scene.firewall")}
            </Pill>
            <Marker l={l} p={l.block} className="bg-destructive text-white">
                <X size={14} strokeWidth={3} aria-hidden />
            </Marker>
            <Pill l={l} at={l.at.block} className="border-destructive/30 text-destructive">
                <X size={11} strokeWidth={3} aria-hidden /> {t("wizard.scene.blocked")}
            </Pill>
            <Marker
                l={l}
                p={l.gate}
                className={view.gate === "open" ? "bg-success text-white" : view.gate === "pending" ? "bg-warning text-white" : "bg-card text-muted-foreground ring-border"}
            >
                {view.gate !== "idle" && !reduced && (
                    <span className={cn("absolute inset-0 rounded-full animate-status-ping", view.gate === "open" ? "bg-success" : "bg-warning")} aria-hidden />
                )}
                <ArrowUpRight size={14} strokeWidth={2.5} className={cn("relative", l.tall && "-rotate-45")} aria-hidden />
            </Marker>
            <Pill l={l} at={l.at.gate} className={view.gate === "idle" ? "border-border text-muted-foreground" : "border-success/35 text-success"}>
                <ArrowUpRight size={11} strokeWidth={2.5} aria-hidden /> {t("wizard.scene.outbound")}
            </Pill>

            {/* 線上的標籤 / Labels on the lines */}
            <Pill l={l} at={l.at.tunnel} className={tunnelPill.cls}>
                <tunnelPill.icon size={11} aria-hidden /> {tunnelPill.text}
            </Pill>
            {view.access === "live" && (
                <Pill l={l} at={l.at.access} className="border-info/35 text-info">
                    {t("wizard.scene.access")}
                </Pill>
            )}

            {/* 節點 / Nodes */}
            <SceneNode l={l} at={l.you} icon={Laptop} tint="bg-info/12 text-info" title={t("wizard.scene.you")} detail={t("wizard.scene.youDetail")} active={view.active.you} above={l.tall} />
            <SceneNode l={l} at={l.telepy} glyph title="Telepy" detail={t("wizard.scene.telepyDetail")} active={view.active.telepy} above={l.tall}>
                {reversePort !== null && <Chip tone="primary" title={t("wizard.scene.reservedPort")}>:{reversePort}</Chip>}
            </SceneNode>
            <SceneNode
                l={l}
                at={l.device}
                icon={Server}
                tint="bg-muted/70"
                title={name}
                detail={t("wizard.scene.deviceDetail")}
                active={view.active.device}
                online={created ? connected : null}
            >
                <Chip title={t("wizard.scene.sshdPort")}>sshd :{sshPort || "22"}</Chip>
                {step >= 2 && shown.map((a) => <Chip key={a} icon={User}>{a}</Chip>)}
                {step >= 2 && more > 0 && <Chip>+{more}</Chip>}
                {step >= 4 && (
                    <Chip icon={KeyRound} tone={allLoginsOk ? "ok" : "muted"} title={t("wizard.scene.keysPlaced")}>authorized_keys</Chip>
                )}
            </SceneNode>
        </div>
    );
}

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

    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setPhase((p) => (p + 1) % STORY.length), STORY_MS);
        return () => clearInterval(timer);
    }, [playing]);

    const view = story ? STORY[phase] : liveView(step, created, connected);

    let caption: string;
    let CaptionIcon: LucideIcon = Sparkles;
    let captionTone = "text-primary";
    switch (step) {
        case 1:
            // Step 1 沒連上時播故事，這裡只剩「已連上」。/ Step 1 plays the story until connected, so only "online" lands here.
            caption = t("wizard.scene.caption4Online", { name: sentenceName });
            CaptionIcon = CheckCircle2;
            break;
        case 2:
            caption = t("wizard.scene.caption2", { name: sentenceName });
            break;
        case 3:
            caption = t("wizard.scene.caption3", { name: sentenceName });
            break;
        case 4:
            caption = connected ? t("wizard.scene.caption4Online", { name: sentenceName }) : t("wizard.scene.caption4Waiting", { name: sentenceName });
            if (connected) CaptionIcon = CheckCircle2;
            else {
                CaptionIcon = Hourglass;
                captionTone = "text-warning";
            }
            break;
        default:
            if (allLoginsOk) {
                caption = t("wizard.scene.caption5Ready", { name: sentenceName });
                CaptionIcon = CheckCircle2;
            } else if (connected) {
                caption = t("wizard.scene.caption5Checking", { name: sentenceName });
            } else {
                caption = t("wizard.scene.caption5Offline", { name: sentenceName });
                CaptionIcon = Hourglass;
                captionTone = "text-warning";
            }
    }

    const sceneProps = { view, reduced, name, sshPort, reversePort, accounts, connected, created, step, rttMs, allLoginsOk };

    return (
        <figure
            ref={figure}
            className={cn("@container relative overflow-hidden rounded-xl border border-border bg-muted/30", mode === "full" ? "px-3 pb-4 pt-5 sm:px-5" : "px-3 py-3 sm:px-4")}
            aria-label={t("wizard.scene.aria")}
        >
            {mode === "compact" ? (
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <SceneStrip view={liveView(step, created, connected)} name={name} connected={connected} created={created} rttMs={rttMs} reversePort={reversePort} />
                    </div>
                    <button
                        type="button"
                        onClick={() => expand(step === 1 && !connected)}
                        aria-label={t("wizard.scene.showDiagram")}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                        <Maximize2 size={13} aria-hidden /> <span className="hidden @min-[420px]:inline">{t("wizard.scene.showDiagram")}</span>
                    </button>
                </div>
            ) : (
            <>
            <button
                type="button"
                onClick={collapse}
                className="absolute right-2.5 top-2.5 z-30 inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
                <ChevronUp size={13} aria-hidden /> {t("wizard.scene.collapse")}
            </button>
            {/* 淡淡的點陣底紋 / Faint dot-grid backdrop */}
            <span
                className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,black,transparent)]"
                aria-hidden
            />
            <div className="relative hidden @min-[640px]:block">
                <Scene l={WIDE} {...sceneProps} />
            </div>
            <div className="relative mx-auto max-w-[400px] @min-[640px]:hidden">
                <Scene l={TALL} {...sceneProps} />
            </div>

            <div className="relative mt-5 border-t border-border/70 pt-4">
                {story ? (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {STORY_TEXT.map((s, i) => (
                                <button
                                    key={s.title}
                                    type="button"
                                    onClick={() => {
                                        setPhase(i);
                                        setPaused(true);
                                    }}
                                    aria-pressed={phase === i}
                                    className={cn(
                                        "relative inline-flex items-center gap-2 overflow-hidden rounded-full border px-3 py-1 text-xs transition-colors",
                                        phase === i
                                            ? i === 0 ? "border-destructive/40 bg-destructive/8 text-destructive" : "border-primary/40 bg-primary/8 text-primary"
                                            : "border-border bg-card text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    <span className={cn("grid size-4 place-items-center rounded-full text-[0.6875rem]", phase === i ? (i === 0 ? "bg-destructive text-white" : "bg-primary text-primary-foreground") : "bg-muted")}>{i + 1}</span>
                                    {t(s.title)}
                                    {/* 自動播放時的進度條 / Progress bar while auto-playing */}
                                    {phase === i && playing && (
                                        <span key={`${phase}-${i}`} className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-current opacity-40 animate-progress-fill" style={{ animationDuration: `${STORY_MS}ms`, animationTimingFunction: "linear" }} aria-hidden />
                                    )}
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => setPaused((p) => !p)}
                                className="grid size-7 place-items-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
                                aria-label={paused || reduced ? t("wizard.scene.play") : t("wizard.scene.pause")}
                            >
                                {paused || reduced ? <Play size={13} /> : <Pause size={13} />}
                            </button>
                            {!storyDefault && (
                                <button type="button" onClick={() => setStoryStep(null)} className="ml-auto text-xs text-primary hover:underline">
                                    {t("wizard.scene.liveView")}
                                </button>
                            )}
                        </div>
                        <p className="text-sm leading-relaxed text-foreground/85">{t(STORY_TEXT[phase].body, { name: sentenceName })}</p>
                    </div>
                ) : (
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-relaxed text-foreground/85" aria-live="polite">
                            <CaptionIcon size={16} className={cn("mt-0.5 shrink-0", captionTone)} aria-hidden />
                            <span>{caption}</span>
                        </p>
                        <button
                            type="button"
                            onClick={() => expand(true)}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                        >
                            <PlayCircle size={14} aria-hidden /> {t("wizard.scene.howItWorks")}
                        </button>
                    </div>
                )}
            </div>
            </>
            )}
        </figure>
    );
}
