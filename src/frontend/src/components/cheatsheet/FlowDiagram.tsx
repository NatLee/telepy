/**
 * 指令速查的流程圖：節點（你的電腦 / Telepy / 裝置 / 目標服務…）＋連線，封包光點沿流量方向移動。
 * 桌面版水平排列、手機版垂直堆疊；SSH 段是實心管線（加密），裝置之後的明文 TCP 段是虛線。
 * Command-sheet flow diagram: nodes (your computer / Telepy / the device / the target…) joined by links with
 * packets moving in the traffic direction. Horizontal on desktop, stacked on phones; SSH legs are solid pipes
 * (encrypted), the plain-TCP leg after the device is dashed.
 */
import React from "react";
import {
    AppWindow,
    Cable,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Cpu,
    Globe,
    Laptop,
    Lock,
    MonitorSmartphone,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type FlowNodeKind = "you" | "server" | "device" | "service" | "lan" | "internet";

export interface FlowNode {
    kind: FlowNodeKind;
    title: string;
    detail?: string;
    /** 等寬字的位址 / 埠標籤（localhost:8080…）。/ Monospace address chip (localhost:8080…). */
    chip?: string;
    /** 「在這裡使用」標記：你要把程式連到的那一端。/ "Use it here" marker: the end you point your app at. */
    entry?: string;
}

export interface FlowLinkSpec {
    label: string;
    style: "ssh" | "plain";
    direction: "forward" | "backward";
}

const NODE_STYLE: Record<FlowNodeKind, { icon: LucideIcon; tone: string }> = {
    you: { icon: Laptop, tone: "bg-info/12 text-info ring-info/25" },
    server: { icon: Cable, tone: "bg-brand-gradient text-white ring-white/20 shadow-glow" },
    device: { icon: Cpu, tone: "bg-primary/12 text-primary ring-primary/25" },
    service: { icon: AppWindow, tone: "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:text-amber-400" },
    lan: { icon: MonitorSmartphone, tone: "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:text-amber-400" },
    internet: { icon: Globe, tone: "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:text-amber-400" },
};

function NodeCard({ node }: { node: FlowNode }) {
    const { icon: Icon, tone } = NODE_STYLE[node.kind];
    return (
        <div
            className={cn(
                "relative flex md:flex-col items-center gap-3 md:gap-2 rounded-2xl border bg-background/75 p-3 md:px-3 md:py-4 md:text-center min-w-0 md:flex-1 md:basis-0",
                node.entry ? "border-primary/50 ring-2 ring-primary/15" : "border-border"
            )}
        >
            {node.entry && (
                <span className="absolute -top-2.5 right-3 md:right-auto md:left-1/2 md:-translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm">
                    {node.entry}
                </span>
            )}
            <span className={cn("grid place-items-center size-11 rounded-xl ring-1 ring-inset shrink-0", tone)} aria-hidden>
                <Icon size={20} />
            </span>
            <span className="flex flex-col md:items-center min-w-0 gap-0.5">
                <span className="text-sm font-semibold text-foreground truncate max-w-full" title={node.title}>{node.title}</span>
                {node.detail && <span className="text-[11px] leading-snug text-muted-foreground">{node.detail}</span>}
                {node.chip && (
                    <code className="mt-1 max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/85" title={node.chip}>
                        {node.chip}
                    </code>
                )}
            </span>
        </div>
    );
}

const PACKET_DELAYS = ["0s", "0.6s", "1.2s"];

function LinkTrack({ spec, axis }: { spec: FlowLinkSpec; axis: "x" | "y" }) {
    const ssh = spec.style === "ssh";
    const back = spec.direction === "backward";
    const anim = axis === "x" ? (back ? "animate-flow-x-rev" : "animate-flow-x") : (back ? "animate-flow-y-rev" : "animate-flow-y");
    const Arrow = axis === "x" ? (back ? ChevronLeft : ChevronRight) : (back ? ChevronUp : ChevronDown);
    return (
        <div
            className={cn(
                "relative rounded-full",
                axis === "x" ? "h-1.5 w-full" : "w-1.5 h-full",
                ssh ? "bg-primary/20 ring-1 ring-inset ring-primary/25" : "bg-transparent",
            )}
        >
            {!ssh && (
                <span
                    className={cn(
                        "absolute border-dashed border-muted-foreground/40",
                        axis === "x" ? "inset-x-0 top-1/2 -translate-y-1/2 border-t-2" : "inset-y-0 left-1/2 -translate-x-1/2 border-l-2"
                    )}
                    aria-hidden
                />
            )}
            {PACKET_DELAYS.map((delay) => (
                <span
                    key={delay}
                    className={cn(
                        "absolute size-2 rounded-full opacity-0",
                        axis === "x" ? "top-1/2 -translate-y-1/2" : "left-1/2 -translate-x-1/2",
                        ssh ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-brand-2 shadow-[0_0_8px_var(--brand-2)]",
                        anim
                    )}
                    style={{ animationDelay: delay }}
                    aria-hidden
                />
            ))}
            <Arrow
                size={14}
                className={cn(
                    "absolute",
                    ssh ? "text-primary" : "text-muted-foreground",
                    axis === "x"
                        ? cn("top-1/2 -translate-y-1/2", back ? "-left-2" : "-right-2")
                        : cn("left-1/2 -translate-x-1/2", back ? "-top-2" : "-bottom-2")
                )}
                aria-hidden
            />
        </div>
    );
}

function LinkView({ spec }: { spec: FlowLinkSpec }) {
    const label = (
        <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap", spec.style === "ssh" ? "text-primary" : "text-muted-foreground")}>
            {spec.style === "ssh" && <Lock size={10} aria-hidden />}
            {spec.label}
        </span>
    );
    return (
        <>
            {/* 桌面：水平 / Desktop: horizontal */}
            <div className="hidden md:flex flex-col items-center justify-center gap-2 w-20 lg:w-28 shrink-0 px-1">
                {label}
                <LinkTrack spec={spec} axis="x" />
            </div>
            {/* 手機：垂直 / Phones: vertical */}
            <div className="md:hidden grid grid-cols-[1fr_auto_1fr] h-14 gap-3 py-1">
                <span />
                <LinkTrack spec={spec} axis="y" />
                <span className="self-center justify-self-start">{label}</span>
            </div>
        </>
    );
}

export function FlowDiagram({ nodes, links }: { nodes: FlowNode[]; links: FlowLinkSpec[] }) {
    const { t } = useI18n();
    return (
        <figure className="rounded-2xl border border-border bg-muted/30 p-4 sm:p-5" aria-label={t("sheet.diagramAria")}>
            <div className="flex flex-col md:flex-row md:items-stretch">
                {nodes.map((node, i) => (
                    <React.Fragment key={`${node.kind}-${i}`}>
                        <NodeCard node={node} />
                        {i < links.length && <LinkView spec={links[i]} />}
                    </React.Fragment>
                ))}
            </div>
            <figcaption className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-6 rounded-full bg-primary/25 ring-1 ring-inset ring-primary/30" aria-hidden />
                    {t("sheet.legendSsh")}
                </span>
                <span className="inline-flex items-center gap-2">
                    <span className="w-6 border-t-2 border-dashed border-muted-foreground/40" aria-hidden />
                    {t("sheet.legendPlain")}
                </span>
                <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" aria-hidden />
                    {t("sheet.legendPacket")}
                </span>
            </figcaption>
        </figure>
    );
}
