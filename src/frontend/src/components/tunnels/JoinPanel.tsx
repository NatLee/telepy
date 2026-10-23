"use client";

/**
 * 一行指令加入裝置（#14）：選名稱與金鑰清單 → 拿到指令貼到裝置上 → 看著它註冊、連線、讓 Telepy 登入一次。
 * One-command device join: pick a name and the key list, paste the command on the device, then watch it
 * register, connect and let Telepy log in once.
 */
import React, { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Clock, ExternalLink, KeyRound, Lightbulb, Loader2, Lock, MonitorSmartphone, RotateCcw, ScrollText, ShieldCheck, Terminal, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import type { DeviceJoin, JoinPhase } from "@/hooks/useDeviceJoin";
import type { TranslationKey } from "@/locales/en";
import { CopyLine, Disclosure, FieldError, Segmented, StepFooter, StepHeading } from "./CreateWizardSteps/parts";
import { DialInRadar, type RadarState } from "@/components/tunnels/DialIn";

const ORDER: JoinPhase[] = ["waiting", "registered", "connected", "verified"];

function formatLeft(ms: number): string {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 進度列的一行：完成 / 進行中 / 尚未 / 失敗。/ One progress row. */
function ProgressRow({ state, title, detail }: { state: "done" | "active" | "todo" | "failed"; title: string; detail?: React.ReactNode }) {
    const Icon = state === "done" ? CheckCircle2 : state === "failed" ? XCircle : state === "active" ? Loader2 : Circle;
    return (
        <li className="flex gap-3">
            <Icon
                size={18}
                className={cn(
                    "mt-0.5 shrink-0",
                    state === "done" && "text-success",
                    state === "failed" && "text-destructive",
                    state === "active" && "animate-spin text-primary",
                    state === "todo" && "text-muted-foreground/40"
                )}
                aria-hidden
            />
            <div className="min-w-0">
                <p className={cn("text-sm", state === "todo" ? "text-muted-foreground" : "text-foreground")}>{title}</p>
                {detail && <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{detail}</p>}
            </div>
        </li>
    );
}

export function JoinPanel({ join }: { join: DeviceJoin }) {
    const { t } = useI18n();
    const { form, ticket, expired, msLeft, actions } = join;
    const [sudo, setSudo] = useState<"sudo" | "user">("sudo");

    if (!ticket) {
        return (
            <form
                className="space-y-6"
                onSubmit={(e) => {
                    e.preventDefault();
                    void actions.create();
                }}
            >
                <StepHeading title={t("join.title")} subtitle={t("join.subtitle")} />
                <div className="space-y-1.5">
                    <label htmlFor="join-name" className="text-sm text-foreground">{t("join.nameLabel")}</label>
                    <Input id="join-name" value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder={t("join.namePlaceholder")} maxLength={64} autoComplete="off" spellCheck={false} className="h-10 font-mono" aria-invalid={!!form.nameError || undefined} />
                    {form.nameError ? <FieldError>{form.nameError}</FieldError> : <p className="text-xs text-muted-foreground">{t("join.nameHint")}</p>}
                </div>
                {form.myKeyCount !== null && form.myKeyCount > 0 && (
                    <fieldset className="space-y-2">
                        <legend className="flex items-center gap-1.5 text-sm text-foreground">
                            <KeyRound size={14} className="text-primary" aria-hidden /> {t("wizard.device.keyListTitle")}
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {(["mine", "empty"] as const).map((v) => (
                                <label key={v} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-muted/40 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/6">
                                    <input type="radio" name="join-key-list" value={v} checked={form.keyList === v} onChange={() => form.setKeyList(v)} className="mt-0.5 size-4 accent-primary" />
                                    <span className="min-w-0">
                                        <span className="block text-sm text-foreground">{v === "mine" ? t("wizard.device.keyListMine", { n: form.myKeyCount ?? "…" }) : t("wizard.device.keyListEmpty")}</span>
                                        <span className="block text-xs leading-relaxed text-muted-foreground">{v === "mine" ? t("join.keyListMineHint") : t("wizard.device.keyListEmptyHint")}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                )}
                {form.error && <Callout tone="danger">{form.error}</Callout>}
                <StepFooter>
                    <Button type="submit" disabled={form.creating} className="">
                        {form.creating ? <Loader2 className="animate-spin" /> : <Terminal />} {t("join.create")}
                    </Button>
                </StepFooter>
            </form>
        );
    }

    const phaseIndex = ORDER.indexOf(ticket.phase);
    const failed = ticket.phase === "failed";
    // 失敗時卡在哪一步：已註冊過就是「登入」那步。/ Where a failure happened: after registration it is the login step.
    const reached = failed ? (ticket.tunnel_id ? 2 : 0) : phaseIndex;
    const rowState = (i: number): "done" | "active" | "todo" | "failed" => {
        if (failed) return i <= reached ? "done" : i === reached + 1 ? "failed" : "todo";
        if (ticket.phase === "verified") return "done";
        if (i < phaseIndex) return "done";
        if (i === phaseIndex) return expired && ticket.phase === "waiting" ? "todo" : "active";
        return "todo";
    };
    const command = sudo === "sudo" ? ticket.command : ticket.command_no_sudo;
    const device = ticket.tunnel_name ?? ticket.name ?? t("join.thisDevice");
    const hostInfo = [ticket.hostname, ticket.os].filter(Boolean).join(" · ");
    // 雷達：等裝置撥進來時掃描，連上（或驗證完）變綠。/ Radar: sweeps while waiting, turns green once connected.
    const radarState: RadarState = failed ? "failed" : ticket.phase === "connected" || ticket.phase === "verified" ? "connected" : expired ? "idle" : "waiting";

    return (
        <div className="space-y-6">
            <StepHeading title={t("join.pasteTitle")} subtitle={t("join.pasteSubtitle")} />

            {ticket.phase === "waiting" && !expired && (
                <div className="space-y-3">
                    <Segmented
                        value={sudo}
                        onChange={setSudo}
                        ariaLabel={t("join.sudoLabel")}
                        options={[
                            { value: "sudo", label: t("join.withSudo") },
                            { value: "user", label: t("join.withoutSudo") },
                        ]}
                    />
                    <CopyLine value={command} />
                    <p className="text-xs leading-relaxed text-muted-foreground">{sudo === "sudo" ? t("join.withSudoHint") : t("join.withoutSudoHint")}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5"><Clock size={13} aria-hidden /> {t("join.expiresIn", { time: formatLeft(msLeft) })}</span>
                        <a href={ticket.install_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                            <ScrollText size={13} aria-hidden /> {t("join.viewScript")} <ExternalLink size={11} aria-hidden />
                        </a>
                    </div>
                    <Disclosure title={t("join.whatItDoes")} icon={<ShieldCheck size={15} />}>
                        <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                            {(["join.does1", "join.does2", "join.does3", "join.does4", "join.does5", "join.does6"] as TranslationKey[]).map((k) => <li key={k}>{t(k)}</li>)}
                        </ol>
                    </Disclosure>
                </div>
            )}

            {expired && ticket.phase === "waiting" && <Callout tone="warning">{t("join.expired")}</Callout>}

            <div className="flex flex-col items-center gap-5 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center">
            <DialInRadar state={radarState} />
            <ol className="w-full min-w-0 flex-1 space-y-4" aria-live="polite">
                <ProgressRow state={rowState(0)} title={t("join.step.waiting")} detail={phaseIndex === 0 && !expired ? t("join.step.waitingDetail") : undefined} />
                <ProgressRow state={rowState(1)} title={t("join.step.registered", { name: device })} detail={hostInfo || undefined} />
                <ProgressRow state={rowState(2)} title={t("join.step.connected")} detail={ticket.reverse_port ? t("join.step.connectedDetail", { port: ticket.reverse_port }) : undefined} />
                <ProgressRow state={rowState(3)} title={t("join.step.verified", { user: ticket.username ?? "…" })} detail={failed ? ticket.detail ?? undefined : undefined} />
            </ol>
            </div>

            {ticket.phase === "verified" && ticket.tunnel_id && ticket.reverse_port && (
                <Callout tone="tip">{t("join.done", { name: device, user: ticket.username ?? "" })}</Callout>
            )}
            {failed && <Callout tone="danger">{t("join.failedHint")}</Callout>}

            <StepFooter>
                {ticket.phase === "waiting" && !expired && (
                    <Button variant="ghost" onClick={() => void actions.cancel()}>{t("join.cancel")}</Button>
                )}
                {(expired || failed || ticket.phase === "verified") && (
                    <Button variant="outline" onClick={actions.reset}>
                        <RotateCcw /> {ticket.phase === "verified" ? t("join.another") : t("join.newCommand")}
                    </Button>
                )}
                {ticket.tunnel_id && ticket.reverse_port && ticket.phase === "verified" && (
                    <Button asChild className="">
                        <Link href={getTerminalPageUrl({ id: ticket.tunnel_id, reverse_port: ticket.reverse_port })} prefetch={false}>
                            <Terminal /> {t("join.openTerminal")}
                        </Link>
                    </Button>
                )}
                {ticket.tunnel_id && (
                    <Button asChild variant={ticket.phase === "verified" ? "outline" : "default"}>
                        <Link href="/tunnels" prefetch={false}>{t("join.goTunnels")}</Link>
                    </Button>
                )}
            </StepFooter>
        </div>
    );
}

const WHY_POINTS: { icon: LucideIcon; text: TranslationKey }[] = [
    { icon: Lock, text: "join.why.point1" },
    { icon: ShieldCheck, text: "join.why.point2" },
    { icon: MonitorSmartphone, text: "join.why.point3" },
];

/** 一行指令模式旁的說明卡（樣式同 WhyPanel）。/ The side card for the one-command mode (same look as WhyPanel). */
export function JoinWhy() {
    const { t } = useI18n();
    return (
        <aside className="animate-fade-in-up" aria-label={t("join.why.title")}>
            <Callout
                tone="info"
                icon={<Lightbulb size={17} className="mt-0.5 shrink-0" aria-hidden />}
                title={t("join.why.title")}
                className="p-4 sm:p-5"
            >
                <p>{t("join.why.body")}</p>
                <ul className="mt-3 space-y-2.5">
                    {WHY_POINTS.map(({ icon: Icon, text }) => (
                        <li key={text} className="flex gap-2.5 text-xs leading-relaxed text-muted-foreground">
                            <Icon size={14} className="mt-0.5 shrink-0 text-info" aria-hidden />
                            <span>{t(text)}</span>
                        </li>
                    ))}
                </ul>
            </Callout>
        </aside>
    );
}
