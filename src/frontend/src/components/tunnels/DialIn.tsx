/**
 * 「等裝置撥進來」的畫面：雷達（掃描 + 往外擴散的訊號；連上時一圈綠色粒子爆開）＋ 即時時間軸。
 * 時間軸讀 gateway 事件（/api/log/ssh/events?tunnel_id=）：裝置連上 Telepy → 金鑰通過 → 反向埠開通 → 通道上線；
 * 幾個事件常在同一瞬間發生，所以打勾是一格一格錯開出現的。等太久會出現排錯清單。
 * DialInRadar 也給「一行指令」的 JoinPanel 用。
 *
 * The "waiting for the device to dial in" view: a radar (sweep + outgoing ripples; a burst of green particles on
 * connect) plus a live timeline read from the gateway events (/api/log/ssh/events?tunnel_id=): the device reaches
 * Telepy → its key is accepted → the reverse port opens → the tunnel is online. Those events often land at the same
 * instant, so the ticks are revealed one by one. After a while a troubleshooting list appears.
 * DialInRadar is also used by the one-command JoinPanel.
 */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, CircleDashed, Loader2, PartyPopper, Server, Timer, X, XCircle } from "lucide-react";
import { apiFetch, readJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { Code, CopyLine, Disclosure } from "@/components/tunnels/CreateWizardSteps/parts";

export type RadarState = "idle" | "waiting" | "connected" | "failed";

const RING: Record<RadarState, string> = {
    idle: "border-border",
    waiting: "border-warning/30",
    connected: "border-success/35",
    failed: "border-destructive/30",
};

// 雷達上會亮的光點（相對位置 %）。/ Blips that light up on the radar (relative %).
const BLIPS = [
    { x: 22, y: 30, d: "0.3s" },
    { x: 74, y: 22, d: "1.1s" },
    { x: 80, y: 66, d: "1.9s" },
    { x: 30, y: 78, d: "2.4s" },
];

const PARTICLES = ["bg-success", "bg-primary", "bg-brand-2", "bg-warning"];

export function DialInRadar({ state, className }: { state: RadarState; className?: string }) {
    const reduced = useReducedMotion();
    const burst = useRef<HTMLSpanElement>(null);

    // 連上的那一刻：粒子從中心往外爆開（Web Animations，不必動 globals.css）。
    // The moment it connects: particles burst out of the centre (Web Animations, no globals.css keyframes).
    useEffect(() => {
        if (state !== "connected" || reduced || !burst.current) return;
        const parts = Array.from(burst.current.children) as HTMLElement[];
        const anims = parts.map((p, i) => {
            const angle = (i / parts.length) * Math.PI * 2 + (i % 2) * 0.2;
            const dist = 54 + (i % 3) * 12;
            return p.animate(
                [
                    { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
                    { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0.2)`, opacity: 0 },
                ],
                { duration: 850 + (i % 4) * 140, easing: "cubic-bezier(0.15, 0.7, 0.3, 1)", fill: "forwards" },
            );
        });
        return () => anims.forEach((a) => a.cancel());
    }, [state, reduced]);

    const waiting = state === "waiting";
    return (
        <div className={cn("relative grid size-32 shrink-0 place-items-center", className)} aria-hidden>
            {/* 同心圓 / Concentric rings */}
            {["inset-0", "inset-[17%]", "inset-[34%]"].map((inset) => (
                <span key={inset} className={cn("absolute rounded-full border transition-colors duration-700", inset, RING[state])} />
            ))}
            <span className={cn("absolute inset-y-0 left-1/2 w-px transition-colors duration-700", waiting ? "bg-warning/20" : "bg-transparent")} />
            <span className={cn("absolute inset-x-0 top-1/2 h-px transition-colors duration-700", waiting ? "bg-warning/20" : "bg-transparent")} />
            {waiting && (
                <>
                    {/* 掃描光束 / Sweep beam */}
                    <span
                        className="absolute inset-0 animate-spin rounded-full [animation-duration:2.6s]"
                        style={{ background: "conic-gradient(from 0deg, transparent 0deg, rgb(245 158 11 / 0.42) 52deg, transparent 74deg)" }}
                    />
                    {/* 往外擴散的訊號 / Outgoing ripples */}
                    {["0s", "0.9s", "1.8s"].map((d) => (
                        <span key={d} className="absolute inset-[30%] rounded-full border-2 border-warning/70 animate-status-ping" style={{ animationDelay: d, animationDuration: "2.7s" }} />
                    ))}
                    {BLIPS.map((b) => (
                        <span key={b.d} className="absolute size-1.5 rounded-full bg-warning animate-pulse" style={{ left: `${b.x}%`, top: `${b.y}%`, animationDelay: b.d }} />
                    ))}
                </>
            )}
            {state === "connected" && <span className="absolute inset-[12%] rounded-full bg-success/15 animate-status-ping [animation-duration:2.4s]" />}
            <span
                className={cn(
                    "relative grid size-14 place-items-center rounded-xl text-white shadow-lg transition-all duration-500",
                    state === "connected" && "scale-110 bg-success",
                    state === "failed" && "bg-destructive",
                    waiting && "bg-warning",
                    state === "idle" && "bg-muted text-muted-foreground shadow-none"
                )}
            >
                {state === "connected" ? <Check size={28} strokeWidth={3} /> : state === "failed" ? <X size={26} strokeWidth={3} /> : <Server size={24} strokeWidth={1.75} />}
            </span>
            <span ref={burst} className="pointer-events-none absolute left-1/2 top-1/2">
                {Array.from({ length: 16 }, (_, i) => (
                    <span key={i} className={cn("absolute left-0 top-0 size-2 rounded-full opacity-0", PARTICLES[i % PARTICLES.length])} />
                ))}
            </span>
        </div>
    );
}

interface GatewayEvent {
    id: number;
    at: string;
    event: string;
    peer?: string | null;
    port?: number | null;
}

/** 輪詢這條隧道的 gateway 事件；baseline = 開始看之前最後一筆，之後的才算「這次」。/ Poll gateway events; only ids above the baseline count. */
function useTunnelEvents(tunnelId: number, connected: boolean) {
    const [events, setEvents] = useState<GatewayEvent[]>([]);
    const [baseline, setBaseline] = useState<number | null>(null);
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await apiFetch(`/api/log/ssh/events?tunnel_id=${tunnelId}&limit=30`);
                const rows = await readJson<GatewayEvent[]>(res);
                if (cancelled || !res.ok || !Array.isArray(rows)) return;
                setEvents(rows);
                setBaseline((b) => b ?? (rows.length ? rows[rows.length - 1].id : 0));
            } catch {
                /* 下一輪再試 / retry next tick */
            }
        };
        load();
        const timer = setInterval(load, connected ? 10000 : 2500);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [tunnelId, connected]);
    const fresh = baseline === null ? [] : events.filter((e) => e.id > baseline);
    const last = (kind: string) => [...fresh].reverse().find((e) => e.event === kind);
    return { accepted: last("accepted"), forward: last("forward"), refused: last("refused_forward") };
}

/** 讓「完成數」一格一格往上加（往下則立刻）。/ Reveal a growing count one step at a time (drops immediately). */
function useStaggered(target: number, ms = 420) {
    const [shown, setShown] = useState(target);
    useEffect(() => {
        if (shown === target) return;
        const timer = setTimeout(() => setShown(shown < target ? shown + 1 : target), shown < target ? ms : 0);
        return () => clearTimeout(timer);
    }, [shown, target, ms]);
    return shown;
}

function useElapsed(running: boolean) {
    const [start] = useState(() => Date.now());
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);
    return Math.max(0, Math.floor((now - start) / 1000));
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const clock = (iso: string, locale: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

type RowState = "done" | "active" | "todo" | "failed";

function TimelineRow({ state, title, detail, last }: { state: RowState; title: React.ReactNode; detail?: React.ReactNode; last?: boolean }) {
    return (
        <li className="relative flex gap-3 pb-3 last:pb-0">
            {!last && <span className={cn("absolute left-[9px] top-6 h-[calc(100%-1.25rem)] w-px transition-colors duration-500", state === "done" ? "bg-success/50" : "bg-border")} aria-hidden />}
            <span
                className={cn(
                    "relative z-10 mt-0.5 grid size-[19px] shrink-0 place-items-center rounded-full transition-all duration-300",
                    state === "done" && "scale-100 bg-success text-white",
                    state === "active" && "bg-card text-warning ring-2 ring-warning/40",
                    state === "todo" && "bg-card text-muted-foreground/50 ring-1 ring-border",
                    state === "failed" && "bg-destructive text-white"
                )}
                aria-hidden
            >
                {state === "done" ? <Check size={12} strokeWidth={3} className="animate-fade-in-up" /> : state === "active" ? <Loader2 size={12} className="animate-spin" /> : state === "failed" ? <X size={12} strokeWidth={3} /> : <CircleDashed size={12} />}
            </span>
            <div className="min-w-0">
                <p className={cn("text-sm transition-colors duration-300", state === "todo" ? "text-muted-foreground" : "text-foreground")}>{title}</p>
                {detail && <div className="text-xs leading-relaxed text-muted-foreground">{detail}</div>}
            </div>
        </li>
    );
}

const TROUBLE_AFTER_S = 45;

export function DialInMonitor({ tunnelId, name, reversePort, connected, rttMs, keyTail }: {
    tunnelId: number;
    name: string;
    reversePort: number;
    connected: boolean;
    rttMs: number | null;
    /** 步驟 1 那把裝置金鑰的指紋尾碼，排錯時比對用。/ Tail of the step-1 device key, for troubleshooting. */
    keyTail?: string;
}) {
    const { t, tn, locale } = useI18n();
    const ev = useTunnelEvents(tunnelId, connected);
    const elapsed = useElapsed(!connected);
    const [server, setServer] = useState<{ host: string; port: string } | null>(null);

    useEffect(() => {
        let cancelled = false;
        apiFetch(`/tunnels/server/config/${tunnelId}`)
            .then((res) => (res.ok ? readJson<{ server?: { host?: string; port?: string | number } }>(res) : null))
            .then((data) => {
                if (!cancelled && data?.server?.host) setServer({ host: data.server.host, port: String(data.server.port ?? "") });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [tunnelId]);

    const reached = connected || !!ev.accepted;
    const forwarded = connected || !!ev.forward;
    const refused = !connected && !!ev.refused;
    // 依序完成的格數（錯開顯示）。/ How many rows are done in order (revealed one by one).
    const target = connected ? 4 : forwarded ? 3 : reached ? 2 : 0;
    const shown = useStaggered(target);
    const rowState = (i: number): RowState => {
        if (i < shown) return "done";
        if (refused && i === 2) return "failed";
        if (i === shown && !connected) return "active";
        return i === shown && connected ? "active" : "todo";
    };
    const radar: "waiting" | "connected" | "failed" = connected && shown >= 4 ? "connected" : refused ? "failed" : "waiting";
    const at = (e?: GatewayEvent) => (e ? clock(e.at, locale) : undefined);
    const gateway = server ? `${server.host}:${server.port}` : "Telepy";

    return (
        <div
            role="status"
            className={cn(
                "relative overflow-hidden rounded-xl border p-4 transition-colors duration-700 sm:p-5",
                radar === "connected" ? "border-success/35 bg-success/[0.10]"
                    : radar === "failed" ? "border-destructive/35 bg-destructive/[0.05]"
                    : "border-warning/30 bg-warning/[0.08]"
            )}
        >
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
                <DialInRadar state={radar} />
                <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0" aria-live="polite">
                            <p className="flex items-center gap-2 text-base text-foreground">
                                {radar === "connected" && <PartyPopper size={18} className="text-success" aria-hidden />}
                                {radar === "connected" ? t("wizard.dial.online", { name }) : t("wizard.dial.waiting", { name })}
                            </p>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                {radar === "connected"
                                    ? t(rttMs !== null ? "wizard.dial.onlineDetailRtt" : "wizard.dial.onlineDetail", { port: reversePort, ms: rttMs !== null ? Math.round(rttMs) : 0 })
                                    : t("wizard.dial.waitingDetail")}
                            </p>
                        </div>
                        {!connected && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-card px-2.5 py-1 font-mono text-xs tabular-nums text-foreground/80" title={t("wizard.dial.elapsed")}>
                                <Timer size={13} aria-hidden /> {mmss(elapsed)}
                            </span>
                        )}
                    </div>
                    <ol className="rounded-xl border border-border/70 bg-card/70 p-3">
                        <TimelineRow
                            state={rowState(0)}
                            title={t("wizard.dial.row.reach", { gateway })}
                            detail={ev.accepted?.peer ? t("wizard.dial.row.reachFrom", { peer: ev.accepted.peer.replace(/:\d+$/, ""), time: at(ev.accepted) ?? "" }) : rowState(0) === "active" ? t("wizard.dial.row.reachWaiting") : undefined}
                        />
                        <TimelineRow state={rowState(1)} title={t("wizard.dial.row.key")} detail={keyTail && rowState(1) === "done" ? <span className="font-mono">…{keyTail}</span> : undefined} />
                        <TimelineRow
                            state={rowState(2)}
                            title={t("wizard.dial.row.forward", { port: reversePort })}
                            detail={refused ? t("wizard.dial.row.forwardRefused") : at(ev.forward)}
                        />
                        <TimelineRow state={rowState(3)} title={t("wizard.dial.row.live")} detail={rowState(3) === "done" && rttMs !== null ? t("wizard.scene.tunnelLiveRtt", { ms: Math.round(rttMs) }) : undefined} last />
                    </ol>
                </div>
            </div>

            {!connected && (elapsed >= TROUBLE_AFTER_S || refused) && (
                <div className="mt-4 animate-fade-in-up">
                    <Disclosure title={t("wizard.dial.troubleTitle")} icon={<XCircle size={15} />} defaultOpen={refused}>
                        <ul className="space-y-3 text-xs leading-relaxed text-muted-foreground">
                            <li>{t("wizard.dial.trouble.running")}</li>
                            <li className="space-y-1.5">
                                <span>{t("wizard.dial.trouble.reach")}</span>
                                {server && <CopyLine value={`nc -vz ${server.host} ${server.port}`} />}
                            </li>
                            {keyTail && <li>{tn("wizard.dial.trouble.key", { cmd: <Code>cat ~/.ssh/*.pub</Code>, tail: <Code>…{keyTail}</Code> })}</li>}
                            <li>{t("wizard.dial.trouble.network", { port: server?.port ?? "" })}</li>
                        </ul>
                    </Disclosure>
                </div>
            )}
        </div>
    );
}
