"use client";

/**
 * ~/.ssh/config 的路線圖：你的電腦 ─ssh─▶ Telepy（區塊 ①）═通道═▶ 裝置（區塊 ②）。
 * 節點上的 1 / 2 對應下面的兩個區塊；滑過節點或區塊時兩邊一起亮，看得出哪一段設定管哪一段路。手機上改成直排。
 * Route map for ~/.ssh/config: your computer ─ssh─▶ Telepy (block ①) ═tunnel═▶ the device (block ②). The 1 / 2
 * badges match the stanzas below; hovering a node or a stanza lights up both, so each block maps to its leg of the
 * trip. Stacks vertically on phones.
 */
import React from "react";
import { Boxes, ChevronDown, ChevronRight, Cpu, Laptop, Lock } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type ConfigPart = "server" | "device";

interface Props {
    server: { host: string; port: string } | null;
    /** 選定帳號的裝置區塊（可能多個，也可能沒有）。/ The selected accounts' device stanzas (any number). */
    hosts: { alias: string; username: string }[];
    deviceName: string;
    reversePort: number | null;
    online: boolean | null;
    active: ConfigPart | null;
    onActive: (part: ConfigPart | null) => void;
    /** 多台一次（多台的 SSH config）：最後一格是「N 台裝置」。/ Several devices at once: the last node reads "N devices". */
    many?: { count: number; online: number };
}

function Badge({ n }: { n: number }) {
    return (
        <span className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-[0.6875rem] text-background ring-2 ring-surface" aria-hidden>
            {n}
        </span>
    );
}

interface NodeProps {
    tile: React.ReactNode;
    tileClass: string;
    name: React.ReactNode;
    sub: React.ReactNode;
    badge?: number;
    part?: ConfigPart;
    active: ConfigPart | null;
    onActive: (part: ConfigPart | null) => void;
}

function Node({ tile, tileClass, name, sub, badge, part, active, onActive }: NodeProps) {
    const lit = part !== undefined && active === part;
    const dim = active !== null && !lit;
    return (
        <div
            className={cn("flex min-w-0 items-center gap-3 transition-opacity sm:w-36 sm:shrink-0 sm:flex-col sm:gap-2 sm:text-center", dim && "opacity-45")}
            onMouseEnter={part ? () => onActive(part) : undefined}
            onMouseLeave={part ? () => onActive(null) : undefined}
        >
            <span className={cn("relative grid size-11 shrink-0 place-items-center rounded-xl ring-1 ring-inset transition-shadow sm:size-12", tileClass, lit && "ring-2 ring-primary")}>
                {tile}
                {badge !== undefined && <Badge n={badge} />}
            </span>
            {/* 手機直排時換行（日文標籤在放大顯示下會被截掉），桌面的窄欄才截斷。/ Wrap when stacked, truncate in the desktop columns. */}
            <div className="min-w-0">
                <p className="text-sm text-foreground [overflow-wrap:anywhere] sm:truncate">{name}</p>
                <div className="font-mono text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere] sm:truncate">{sub}</div>
            </div>
        </div>
    );
}

const DELAYS = ["0s", "0.6s", "1.2s"];

/** 連線：tunnel = 粗的 Telepy 通道；ssh = 細線。封包沿流量方向走（減少動態時全域 CSS 會停掉）。 */
function Link({ kind, label, lit, dim }: { kind: "ssh" | "tunnel"; label: string; lit: boolean; dim: boolean }) {
    const tunnel = kind === "tunnel";
    const track = (axis: "x" | "y") => (
        <div
            className={cn(
                "relative rounded-full ring-1 ring-inset transition-[box-shadow,background-color]",
                axis === "x" ? (tunnel ? "h-3.5 w-full" : "h-2 w-full") : tunnel ? "h-full w-3.5" : "h-full w-2",
                tunnel ? "bg-primary/20 ring-primary/35" : "bg-muted ring-border",
                lit && "ring-2 ring-primary/60"
            )}
        >
            {DELAYS.map((delay) => (
                <span
                    key={delay}
                    className={cn(
                        "absolute size-1.5 rounded-full opacity-0",
                        axis === "x" ? "top-1/2 -translate-y-1/2 animate-flow-x" : "left-1/2 -translate-x-1/2 animate-flow-y",
                        tunnel ? "bg-primary" : "bg-foreground/50"
                    )}
                    style={{ animationDelay: delay }}
                    aria-hidden
                />
            ))}
            {axis === "x" ? (
                <ChevronRight size={14} className={cn("absolute -right-2.5 top-1/2 -translate-y-1/2", tunnel ? "text-primary" : "text-muted-foreground")} aria-hidden />
            ) : (
                <ChevronDown size={14} className={cn("absolute -bottom-2.5 left-1/2 -translate-x-1/2", tunnel ? "text-primary" : "text-muted-foreground")} aria-hidden />
            )}
        </div>
    );
    const text = (
        <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[0.75rem]", tunnel ? "text-primary" : "text-muted-foreground")}>
            <Lock size={10} aria-hidden />
            <span className={cn("truncate", kind === "ssh" && "font-mono")}>{label}</span>
        </span>
    );
    return (
        <>
            {/* 桌面：水平，對齊圖示中心 / Desktop: horizontal, level with the tile centres */}
            <div className={cn("relative hidden h-12 min-w-14 flex-1 items-center px-3 transition-opacity sm:flex", dim && "opacity-45")}>
                <span className="absolute -top-2 left-1/2 max-w-full -translate-x-1/2 truncate" title={label}>{text}</span>
                {track("x")}
            </div>
            {/* 手機：垂直 / Phones: vertical */}
            <div className={cn("flex h-9 items-stretch gap-3 py-1 pl-[1.125rem] transition-opacity sm:hidden", dim && "opacity-45")}>
                {track("y")}
                <span className="self-center pl-3">{text}</span>
            </div>
        </>
    );
}

