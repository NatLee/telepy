"use client";

/**
 * 第一次使用的設定（對話框）：照相依順序的四步清單——登記金鑰 → 裝置在線 → 金鑰裝到裝置 → ~/.ssh/config。
 * 上方進度條一眼看出還差幾步；第一個沒完成的步驟自動展開並加框標成「下一步」，完成的收成一行摘要，
 * 做完一步就自動跳到下一步。~/.ssh/config 那步用共用的 SshConfigInstall：一行指令寫進去，或手動貼上逐行註解的兩段。
 * First-time setup (dialog): a four-step checklist in dependency order — register a key → device online → key on
 * the device → ~/.ssh/config. A progress bar shows what's left; the first unfinished step opens by itself and is
 * framed as "next", finished steps collapse to a one-line summary, and finishing a step moves on to the next.
 * The ~/.ssh/config step uses the shared SshConfigInstall: one command writes it, or paste the two annotated blocks.
 */
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, CircleAlert, Clock3, KeyRound, ListChecks, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { MiniCommand } from "@/components/cheatsheet/CommandView";
import { TargetChip } from "@/components/keys/TargetChips";
import { SshConfigInstall } from "@/components/sshconfig/SshConfigInstall";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ConnectMode } from "@/lib/forwardRecipes";
import { parseStanzas, type ConfigStanza } from "@/lib/sshConfig";
import type { SetupChecklist, SetupStepId, SetupStepState } from "@/hooks/useSetupChecklist";

/** 裝置區塊都經 ProxyCommand 跳過伺服器區塊。/ Device stanzas hop through the server one via ProxyCommand. */
const isDevice = (s: ConfigStanza) => s.options.some((o) => o.key.toLowerCase() === "proxycommand");

function StepBadge({ n, state, current }: { n: number; state: SetupStepState; current: boolean }) {
    const base = "grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold";
    if (state === "done") {
        return (
            <span className={cn(base, "bg-success text-success-foreground")}>
                <Check size={15} strokeWidth={3} aria-hidden />
            </span>
        );
    }
    if (state === "working") return <span className={cn(base, "bg-warning/12 text-warning ring-1 ring-inset ring-warning/35")}><Clock3 size={15} aria-hidden /></span>;
    if (state === "error") return <span className={cn(base, "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/30")}><CircleAlert size={15} aria-hidden /></span>;
    if (current) return <span className={cn(base, "bg-primary text-primary-foreground")}>{n}</span>;
    return <span className={cn(base, "bg-muted text-muted-foreground ring-1 ring-inset ring-border")}>{n}</span>;
}

function StateChip({ state, current }: { state: SetupStepState; current: boolean }) {
    const { t } = useI18n();
    if (state === "todo" && current) {
        return <span className="shrink-0 rounded-sm bg-primary px-1.5 py-px text-[0.75rem] text-primary-foreground">{t("sheet.setup.nextUp")}</span>;
    }
    const style: Record<SetupStepState, string> = {
        done: "bg-success/10 text-success",
        todo: "bg-muted text-muted-foreground",
        working: "bg-warning/12 text-warning",
        error: "bg-destructive/10 text-destructive",
        loading: "bg-muted text-muted-foreground",
    };
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-px text-[0.75rem]", style[state])}>
            {state === "loading" && <Loader2 size={11} className="animate-spin" aria-hidden />}
            {t(`sheet.setup.state.${state}`)}
        </span>
    );
}

interface StepCardProps {
    n: number;
    state: SetupStepState;
    current: boolean;
    open: boolean;
    onToggle: () => void;
    title: React.ReactNode;
    summary: React.ReactNode;
    children: React.ReactNode;
}

