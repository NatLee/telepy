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
import { Chip } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { TunnelNameHelp } from "@/components/tunnels/TunnelNameHelp";
import { JoinScriptFlow } from "@/components/tunnels/JoinScriptFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { compatNoServerAlive, factChips, joinCommands } from "@/lib/joinScript";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import type { DeviceJoin, JoinPhase } from "@/hooks/useDeviceJoin";
import type { TranslationKey } from "@/locales/en";
import { CopyLine, Disclosure, Segmented, StepFooter, StepHeading } from "./CreateWizardSteps/parts";
import { DialInRadar, type RadarState } from "@/components/tunnels/DialIn";
import { TransportVisibility } from "@/components/tunnels/TransportVisibility";

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
    // 貼進 shell（一般）或先下載、檢查語法再執行（路由器 / 序列埠主控台貼上會掉字）。/ Pipe, or download + check + run.
    const [how, setHow] = useState<"pipe" | "download">("pipe");

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
                    <Input id="join-name" value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder={t("join.namePlaceholder")} maxLength={63} autoComplete="off" spellCheck={false} className="h-10 font-mono" aria-invalid={!!form.nameError || undefined} aria-describedby="join-name-help" />
                    {/* 空 = 用裝置的主機名稱；規則同建立隧道。/ Empty = the device's hostname; the same rules as creating a tunnel. */}
                    <TunnelNameHelp id="join-name-help" value={form.name} error={form.nameError} onUse={form.setName} rulesKey="tunnelName.rulesJoin" />
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
                <fieldset className="space-y-2">
                    <legend className="text-sm text-foreground">{t("join.transportLabel")}</legend>
                    <Segmented
                        value={form.transport}
                        onChange={form.setTransport}
                        ariaLabel={t("join.transportLabel")}
                        options={[
                            { value: "auto", label: t("join.transportAuto") },
                            { value: "ssh", label: t("join.transportSsh") },
                            { value: "websocket", label: t("join.transportWeb") },
                        ]}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">{t(form.transport === "websocket" ? "join.transportWebHint" : form.transport === "auto" ? "join.transportAutoHint" : "join.transportSshHint")}</p>
                    <TransportVisibility selected={form.transport} />
                </fieldset>
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
    const commands = joinCommands(ticket.install_url, ticket.token, { sudo: sudo === "sudo", transport: ticket.transport });
    const command = how === "pipe" ? (sudo === "sudo" ? ticket.command : ticket.command_no_sudo) : commands.download;
    const device = ticket.tunnel_name ?? ticket.name ?? t("join.thisDevice");
    const hostInfo = [ticket.hostname, ticket.os].filter(Boolean).join(" · ");
    const chips = factChips(ticket.facts);
    const compat = compatNoServerAlive(ticket.facts);
    // 雷達：等裝置撥進來時掃描，連上（或驗證完）變綠。/ Radar: sweeps while waiting, turns green once connected.
    const radarState: RadarState = failed ? "failed" : ticket.phase === "connected" || ticket.phase === "verified" ? "connected" : expired ? "idle" : "waiting";

    return (
        <div className="space-y-6">
            <StepHeading title={t("join.pasteTitle")} subtitle={t("join.pasteSubtitle")} />

            {ticket.phase === "waiting" && !expired && (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Segmented
                            value={sudo}
                            onChange={setSudo}
                            ariaLabel={t("join.sudoLabel")}
                            options={[
                                { value: "sudo", label: t("join.withSudo") },
                                { value: "user", label: t("join.withoutSudo") },
                            ]}
                        />
                        <Segmented
                            value={how}
                            onChange={setHow}
                            ariaLabel={t("join.howLabel")}
                            options={[
                                { value: "pipe", label: t("join.howPipe") },
                                { value: "download", label: t("join.howDownload") },
                            ]}
                        />
                    </div>
                    <CopyLine value={command} />
                    {how === "download" && (
                        <>
                            <p className="text-xs leading-relaxed text-muted-foreground">{t("join.howDownloadHint")}</p>
                            <p className="text-xs text-muted-foreground">{t("join.wgetLabel")}</p>
                            <CopyLine value={commands.wget} />
                        </>
                    )}
                    <p className="text-xs leading-relaxed text-muted-foreground">{sudo === "sudo" ? t("join.withSudoHint") : t("join.withoutSudoHint")}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5"><Clock size={13} aria-hidden /> {t("join.expiresIn", { time: formatLeft(msLeft) })}</span>
                        <a href={ticket.install_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                            <ScrollText size={13} aria-hidden /> {t("join.viewScript")} <ExternalLink size={11} aria-hidden />
                        </a>
                    </div>
                    <Disclosure title={t("join.checkTitle")} icon={<ShieldCheck size={15} />}>
                        <div className="space-y-2">
                            <p className="text-xs leading-relaxed text-muted-foreground">{t("join.checkBody")}</p>
                            <CopyLine value={commands.check} />
                            <CopyLine value={commands.checkWget} />
                        </div>
                    </Disclosure>
                </div>
            )}

            {expired && ticket.phase === "waiting" && <Callout tone="warning">{t("join.expired")}</Callout>}

            {/* 指令在裝置上做什麼：七步流程圖，照階段亮起。/ What the command does on the device: seven steps, lit by the phase. */}
            <Disclosure title={t("join.whatItDoes")} icon={<ShieldCheck size={15} />} defaultOpen>
                <JoinScriptFlow phase={ticket.phase} hasTunnel={!!ticket.tunnel_id} expired={expired} account={ticket.username} deviceName={ticket.tunnel_name ?? ticket.name} />
                {ticket.transport !== "ssh" && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(ticket.transport === "auto" ? "join.doesAuto" : "join.doesWeb")}</p>}
            </Disclosure>

            <div className="flex flex-col items-center gap-5 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center">
            <DialInRadar state={radarState} />
            <ol className="w-full min-w-0 flex-1 space-y-4" aria-live="polite">
                <ProgressRow state={rowState(0)} title={t("join.step.waiting")} detail={phaseIndex === 0 && !expired ? t("join.step.waitingDetail") : undefined} />
                <ProgressRow
                    state={rowState(1)}
                    title={t("join.step.registered", { name: device })}
                    detail={
                        hostInfo || chips.length > 0 ? (
                            <span className="flex flex-wrap items-center gap-1">
                                {hostInfo && <span>{hostInfo}</span>}
                                {chips.map((c) => (
                                    <Chip key={c.key} title={t(c.label)}>{c.text ? t(c.text.key, c.text.vars) : c.value}</Chip>
                                ))}
                            </span>
                        ) : undefined
                    }
                />
                <ProgressRow state={rowState(2)} title={t("join.step.connected")} detail={ticket.reverse_port ? t("join.step.connectedDetail", { port: ticket.reverse_port }) : undefined} />
                <ProgressRow state={rowState(3)} title={t("join.step.verified", { user: ticket.username ?? "…" })} detail={failed ? ticket.detail ?? undefined : undefined} />
            </ol>
            </div>

            {compat && <Callout tone="warning" title={t("join.compatTitle")}>{t("join.compatBody")}</Callout>}

            {ticket.phase === "verified" && ticket.tunnel_id && ticket.reverse_port && (
                <Callout tone="tip">{t("join.done", { name: device, user: ticket.username ?? "" })}</Callout>
            )}
            {ticket.same_machine_as && ticket.phase !== "waiting" && (
                <Callout tone="warning" title={t("join.sameMachineTitle", { name: ticket.same_machine_as.name })}>{t("join.sameMachine", { name: ticket.same_machine_as.name })}</Callout>
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