export function ConfigRouteMap({ server, hosts, deviceName, reversePort, online, active, onActive, many }: Props) {
    const { t } = useI18n();
    const users = hosts.map((h) => h.username);
    const deviceSub: React.ReactNode = (
        <span className="inline-flex max-w-full items-center gap-1.5">
            {online !== null && (
                <span
                    className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/50")}
                    title={online ? t("config.map.online") : t("config.map.offline")}
                    aria-label={online ? t("config.map.online") : t("config.map.offline")}
                />
            )}
            <span className="truncate">{users.length > 0 ? t("config.map.asUser", { user: users.join(", ") }) : "—"}</span>
        </span>
    );
    // 多個帳號時別名各不相同（第三步會逐一列出），這裡只寫 ssh。/ Several aliases (listed in step 3): just "ssh".
    const sshLabel = hosts.length === 1 ? `ssh ${hosts[0].alias}` : "ssh";
    return (
        <figure className="rounded-xl border border-border bg-surface/60 px-4 py-4 sm:px-5 sm:pt-6" aria-label={t("config.map.aria")}>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-center">
                <Node
                    tile={<Laptop size={22} strokeWidth={1.75} />}
                    tileClass="bg-info/12 text-info ring-info/30"
                    name={t("config.map.you")}
                    sub="~/.ssh/config"
                    active={active}
                    onActive={onActive}
                />
                <Link kind="ssh" label={sshLabel} lit={active === "server"} dim={active === "device"} />
                <Node
                    tile={<TelepyGlyph size={22} className="text-white" />}
                    tileClass="bg-brand-gradient ring-black/5"
                    name="Telepy"
                    sub={server ? `${server.host}:${server.port}` : "—"}
                    badge={1}
                    part="server"
                    active={active}
                    onActive={onActive}
                />
                <Link
                    kind="tunnel"
                    label={many ? t("config.bulk.mapTunnels", { count: many.count }) : reversePort !== null ? t("config.map.tunnel", { port: reversePort }) : "Telepy"}
                    lit={active === "device"}
                    dim={active === "server"}
                />
                {many ? (
                    <Node
                        tile={<Boxes size={22} strokeWidth={1.75} />}
                        tileClass="bg-card text-foreground ring-border"
                        name={t("config.bulk.mapDevices", { count: many.count })}
                        sub={
                            <span className="inline-flex max-w-full items-center gap-1.5">
                                <span className={cn("size-1.5 shrink-0 rounded-full", many.online > 0 ? "bg-success" : "bg-muted-foreground/50")} aria-hidden />
                                <span className="sm:truncate">{t("config.bulk.mapOnline", { online: many.online, count: many.count })}</span>
                            </span>
                        }
                        badge={many.count > 0 ? 2 : undefined}
                        part={many.count > 0 ? "device" : undefined}
                        active={active}
                        onActive={onActive}
                    />
                ) : (
                    <Node
                        tile={<Cpu size={22} strokeWidth={1.75} />}
                        tileClass="bg-card text-foreground ring-border"
                        name={hosts.length === 1 ? hosts[0].alias : deviceName}
                        sub={deviceSub}
                        badge={hosts.length > 0 ? 2 : undefined}
                        part={hosts.length > 0 ? "device" : undefined}
                        active={active}
                        onActive={onActive}
                    />
                )}
            </div>
        </figure>
    );
}
