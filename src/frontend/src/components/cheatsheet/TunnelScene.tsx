/**
 * 指令速查的插圖式場景：每個情境都用同一套構圖——你的電腦 ═ 加密通道（經 Telepy）═ 裝置（─ 後面的目標）。
 * 埠畫成機器上的「插座」，封包（複製檔案時是檔案）沿流量方向移動。看的是插圖自己的寬度（container query）而不是視窗：
 * 三台機器橫排要 41rem，放不下（手機、有側欄的平板）就改成直排。
 * Illustrated scene for the command sheet. Every recipe uses the same layout — your computer ═ encrypted tunnel
 * (via Telepy) ═ the device (─ whatever sits behind it) — with ports drawn as sockets on the machines and packets
 * (files when copying) moving in the traffic direction. Goes by the figure's own width (container query), not the
 * viewport: three machines in a row need 41rem, so anything narrower (phones, tablets with the sidebar) stacks them.
 *
 * 構圖參考 iximiuz「A Visual Guide to SSH Tunnels」：固定拓樸、實線是 SSH、虛線是轉發出去的連線。
 * Layout follows iximiuz's "A Visual Guide to SSH Tunnels": a fixed topology, solid = SSH, dashed = forwarded hop.
 */
import React from "react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, Lock, Plug, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type SceneRole = "you" | "device" | "target";

export interface SceneNode {
    icon: LucideIcon;
    role: SceneRole;
    name: string;
    sub?: string;
    /** 機器上的埠 / 路徑（插座）。/ The port or path "socket" on this machine. */
    socket?: string;
    /** 你要把程式連到這個插座。/ Point your app at this socket. */
    entry?: boolean;
}

export interface SceneLink {
    /** tunnel：經 Telepy 的加密通道；ssh：再一段 SSH；plain：裝置轉出去的明文 TCP。 */
    kind: "tunnel" | "ssh" | "plain";
    direction: "forward" | "backward";
    label?: string;
}

// 橘色只代表 Telepy 的通道；裝置本身用中性色，免得跟通道混在一起。/ Orange means the Telepy tunnel; the device stays neutral.
const ROLE_TONE: Record<SceneRole, string> = {
    you: "bg-info/12 text-info ring-info/30",
    device: "bg-foreground/[0.06] text-foreground ring-border",
    target: "bg-warning/12 text-warning ring-warning/30",
};

function Node({ node }: { node: SceneNode }) {
    const { t } = useI18n();
    const Icon = node.icon;
    return (
        <div className="flex @min-[42rem]:flex-col items-center gap-3 @min-[42rem]:gap-2 @min-[42rem]:text-center min-w-0 @min-[42rem]:w-40 @min-[46rem]:w-44 @min-[42rem]:shrink-0">
            <span className={cn("grid place-items-center size-14 @min-[42rem]:size-16 shrink-0 rounded-xl ring-1 ring-inset bg-card shadow-card", ROLE_TONE[node.role])} aria-hidden>
                <Icon size={28} strokeWidth={1.75} />
            </span>
            <div className="flex flex-col @min-[42rem]:items-center gap-1.5 min-w-0">
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate" title={node.name}>{node.name}</p>
                    {node.sub && <p className="text-[0.75rem] leading-snug text-muted-foreground">{node.sub}</p>}
                </div>
                {node.socket && (
                    <span
                        className={cn(
                            // 直排時欄位是 stretch，self-start 讓插座跟內容一樣寬。/ self-start: content-wide in the stacked layout's stretched column.
                            "inline-flex max-w-full items-center gap-1 self-start rounded-full px-2.5 py-1 font-mono text-xs ring-1 ring-inset @min-[42rem]:self-auto",
                            node.entry ? "bg-primary text-primary-foreground ring-primary" : "bg-muted text-foreground ring-border"
                        )}
                        title={node.socket}
                    >
                        <Plug size={12} className="shrink-0" aria-hidden />
                        <span className="truncate">{node.socket}</span>
                    </span>
                )}
                {node.entry && (
                    <span className="text-[0.6875rem] text-primary">{t("sheet.scene.useHere")}</span>
                )}
            </div>
        </div>
    );
}

