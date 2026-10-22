/**
 * 建立精靈 Step 4：選一種在裝置上啟動通道的方式，拿到一次性指令（curl | bash），並即時看裝置有沒有撥進來。
 * Wizard step 4: pick how the device starts the tunnel, get a one-time command (curl | bash), and watch the device
 * dial in live.
 */
"use client";

import React from "react";
import { CheckCircle2, ChevronRight, Container, Cpu, FileCode, FileText, Loader2, Monitor, Power, RefreshCw, TerminalSquare, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { METHOD_LANGUAGE, type ConnectMethod } from "@/lib/tunnelSetup";
import type { TranslationKey } from "@/locales/en";
import type { CreateTunnelWizard } from "@/hooks/useCreateTunnelWizard";
import { Disclosure, StepFooter, StepHeading } from "./parts";

const METHODS: { id: ConnectMethod; icon: LucideIcon; title: TranslationKey; desc: TranslationKey; tag?: TranslationKey }[] = [
    { id: "autossh-service", icon: Power, title: "wizard.connect.service", desc: "wizard.connect.serviceDesc", tag: "wizard.connect.recommended" },
    { id: "autossh", icon: RefreshCw, title: "wizard.connect.autossh", desc: "wizard.connect.autosshDesc" },
    { id: "ssh", icon: TerminalSquare, title: "wizard.connect.ssh", desc: "wizard.connect.sshDesc", tag: "wizard.connect.testOnly" },
    { id: "docker-run", icon: Container, title: "wizard.connect.docker", desc: "wizard.connect.dockerDesc" },
    { id: "docker-compose", icon: FileCode, title: "wizard.connect.compose", desc: "wizard.connect.composeDesc" },
    { id: "powershell", icon: Monitor, title: "wizard.connect.windows", desc: "wizard.connect.windowsDesc" },
];

function LiveStatus({ name, connected, reversePort, rttMs }: { name: string; connected: boolean; reversePort: number; rttMs: number | null }) {
    const { t } = useI18n();
    return (
        <div
            role="status"
            aria-live="polite"
            className={cn(
                "flex items-center gap-4 rounded-2xl border p-4 transition-colors duration-500 sm:p-5",
                connected ? "border-emerald-500/30 bg-emerald-500/[0.07]" : "border-amber-500/30 bg-amber-500/[0.06]"
            )}
        >
            <span className="relative grid size-12 shrink-0 place-items-center" aria-hidden>
                {!connected && (
                    <>
                        <span className="absolute inset-0 rounded-full bg-amber-400/40 animate-status-ping" />
                        <span className="absolute inset-0 rounded-full bg-amber-400/30 animate-status-ping [animation-delay:1.1s]" />
                    </>
                )}
                <span className={cn("relative grid size-12 place-items-center rounded-full text-white", connected ? "bg-emerald-500 shadow-[0_0_24px_rgba(16,185,129,0.45)]" : "bg-amber-500")}>
                    {connected ? <CheckCircle2 size={24} /> : <Cpu size={22} />}
                </span>
            </span>
            <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                    {connected ? t("wizard.connect.online", { name }) : t("wizard.connect.waiting", { name })}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {connected
                        ? t(rttMs !== null ? "wizard.connect.onlineDetailRtt" : "wizard.connect.onlineDetail", { port: reversePort, ms: rttMs !== null ? Math.round(rttMs) : 0 })
                        : t("wizard.connect.waitingDetail")}
                </p>
            </div>
        </div>
    );
}

export function StepConnect({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t } = useI18n();
    const c = wizard.connect;
    const created = wizard.created!;
    const accounts = wizard.accounts.list;
    const current = METHODS.find((m) => m.id === c.method)!;

    return (
        <div className="space-y-6">
            <StepHeading title={t("wizard.connect.title")} subtitle={t("wizard.connect.subtitle", { name: created.name })} />

            <div role="radiogroup" aria-label={t("wizard.connect.methodAria")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {METHODS.map(({ id, icon: Icon, title, tag }) => {
                    const selected = id === c.method;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => c.setMethod(id)}
                            className={cn(
                                "group relative flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-all duration-200 sm:p-3",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                selected ? "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30" : "border-border bg-background/60 hover:-translate-y-px hover:border-primary/30"
                            )}
                        >
                            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg transition-colors", selected ? "bg-brand-gradient text-white" : "bg-muted text-muted-foreground group-hover:text-primary")} aria-hidden>
                                <Icon size={16} />
                            </span>
                            <span className="min-w-0 text-sm font-medium leading-tight text-foreground">{t(title)}</span>
                            {tag && (
                                <span className={cn(
                                    "absolute -top-2 right-2 rounded-full px-1.5 py-px text-[0.6875rem] font-semibold",
                                    id === "autossh-service" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground ring-1 ring-border"
                                )}>
                                    {t(tag)}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="space-y-4 rounded-2xl border border-border bg-muted/20 p-4">
                <p className="text-sm leading-relaxed text-foreground/85">{t(current.desc)}</p>

                <div className="flex flex-wrap items-end gap-4">
                    <label className="space-y-1">
                        <span className="block text-xs font-medium text-foreground">{t("wizard.device.port")}</span>
                        <Input
                            inputMode="numeric"
                            value={c.sshPort}
                            onChange={(e) => c.onPortChange(e.target.value)}
                            className="h-9 w-24 font-mono"
                            aria-label={t("wizard.device.port")}
                        />
                    </label>
                    {c.needsAccount && accounts.length > 0 && (
                        <div className="min-w-[10rem] space-y-1">
                            <span className="block text-xs font-medium text-foreground">{t("wizard.connect.runAs")}</span>
                            <Select value={c.serviceAccountId !== null ? String(c.serviceAccountId) : undefined} onValueChange={(v) => c.setServiceAccountId(Number(v))}>
                                <SelectTrigger className="h-9 w-full font-mono" aria-label={t("wizard.connect.runAs")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)} className="font-mono">{a.username}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>

                {c.needsAccount && accounts.length === 0 ? (
                    <p className="rounded-xl border border-amber-500/35 bg-amber-500/[0.07] p-3 text-sm text-amber-800 dark:text-amber-200">
                        {t("wizard.connect.needsAccount")}{" "}
                        <button type="button" onClick={() => wizard.goTo(2)} className="font-medium underline underline-offset-2">{t("wizard.connect.addAccount")}</button>
                    </p>
                ) : (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("wizard.connect.pasteOnDevice")}</span>
                            <Button type="button" variant="ghost" size="xs" onClick={c.generateOneTime} disabled={!c.scriptReady || c.oneTime?.loading}>
                                <RefreshCw className={cn(c.oneTime?.loading && "animate-spin")} /> {t("wizard.connect.newLink")}
                            </Button>
                        </div>
                        {c.oneTime?.command ? (
                            <CodeBlock language={c.method === "powershell" ? "powershell" : "bash"} value={c.oneTime.command} />
                        ) : c.oneTime?.error ? (
                            <p className="rounded-xl border border-destructive/40 bg-destructive/[0.07] p-3 text-sm text-destructive">{c.oneTime.error}</p>
                        ) : (
                            <div className="flex h-[88px] items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                                <Loader2 size={18} className="animate-spin" aria-label={t("common.loading")} />
                            </div>
                        )}
                        <p className="text-[0.75rem] leading-relaxed text-muted-foreground">{t("wizard.connect.linkHint")}</p>
                    </div>
                )}

                {c.scriptReady && (
                    <Disclosure key={`${c.method}-${c.serviceAccountId}-${c.sshPort}`} title={t("wizard.connect.showScript")} icon={<FileText size={15} />} onOpen={c.loadScript}>
                        {c.script === undefined ? (
                            <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
                        ) : (
                            <CodeBlock language={METHOD_LANGUAGE[c.method]} value={c.script} />
                        )}
                    </Disclosure>
                )}
            </div>

            <LiveStatus name={created.name} connected={wizard.connected} reversePort={created.reversePort} rttMs={wizard.rttMs} />

            <StepFooter onBack={() => wizard.goTo(3)}>
                <Button
                    type="button"
                    variant={wizard.connected ? "default" : "outline"}
                    onClick={() => wizard.setStep(5)}
                    className={cn(wizard.connected && "shadow-glow")}
                >
                    {wizard.connected ? t("wizard.connect.next") : t("wizard.connect.nextAnyway")} <ChevronRight />
                </Button>
            </StepFooter>
        </div>
    );
}