function StepCard({ n, state, current, open, onToggle, title, summary, children }: StepCardProps) {
    const bodyId = `setup-step-${n}`;
    const ref = useRef<HTMLLIElement>(null);
    // 使用者打開的那一步捲進視野（內容可能在對話框下緣之外）。/ Bring a step the user opens into view.
    const toggle = () => {
        onToggle();
        if (!open) requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    };
    return (
        <li
            ref={ref}
            className={cn(
                "scroll-my-4 rounded-xl transition-[background-color,box-shadow]",
                current
                    ? "bg-primary/[0.04] shadow-card ring-2 ring-primary/45"
                    : state === "done"
                      ? "bg-surface/60 ring-1 ring-border/70"
                      : "bg-card ring-1 ring-border"
            )}
        >
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={bodyId}
                className="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:px-4"
            >
                <StepBadge n={n} state={state} current={current} />
                <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm", state === "done" && !current ? "text-foreground/80" : "text-foreground")}>{title}</span>
                    {!open && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>}
                </span>
                <StateChip state={state} current={current} />
                <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            {open && (
                <div id={bodyId} className="space-y-3 px-3.5 pb-4 text-sm leading-relaxed text-muted-foreground sm:pl-14 sm:pr-4">
                    {children}
                </div>
            )}
        </li>
    );
}

interface SetupGuideProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number;
    alias: string;
    /** 目前的目標帳號（沒有時 null）。/ The selected target account, if any. */
    username: string | null;
    online: boolean;
    mode: ConnectMode;
    setMode: (m: ConnectMode) => void;
    configText: string | null;
    checklist: SetupChecklist;
}

