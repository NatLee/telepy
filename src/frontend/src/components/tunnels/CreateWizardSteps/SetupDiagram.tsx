/**
 * 建立精靈上方的「活拓撲圖」：你 ⇄ Telepy ⇄ 裝置。隨步驟高亮相關節點，並反映真實狀態：
 * 通道建立前是虛線、等待裝置撥入時是閃爍虛線、上線後是有封包流動的實線；
 * Step 1 有一把鑰匙從裝置送往 Telepy（Telepy 記住裝置的公鑰），Step 3 反過來（Telepy 的鑰匙放進 authorized_keys）。
 * The wizard's live topology: you ⇄ Telepy ⇄ device. It highlights the nodes the current step is about and mirrors
 * real state: dashed before the tunnel exists, blinking while waiting for the device to dial in, a solid pipe with
 * packets once online. Step 1 sends a key from the device to Telepy (Telepy learns the device key); step 3 sends one
 * back (Telepy's key goes into authorized_keys).
 */
"use client";

import React from "react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { CheckCircle2, Cpu, Hourglass, KeyRound, Laptop, Sparkles, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { WizardStep } from "@/hooks/useCreateTunnelWizard";

type WireState = "off" | "pending" | "live";
type Direction = "forward" | "backward";

interface Token {
    icon: LucideIcon;
    direction: Direction;
    label: string;
}

const PACKET_DELAYS = ["0s", "0.6s", "1.2s"];

function Chip({ children, tone = "muted", icon: Icon, title, className }: { children: React.ReactNode; tone?: "muted" | "primary" | "ok"; icon?: LucideIcon; title?: string; className?: string }) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-mono text-[10px] sm:text-[11px] animate-fade-in-up",
                className,
                tone === "muted" && "bg-muted text-foreground/80",
                tone === "primary" && "bg-primary/10 text-primary",
                tone === "ok" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
            )}
        >
            {Icon && <Icon size={10} className="shrink-0" aria-hidden />}
            <span className="truncate">{children}</span>
        </span>
    );
}