const DELAYS = ["0s", "0.6s", "1.2s"];

function Packets({ axis, back, file, plain }: { axis: "x" | "y"; back: boolean; file: boolean; plain: boolean }) {
    const anim = axis === "x" ? (back ? "animate-flow-x-rev" : "animate-flow-x") : (back ? "animate-flow-y-rev" : "animate-flow-y");
    const pos = axis === "x" ? "top-1/2 -translate-y-1/2" : "left-1/2 -translate-x-1/2";
    return (
        <>
            {DELAYS.map((delay) => (
                file ? (
                    <FileText key={delay} size={12} className={cn("absolute opacity-0 text-primary", pos, anim)} style={{ animationDelay: delay }} aria-hidden />
                ) : (
                    <span
                        key={delay}
                        className={cn("absolute size-2 rounded-full opacity-0", pos, anim, plain ? "bg-brand-2" : "bg-primary")}
                        style={{ animationDelay: delay }}
                        aria-hidden
                    />
                )
            ))}
        </>
    );
}

function Track({ link, axis, file }: { link: SceneLink; axis: "x" | "y"; file: boolean }) {
    const back = link.direction === "backward";
    const plain = link.kind === "plain";
    const Arrow = axis === "x" ? (back ? ChevronLeft : ChevronRight) : (back ? ChevronUp : ChevronDown);
    const thick = link.kind === "tunnel";
    return (
        <div
            className={cn(
                "relative rounded-full",
                axis === "x" ? "w-full" : "h-full",
                axis === "x" ? (thick ? "h-4" : plain ? "h-0" : "h-2.5") : (thick ? "w-4" : plain ? "w-0" : "w-2.5"),
                !plain && "bg-linear-to-r from-primary/20 to-brand-2/25 ring-1 ring-inset ring-primary/30",
                plain && (axis === "x" ? "border-t-2 border-dashed border-muted-foreground/45" : "border-l-2 border-dashed border-muted-foreground/45")
            )}
        >
            <Packets axis={axis} back={back} file={file} plain={plain} />
            <Arrow
                size={16}
                className={cn(
                    "absolute",
                    plain ? "text-muted-foreground" : "text-primary",
                    axis === "x" ? cn("top-1/2 -translate-y-1/2", back ? "-left-3" : "-right-3") : cn("left-1/2 -translate-x-1/2", back ? "-top-3" : "-bottom-3")
                )}
                aria-hidden
            />
        </div>
    );
}

function LinkLabel({ link }: { link: SceneLink }) {
    if (link.kind === "tunnel") {
        return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/25 bg-card px-2 py-0.5 text-[0.75rem] font-medium text-primary shadow-sm">
                <span className="grid place-items-center size-4 rounded bg-brand-gradient" aria-hidden><TelepyGlyph size={11} className="text-white" /></span>
                <Lock size={10} aria-hidden />
                {link.label}
            </span>
        );
    }
    return (
        <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[0.75rem] font-medium", link.kind === "plain" ? "text-muted-foreground" : "text-primary")}>
            {link.kind === "ssh" && <Lock size={10} aria-hidden />}
            {link.label}
        </span>
    );
}

function Link({ link, file }: { link: SceneLink; file: boolean }) {
    return (
        <>
            {/* 寬：水平，和圖示中心對齊 / Wide: horizontal, aligned with the icon centres */}
            <div className="hidden @min-[42rem]:flex relative flex-1 min-w-16 max-w-[20rem] self-start h-16 items-center px-3">
                <span className="absolute left-1/2 -translate-x-1/2 -top-1">
                    <LinkLabel link={link} />
                </span>
                <Track link={link} axis="x" file={file} />
            </div>
            {/* 窄：垂直；線放在跟圖示一樣寬的欄裡，粗細不同的線都對準圖示中心。
                Narrow: vertical; the track sits in an icon-wide column so every kind of line hits the icon centre. */}
            <div className="@min-[42rem]:hidden flex items-stretch h-16 py-2">
                <div className="flex w-14 shrink-0 justify-center">
                    <Track link={link} axis="y" file={file} />
                </div>
                <span className="self-center pl-3"><LinkLabel link={link} /></span>
            </div>
        </>
    );
}

