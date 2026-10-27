"use client";

/**
 * 網頁終端機斷線保留的時間軸圖：連著 ─ 斷線 ─ 保留 N 秒（shell 照跑、輸出存起來）─ 接回（繼續）| 時間到（結束）| 存取被拿掉（結束），
 * 加上「是哪一層決定這個時間」（你的選擇 / 站台上限 / 這台裝置的政策）。偏好設定的 info 按鈕與終端機重連提示列的
 * 「為什麼？」都打開這個對話框。直線與直角、平面樣式，寬容器橫排、窄容器直排（PathFlow 積木）。
 * The detach timeline: connected ─ drop ─ kept for N s (still running, output saved) ─ reattach | time's up | your
 * access is removed, plus which
 * layer decided the time. Opened from the Preferences info button and the reconnect banner's "Why?" link.
 */
import React from "react";
import { Hourglass, Info, Plug, RotateCcw, ShieldOff, Square } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip, Section } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { detachTimeline, type DetachGrace, type DetachLayer, type DetachPhase, type StepState } from "@/lib/terminalDetach";
import type { SpotState } from "@/lib/flow";
import type { TranslationKey } from "@/locales/en";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** 秒數 → 「5 分鐘」這類短字串。/ Seconds as a short label. */
export function graceLabel(t: T, secs: number): string {
    if (secs <= 0) return t("detach.choice.0");
    if (secs % 3600 === 0) return t("detach.unit.h", { n: secs / 3600 });
    if (secs % 60 === 0) return t("detach.unit.min", { n: secs / 60 });
    return t("detach.unit.s", { n: secs });
}

/** 倒數的字：兩分鐘內用秒，之外用分鐘（無條件進位）。/ Countdown text: seconds under two minutes, else whole minutes. */
export function leftLabel(t: T, secs: number): string {
    return secs < 120 ? t("detach.unit.s", { n: Math.max(1, secs) }) : graceLabel(t, Math.ceil(secs / 60) * 60);
}

const SPOT: Record<StepState, SpotState> = { done: "ok", active: "active", waiting: "waiting", failed: "failed", skipped: "waiting" };

/** 結尾的兩個結果（接回 / 時間到）疊成一欄，左邊一條直線把它們接起來。/ The two outcomes stacked, joined by a straight rule. */
function Outcome({ icon: Icon, title, sub, state, t }: { icon: typeof Plug; title: string; sub: string; state: StepState; t: T }) {
    const spot = SPOT[state];
    return (
        <div
            className={cn(
                "flex items-start gap-2.5 rounded-xl border bg-card p-3",
                state === "skipped" ? "border-dashed border-border opacity-60" : spot === "ok" ? "border-success/50" : spot === "failed" ? "border-destructive/70" : spot === "active" ? "border-primary/60" : "border-border",
            )}
        >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden><Icon size={16} /></span>
            <div className="min-w-0">
                <p className="text-sm text-foreground">{title}</p>
                <p className="text-xs leading-snug text-muted-foreground">{sub}</p>
                {state === "skipped" ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("detach.state.skipped")}</p>
                ) : spot === "ok" ? (
                    <p className="mt-0.5 text-xs text-success">{t("flow.state.ok")}</p>
                ) : spot === "failed" ? (
                    <p className="mt-0.5 text-xs text-destructive">{t("detach.state.ended")}</p>
                ) : null}
            </div>
        </div>
    );
}