function Node({ icon: Icon, title, detail, tone, active, online, children }: {
    icon: LucideIcon;
    title: string;
    detail: string;
    tone: string;
    active: boolean;
    online?: boolean | null;
    children?: React.ReactNode;
}) {
    return (
        <div className={cn("flex min-w-0 flex-col items-center gap-1.5 text-center transition-opacity duration-500", !active && "opacity-50")}>
            <span
                className={cn(
                    "relative grid size-11 shrink-0 place-items-center rounded-2xl ring-1 ring-inset transition-all duration-500 sm:size-14",
                    tone,
                    active && "scale-105 ring-2 shadow-glow"
                )}
            >
                <Icon className="size-5 sm:size-6" aria-hidden />
                {online != null && (
                    <span className="absolute -right-1 -top-1 flex size-3.5" aria-hidden>
                        {online && <span className="absolute inline-flex size-full rounded-full bg-emerald-400 animate-status-ping" />}
                        <span className={cn("relative inline-flex size-3.5 rounded-full ring-2 ring-card", online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                    </span>
                )}
            </span>
            <span className="max-w-full truncate text-xs font-semibold text-foreground sm:text-sm" title={title}>{title}</span>
            <span className="hidden text-[11px] leading-snug text-muted-foreground sm:block">{detail}</span>
            {children && <span className="flex max-w-full flex-wrap justify-center gap-1">{children}</span>}
        </div>
    );
}

function Wire({ state, flow, label, sub, token }: { state: WireState; flow: Direction; label: string; sub?: string; token?: Token }) {
    const anim = flow === "backward" ? "animate-flow-x-rev" : "animate-flow-x";
    return (
        <div className="flex h-11 items-center px-1 sm:h-14 sm:px-3" aria-hidden>
            <div className="relative w-full">
                <span
                    className={cn(
                        "absolute bottom-full left-1/2 mb-3.5 hidden -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider sm:block",
                        state === "live" ? "text-primary" : state === "pending" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/70"
                    )}
                >
                    {label}
                </span>
                {state === "live" ? (
                    <div className="relative h-1.5 w-full rounded-full bg-primary/20 ring-1 ring-inset ring-primary/30">
                        {PACKET_DELAYS.map((delay) => (
                            <span
                                key={delay}
                                className={cn("absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow-[0_0_8px_var(--primary)]", anim)}
                                style={{ animationDelay: delay }}
                            />
                        ))}
                    </div>
                ) : (
                    <div
                        className={cn(
                            "w-full border-t-2 border-dashed",
                            state === "pending" ? "border-amber-500/70 animate-pulse" : "border-muted-foreground/25"
                        )}
                    />
                )}
                {token && (
                    // 鑰匙徽章比封包寬：留 14px 讓 flow-x 的終點不超出線尾。/ The badge is wider than a packet: keep 14px so it ends on the line.
                    <span className="pointer-events-none absolute inset-y-0 left-0 right-[14px]">
                        <span
                            className={cn(
                                "absolute top-1/2 grid size-[22px] -translate-y-1/2 place-items-center rounded-full bg-amber-400 text-amber-950 shadow-[0_0_12px_rgba(251,191,36,0.7)] opacity-0",
                                token.direction === "backward" ? "animate-flow-x-rev" : "animate-flow-x"
                            )}
                            style={{ animationDuration: "2.8s" }}
                        >
                            <token.icon size={12} strokeWidth={2.5} />
                        </span>
                    </span>
                )}
                {(sub || token) && (
                    <span className="absolute left-1/2 top-full mt-3.5 hidden -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground sm:block">
                        {token ? token.label : sub}
                    </span>
                )}
            </div>
        </div>
    );
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
    const created = reversePort !== null;
    const name = deviceName || t("wizard.diagram.yourDevice");

    const tunnelState: WireState = connected ? "live" : created && step >= 4 ? "pending" : "off";
    const tunnelToken: Token | undefined =
        step === 1 ? { icon: KeyRound, direction: "backward", label: t("wizard.diagram.deviceKey") }
        : step === 3 ? { icon: KeyRound, direction: "forward", label: t("wizard.diagram.telepyKey") }
        : undefined;
    const tunnelSub = connected
        ? (rttMs !== null ? t("wizard.diagram.rtt", { ms: Math.round(rttMs) }) : t("wizard.diagram.online"))
        : tunnelState === "pending" ? t("wizard.diagram.waiting") : undefined;

    const active = {
        you: step === 5,
        server: step !== 2,
        device: true,
    };

    let caption: string;
    let CaptionIcon: LucideIcon = Sparkles;
    let captionTone = "text-primary";
    switch (step) {
        case 1:
            caption = t("wizard.diagram.caption1");
            break;
        case 2:
            caption = t("wizard.diagram.caption2", { name });
            break;
        case 3:
            caption = t("wizard.diagram.caption3", { name });
            break;
        case 4:
            caption = connected ? t("wizard.diagram.caption4Online", { name }) : t("wizard.diagram.caption4Waiting", { name });
            if (connected) CaptionIcon = CheckCircle2;
            else {
                CaptionIcon = Hourglass;
                captionTone = "text-amber-600 dark:text-amber-400";
            }
            break;
        default:
            if (allLoginsOk) {
                caption = t("wizard.diagram.caption5Ready", { name });
                CaptionIcon = CheckCircle2;
            } else if (connected) {
                caption = t("wizard.diagram.caption5Checking", { name });
            } else {
                caption = t("wizard.diagram.caption5Offline", { name });
                CaptionIcon = Hourglass;
                captionTone = "text-amber-600 dark:text-amber-400";
            }
    }

    const shownAccounts = accounts.slice(0, 2);
    const moreAccounts = accounts.length - shownAccounts.length;

    return (
        <figure
            className="relative overflow-hidden rounded-2xl border border-border bg-muted/30 px-3 pb-4 pt-8 sm:px-6 sm:pb-5 sm:pt-10"
            aria-label={t("wizard.diagram.aria")}
        >
            {/* 淡淡的點陣底紋。/ Faint dot-grid backdrop. */}
            <span
                className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,black,transparent)]"
                aria-hidden
            />
            <div className="relative grid grid-cols-[minmax(0,1fr)_minmax(2.25rem,1.1fr)_minmax(0,1fr)_minmax(2.25rem,1.3fr)_minmax(0,1fr)] items-start">
                <Node
                    icon={Laptop}
                    title={t("wizard.diagram.you")}
                    detail={t("wizard.diagram.youDetail")}
                    tone="bg-info/12 text-info ring-info/30"
                    active={active.you}
                />
                <Wire
                    state={step === 5 && connected ? "live" : "off"}
                    flow="forward"
                    label={t("wizard.diagram.access")}
                    sub={step === 5 && connected ? t("wizard.diagram.accessDetail") : undefined}
                />
                <Node
                    icon={TelepyGlyph}
                    title="Telepy"
                    detail={t("wizard.diagram.telepyDetail")}
                    tone="bg-brand-gradient text-white ring-white/25"
                    active={active.server}
                >
                    {created && <Chip tone="primary" title={t("wizard.diagram.reservedPort")}>:{reversePort}</Chip>}
                </Node>
                <Wire state={tunnelState} flow="backward" label={t("wizard.diagram.tunnel")} sub={tunnelSub} token={tunnelToken} />
                <Node
                    icon={Cpu}
                    title={name}
                    detail={t("wizard.diagram.deviceDetail")}
                    tone="bg-primary/12 text-primary ring-primary/30"
                    active={active.device}
                    online={created ? connected : null}
                >
                    {/* 手機寬度放不下：只留帳號數，其餘 sm 以上才顯示。/ Too narrow on phones: keep an account count, the rest from sm up. */}
                    <Chip title={t("wizard.diagram.sshdPort")} className="hidden sm:inline-flex">sshd :{sshPort || "22"}</Chip>
                    {step >= 2 && accounts.length > 0 && <Chip icon={User} tone="primary" className="sm:hidden">{accounts.length}</Chip>}
                    {step >= 2 && shownAccounts.map((a) => <Chip key={a} icon={User} tone="primary" className="hidden sm:inline-flex">{a}</Chip>)}
                    {step >= 2 && moreAccounts > 0 && <Chip tone="primary" className="hidden sm:inline-flex">+{moreAccounts}</Chip>}
                    {step >= 4 && (
                        <Chip icon={KeyRound} tone={allLoginsOk ? "ok" : "muted"} title={t("wizard.diagram.keysPlaced")} className="hidden sm:inline-flex">
                            authorized_keys
                        </Chip>
                    )}
                </Node>
            </div>
            <figcaption
                className="relative mt-5 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-foreground/85 sm:text-sm"
                aria-live="polite"
            >
                <CaptionIcon size={16} className={cn("mt-0.5 shrink-0", captionTone)} aria-hidden />
                <span>{caption}</span>
            </figcaption>
        </figure>
    );
}