export function TunnelScene({ nodes, links, file = false, caption }: {
    nodes: SceneNode[];
    links: SceneLink[];
    /** 封包畫成檔案（複製檔案情境）。/ Draw packets as files (copy recipe). */
    file?: boolean;
    caption?: React.ReactNode;
}) {
    const { t } = useI18n();
    return (
        <figure className="@container rounded-xl border border-border bg-surface/60 px-4 pt-6 pb-4 sm:px-6" aria-label={t("sheet.scene.aria")}>
            {/* 直排時整欄置中，寬的框裡才不會全擠在左邊。/ Stacked: centre the column so a wide frame isn't all left-heavy. */}
            <div className="mx-auto flex max-w-sm flex-col @min-[42rem]:max-w-none @min-[42rem]:flex-row @min-[42rem]:items-start @min-[42rem]:justify-center">
                {nodes.map((node, i) => (
                    <React.Fragment key={i}>
                        <Node node={node} />
                        {i < links.length && <Link link={links[i]} file={file} />}
                    </React.Fragment>
                ))}
            </div>
            {caption && (
                <figcaption className="mx-auto mt-5 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
                    {caption}
                </figcaption>
            )}
        </figure>
    );
}

/**
 * 情境卡片上的迷你插圖（不帶數值）。卡片要是 `@container`：窄卡片（手機兩欄）用小一號的圖示；
 * 還是放不下（Safari 頁面縮放、iOS 放大顯示、顯示大小調大）就先縮短連線、再縮小圖示，永遠留在卡片裡。
 * Tiny illustration for a recipe card (no values). The card must be an `@container`: narrow cards (two columns on a
 * phone) get smaller icons; if it still doesn't fit (Safari page zoom, iOS Display Zoom, a larger display size) the
 * links shrink first and then the icons, so it always stays inside the card.
 */
export type MiniItem = { icon: LucideIcon; role: SceneRole } | { link: SceneLink["kind"]; back?: boolean; both?: boolean };

export function MiniScene({ items, active }: { items: MiniItem[]; active: boolean }) {
    return (
        <div className="flex max-w-full items-center" aria-hidden>
            {items.map((it, i) => {
                if ("icon" in it) {
                    const Icon = it.icon;
                    return (
                        <span key={i} className={cn("grid aspect-square w-7 min-w-5 shrink place-items-center rounded-lg ring-1 ring-inset bg-card @[10.5rem]:w-8", ROLE_TONE[it.role])}>
                            <Icon size={16} strokeWidth={1.75} className="size-3.5 @[10.5rem]:size-4" />
                        </span>
                    );
                }
                const plain = it.link === "plain";
                return (
                    <span key={i} className="relative mx-0.5 flex w-7 min-w-2.5 shrink-[4] items-center">
                        {it.back || it.both ? <ChevronLeft size={12} className={cn("absolute -left-1.5", plain ? "text-muted-foreground" : "text-primary")} /> : null}
                        <span
                            className={cn(
                                "w-full",
                                plain ? "border-t-2 border-dashed border-muted-foreground/45" : it.link === "tunnel" ? "h-1.5 rounded-full bg-primary/40" : "h-1 rounded-full bg-primary/30",
                                active && !plain && "bg-primary"
                            )}
                        />
                        {!it.back || it.both ? <ChevronRight size={12} className={cn("absolute -right-1.5", plain ? "text-muted-foreground" : "text-primary")} /> : null}
                    </span>
                );
            })}
        </div>
    );
}