export function DetachTimeline({ phase, grace, left }: { phase: DetachPhase; grace: DetachGrace; left?: number | null }) {
    const { t } = useI18n();
    const steps = Object.fromEntries(detachTimeline(phase, grace.secs).map((s) => [s.id, s.state])) as Record<"connected" | "drop" | "kept" | "resume" | "end", StepState>;
    const time = graceLabel(t, grace.secs);
    const keeps = grace.secs > 0;
    const now: string =
        phase === "detached" ? t("detach.now.detached", { left: leftLabel(t, left ?? grace.secs) })
            : phase === "resumed" ? t("detach.now.resumed")
                : phase === "ended" ? t("detach.now.ended")
                    : keeps ? t("detach.now.preview", { time }) : t("detach.now.previewOff");
    return (
        <div className="space-y-4">
            <FlowNow failed={phase === "ended"}>{now}</FlowNow>
            <FlowPath stretch>
                <FlowNode
                    icon={Plug}
                    title={t("detach.node.connected")}
                    sub={t("detach.node.connectedSub")}
                    state={SPOT[steps.connected]}
                    stateText={phase === "preview" || phase === "connected" ? undefined : t("detach.state.was")}
                />
                <FlowLink label={t("detach.link.drop")} state={SPOT[steps.drop]} />
                <FlowNode
                    icon={Hourglass}
                    title={keeps ? t("detach.node.kept", { time }) : t("detach.node.notKept")}
                    sub={keeps ? t("detach.node.keptSub") : t("detach.node.notKeptSub")}
                    state={SPOT[steps.kept]}
                    stateText={steps.kept === "skipped" ? t("detach.state.skipped") : undefined}
                    className={steps.kept === "skipped" ? "border-dashed opacity-70" : undefined}
                />
                <FlowLink label={t("detach.link.then")} state={steps.kept === "done" ? "ok" : "waiting"} />
                <li className="flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3 @3xl:flex-1 @3xl:basis-0">
                    <Outcome icon={RotateCcw} title={t("detach.node.resume")} sub={t("detach.node.resumeSub")} state={steps.resume} t={t} />
                    <Outcome icon={Square} title={keeps ? t("detach.node.end") : t("detach.node.endAtOnce")} sub={keeps ? t("detach.node.endSub") : t("detach.node.endAtOnceSub")} state={steps.end} t={t} />
                    {/* 保留中也會被收掉：存取被拿掉（取消分享、帳號 / 功能被拿掉、停用、隧道改成立刻結束）。 */}
                    {/* A kept shell also ends when your access is removed. */}
                    <Outcome icon={ShieldOff} title={t("detach.node.revoked")} sub={t("detach.node.revokedSub")} state={keeps ? "waiting" : "skipped"} t={t} />
                </li>
            </FlowPath>
        </div>
    );
}

/** 三層設定一層一行，決定的那層標出來。/ One row per layer, the deciding one marked. */
function Layers({ layers }: { layers: DetachLayer[] }) {
    const { t } = useI18n();
    const value = (l: DetachLayer): string => {
        if (l.layer === "tunnel") return l.value === "never" ? t("detach.layer.tunnelNever") : l.value === "user" ? t("detach.layer.tunnelUser") : t("detach.layer.tunnelUnknown");
        const secs = typeof l.value === "number" ? l.value : 0;
        if (l.layer === "site" && secs <= 0) return t("detach.layer.siteOff");
        return graceLabel(t, secs);
    };
    const label: Record<DetachLayer["layer"], TranslationKey> = { user: "detach.layer.user", site: "detach.layer.site", tunnel: "detach.layer.tunnel" };
    return (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {layers.map((l) => (
                <li key={l.layer} className={cn("flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm", l.decides && "bg-primary/5")}>
                    <span className="text-muted-foreground">{t(label[l.layer])}</span>
                    <span className="flex items-center gap-2 text-foreground">
                        {value(l)}
                        {l.decides && <Chip tone="primary">{t("detach.decides")}</Chip>}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function DetachInfoDialog({ isOpen, onClose, phase, grace, layers, left }: { isOpen: boolean; onClose: () => void; phase: DetachPhase; grace: DetachGrace; layers: DetachLayer[]; left?: number | null }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("detach.dialogTitle")}
            description={t("detach.dialogDescription")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                <DetachTimeline phase={phase} grace={grace} left={left} />
                <Section title={t("detach.layers")} description={t("detach.layersDescription")}>
                    <Layers layers={layers} />
                </Section>
                <p className="text-sm leading-relaxed text-muted-foreground">{t("detach.notes")}</p>
            </div>
        </Modal>
    );
}