export function SetupGuide({ isOpen, onClose, tunnelId, alias, username, online, mode, setMode, configText, checklist }: SetupGuideProps) {
    const { t, tn } = useI18n();
    const { steps, done, total, current } = checklist;
    const allDone = current === null;
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    const stateOf = (id: SetupStepId) => steps.find((s) => s.id === id)!.state;

    // 預設展開「下一步」；使用者點開別的就照他的，直到那一步完成或重新打開對話框。
    // The "next" step is open by default; a step the user opens stays open until it completes or the dialog reopens.
    const [picked, setPicked] = useState<SetupStepId | "none" | null>(null);
    useEffect(() => {
        if (isOpen) setPicked(null);
    }, [isOpen]);
    // 使用者點開的那一步剛完成 → 回到跟著「下一步」走。/ The step the user opened just finished → follow "next" again.
    const pickedStep = picked && picked !== "none" ? picked : null;
    const pickedState = pickedStep ? stateOf(pickedStep) : null;
    const prevPicked = useRef<{ id: SetupStepId | null; state: SetupStepState | null }>({ id: null, state: null });
    useEffect(() => {
        const prev = prevPicked.current;
        if (pickedStep && prev.id === pickedStep && prev.state !== "done" && pickedState === "done") setPicked(null);
        prevPicked.current = { id: pickedStep, state: pickedState };
    }, [pickedStep, pickedState]);
    const openId = picked === "none" ? null : (picked ?? current);
    const toggle = (id: SetupStepId) => setPicked(openId === id ? "none" : id);

    const titles: Record<SetupStepId, React.ReactNode> = {
        key: t("sheet.setup.keyTitle"),
        online: t("sheet.setup.deviceTitle"),
        deviceKey: t("sheet.setup.deviceKeyTitle"),
        config: tn("sheet.setup.configTitle", { alias: code(alias) }),
    };

    const keyStep = () => {
        const count = checklist.keys ?? 0;
        return {
            summary: stateOf("key") === "done" ? t("sheet.setup.keyDone", { count }) : t("sheet.setup.keyTodoSummary"),
            body:
                stateOf("key") === "done" ? (
                    <>
                        <p>{t("sheet.setup.keyDone", { count })}</p>
                        <p className="text-xs">
                            {t("sheet.setup.keyAnother")}{" "}
                            <Link href="/tunnels/keys" prefetch={false} className="text-primary underline-offset-4 hover:underline">{t("sheet.setup.keysLink")}</Link>
                        </p>
                    </>
                ) : (
                    <>
                        <p>{t("sheet.setup.keyWhy")}</p>
                        <MiniCommand command="cat ~/.ssh/id_ed25519.pub" />
                        <p className="text-xs">{tn("sheet.setup.keyGen", { cmd: code("ssh-keygen -t ed25519") })}</p>
                        <Button asChild size="sm">
                            <Link href="/tunnels/keys" prefetch={false}><KeyRound size={15} />{t("sheet.setup.keyAction")}</Link>
                        </Button>
                    </>
                ),
        };
    };

    const onlineStep = () => ({
        summary: online ? t("sheet.setup.onlineSummary", { alias }) : t("sheet.setup.offlineSummary", { alias }),
        body: online ? (
            <p>{t("sheet.setup.onlineBody", { alias })}</p>
        ) : (
            <>
                <p>{t("sheet.setup.offlineBody", { alias })}</p>
                <p className="flex items-center gap-2 text-xs">
                    <span className="relative flex size-2" aria-hidden>
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning/60" />
                        <span className="relative inline-flex size-2 rounded-full bg-warning" />
                    </span>
                    {t("sheet.setup.waitingOnline")}
                </p>
                <Button asChild size="sm" variant="outline">
                    <Link href="/tunnels" prefetch={false}>{t("sheet.setup.openTunnels")}</Link>
                </Button>
            </>
        ),
    });

    const deviceKeyStep = () => {
        const state = stateOf("deviceKey");
        const manage = (
            <Link href={`/tunnels/keys?device=${tunnelId}`} prefetch={false} className="text-xs text-primary underline-offset-4 hover:underline">
                {t("sheet.setup.manageKeys")}
            </Link>
        );
        const summary =
            state === "done" ? t("sheet.setup.deviceKeyDoneSummary", { user: username ?? "" })
            : state === "working" ? (online ? t("sheet.setup.deviceKeyWorkingSummary") : t("sheet.setup.deviceKeyWaitingSummary"))
            : state === "error" ? t("sheet.setup.deviceKeyErrorSummary")
            : state === "loading" ? t("sheet.setup.state.loading")
            : t("sheet.setup.deviceKeyTodoSummary");

        let body: React.ReactNode;
        if ((checklist.keys ?? 0) === 0) {
            body = <p>{t("sheet.setup.deviceKeyNeedKey")}</p>;
        } else if (!username || !checklist.allowed) {
            body = <p>{t(checklist.role === "owner" || checklist.role === "admin" ? "keys.matrix.noAccountsOwner" : "keys.matrix.noAccountsSharee")}</p>;
        } else {
            body = (
                <>
                    <p>{tn("sheet.setup.deviceKeyWhy", { user: code(username), alias: code(alias), path: code("~/.ssh/authorized_keys") })}</p>
                    {checklist.deviceKeysLoaded && (
                        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
                            {checklist.myKeys.map((k) => {
                                const target = checklist.keyTargets.get(k.id) ?? null;
                                return (
                                    <li key={k.id} className="flex items-center gap-2.5 px-3 py-2">
                                        <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-foreground">{k.name}</span>
                                            {k.fingerprint && <span className="block truncate font-mono text-[0.75rem] text-muted-foreground">{k.fingerprint}</span>}
                                        </span>
                                        {target ? (
                                            <TargetChip target={target} online={online} />
                                        ) : (
                                            <span className="shrink-0 text-[0.75rem] text-muted-foreground">{t("sheet.setup.notOnDevice")}</span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {state === "working" && <p className="text-xs">{online ? t("sheet.setup.deviceKeyWorking") : t("sheet.setup.deviceKeyWaiting")}</p>}
                    {state === "error" && <p className="text-xs text-destructive">{t("sheet.setup.deviceKeyError")}</p>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        {checklist.missingKeyIds.length > 0 && (
                            <Button size="sm" variant={state === "done" ? "outline" : "default"} onClick={() => checklist.addKeys()} disabled={checklist.busy !== null}>
                                {checklist.busy === "all" ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                                {t("sheet.setup.deviceKeyAdd", { alias, count: checklist.missingKeyIds.length })}
                            </Button>
                        )}
                        {manage}
                    </div>
                </>
            );
        }
        return { summary, body };
    };

    const configStep = () => {
        const isDone = stateOf("config") === "done";
        const stanzas = configText ? parseStanzas(configText) : [];
        if (mode === "direct") {
            return {
                summary: t("sheet.setup.directSummary"),
                body: (
                    <>
                        <p>{t("sheet.setup.directOn")}</p>
                        <Button size="sm" variant="outline" onClick={() => setMode("alias")}>{t("sheet.setup.useShort")}</Button>
                    </>
                ),
            };
        }
        return {
            summary: isDone ? t("sheet.setup.configDoneSummary") : t("sheet.setup.configTodoSummary"),
            body: (
                <>
                    <p>{tn("sheet.setup.configBody", { path: code("~/.ssh/config"), cmd: code(`ssh ${alias}`) })}</p>
                    {configText && (
                        <SshConfigInstall
                            serverStanza={stanzas.find((st) => !isDevice(st)) ?? null}
                            deviceStanzas={stanzas.filter(isDevice)}
                            active={null}
                            onActive={() => {}}
                        />
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 pt-3">
                        {isDone ? (
                            <Button size="sm" variant="outline" onClick={() => checklist.markConfig(false)} disabled={!username}>
                                {t("sheet.setup.configUnmark")}
                            </Button>
                        ) : (
                            <Button size="sm" onClick={() => checklist.markConfig(true)} disabled={!username}>
                                <Check size={15} />{t("sheet.setup.configMark")}
                            </Button>
                        )}
                        <span className="text-xs">{t("sheet.setup.configCantCheck")}</span>
                    </div>
                    <p className="flex flex-wrap items-center gap-2 text-xs">
                        {t("sheet.setup.skipConfig")}
                        <Button size="xs" variant="outline" onClick={() => setMode("direct")}>{t("sheet.setup.useDirect")}</Button>
                    </p>
                </>
            ),
        };
    };

    const content: Record<SetupStepId, () => { summary: React.ReactNode; body: React.ReactNode }> = {
        key: keyStep,
        online: onlineStep,
        deviceKey: deviceKeyStep,
        config: configStep,
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("sheet.setup.title")}
            description={t("sheet.setup.subtitle")}
            icon={<ListChecks />}
            size="2xl"
            footer={
                <Button variant={allDone ? "default" : "outline"} onClick={onClose}>
                    {allDone ? t("sheet.setup.start") : t("common.close")}
                </Button>
            }
        >
            {/* 進度：每格一步，點了就展開那一步。/ Progress: one segment per step; click to open it. */}
            <div className="mb-4">
                <div className="flex items-center justify-between gap-3 text-xs">
                    <span className={allDone ? "text-success" : "text-muted-foreground"}>
                        {allDone ? t("sheet.setup.allDone") : t("sheet.setup.progress", { done, total })}
                    </span>
                </div>
                <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
                    {steps.map((s, i) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => setPicked(s.id)}
                            aria-label={t("sheet.setup.goToStep", { n: i + 1 })}
                            className={cn(
                                "h-1.5 rounded-full transition-colors",
                                // 完成 = 實心綠；下一步 = 淡色加脈動，跟完成分得開。/ Done = solid; next = faint + pulse, so the two never look alike.
                                s.state === "done" ? "bg-success" : s.id === current ? "animate-pulse bg-primary/35" : s.state === "working" ? "bg-warning/60" : s.state === "error" ? "bg-destructive/60" : "bg-muted"
                            )}
                        />
                    ))}
                </div>
            </div>

            <ol className="list-none space-y-2.5">
                {steps.map((s, i) => {
                    const c = content[s.id]();
                    return (
                        <StepCard
                            key={s.id}
                            n={i + 1}
                            state={s.state}
                            current={s.id === current}
                            open={openId === s.id}
                            onToggle={() => toggle(s.id)}
                            title={titles[s.id]}
                            summary={c.summary}
                        >
                            {c.body}
                        </StepCard>
                    );
                })}
            </ol>
        </Modal>
    );
}
