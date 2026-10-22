/**
 * 建立精靈 Step 5：檢查清單（通道已建立 → 裝置上線 → 每個帳號實際登入），失敗時給對應的修正提示，最後是下一步捷徑。
 * Wizard step 5: a checklist (tunnel created → device online → a real login per account) with a targeted fix for
 * each failure, then shortcuts to what to do next.
 */
"use client";

import React from "react";
import Link from "next/link";
import {
    AlertTriangle,
    CheckCircle2,
    CircleDashed,
    FileCode2,
    FolderOpen,
    LayoutGrid,
    Loader2,
    PartyPopper,
    RotateCcw,
    Route,
    TerminalSquare,
    XCircle,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import type { CreateTunnelWizard, LoginCheck } from "@/hooks/useCreateTunnelWizard";
import { Code, Disclosure, StepFooter, StepHeading } from "./parts";

type RowState = "ok" | "wait" | "running" | "fail" | "warn";

const ROW_ICON: Record<RowState, { icon: LucideIcon; className: string }> = {
    ok: { icon: CheckCircle2, className: "text-emerald-500" },
    wait: { icon: CircleDashed, className: "text-muted-foreground" },
    running: { icon: Loader2, className: "animate-spin text-primary" },
    fail: { icon: XCircle, className: "text-destructive" },
    warn: { icon: AlertTriangle, className: "text-amber-500" },
};

function CheckRow({ state, title, detail, action }: { state: RowState; title: React.ReactNode; detail?: React.ReactNode; action?: React.ReactNode }) {
    const { icon: Icon, className } = ROW_ICON[state];
    return (
        <li className="flex items-start gap-3 px-4 py-3">
            <Icon size={18} className={cn("mt-0.5 shrink-0", className)} aria-hidden />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{title}</p>
                {detail && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</div>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </li>
    );
}

function loginRow(check: LoginCheck | undefined, connected: boolean): RowState {
    if (!check || check.state === "idle") return connected ? "running" : "wait";
    if (check.state === "checking") return "running";
    return check.state === "ok" ? "ok" : "fail";
}

function NextTile({ href, icon: Icon, title, desc, primary }: { href: string; icon: LucideIcon; title: string; desc: string; primary?: boolean }) {
    return (
        <Link
            href={href}
            prefetch={false}
            className={cn(
                "group flex items-start gap-3 rounded-xl border p-3.5 transition-all duration-200 hover:-translate-y-px",
                primary ? "border-transparent bg-brand-gradient text-white shadow-glow" : "border-border bg-background/60 hover:border-primary/40 hover:bg-primary/5"
            )}
        >
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", primary ? "bg-white/20" : "bg-primary/10 text-primary")} aria-hidden>
                <Icon size={18} />
            </span>
            <span className="min-w-0">
                <span className={cn("block text-sm font-semibold", primary ? "text-white" : "text-foreground")}>{title}</span>
                <span className={cn("block text-xs leading-snug", primary ? "text-white/80" : "text-muted-foreground")}>{desc}</span>
            </span>
        </Link>
    );
}

export function StepVerify({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t, tn } = useI18n();
    const created = wizard.created!;
    const v = wizard.verify;
    const accounts = wizard.accounts.list;
    const connected = wizard.connected;
    const tunnel = { id: created.id, reverse_port: created.reversePort };
    const anyChecking = accounts.some((a) => v.checks[a.username]?.state === "checking");

    const failureHint = (username: string, check: LoginCheck) => {
        if (check.failure === "auth") {
            return (
                <span>
                    {tn("wizard.verify.authFailed", { user: <Code>{username}</Code>, path: <Code>~/.ssh/authorized_keys</Code> })}{" "}
                    <button type="button" onClick={() => wizard.goTo(3)} className="font-medium text-primary hover:underline">{t("wizard.verify.showCommand")}</button>
                </span>
            );
        }
        if (check.failure === "offline") return t("wizard.verify.offlineFailed");
        return <span className="break-words font-mono">{check.message}</span>;
    };

    return (
        <div className="space-y-6">
            {v.allLoginsOk ? (
                <div className="flex items-center gap-4 rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/[0.10] to-transparent p-4 animate-fade-in-up sm:p-5">
                    <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-[0_0_24px_rgba(16,185,129,0.45)]" aria-hidden>
                        <PartyPopper size={24} />
                    </span>
                    <StepHeading title={t("wizard.verify.readyTitle", { name: created.name })} subtitle={t("wizard.verify.readyBody")} />
                </div>
            ) : (
                <StepHeading title={t("wizard.verify.title")} subtitle={t("wizard.verify.subtitle", { name: created.name })} />
            )}

            <div className="overflow-hidden rounded-2xl border border-border bg-background/50">
                <ol className="divide-y divide-border">
                    <CheckRow state="ok" title={t("wizard.verify.created")} detail={t("wizard.verify.createdDetail", { port: created.reversePort })} />
                    <CheckRow
                        state={connected ? "ok" : "wait"}
                        title={connected ? t("wizard.verify.online") : t("wizard.verify.offline")}
                        detail={connected
                            ? (wizard.rttMs !== null ? t("wizard.diagram.rtt", { ms: Math.round(wizard.rttMs) }) : undefined)
                            : t("wizard.verify.offlineDetail")}
                        action={!connected && (
                            <Button type="button" variant="outline" size="sm" onClick={() => wizard.goTo(4)}>{t("wizard.verify.backToConnect")}</Button>
                        )}
                    />
                    {accounts.length === 0 ? (
                        <CheckRow
                            state="warn"
                            title={t("wizard.verify.noAccounts")}
                            detail={t("wizard.verify.noAccountsDetail")}
                            action={<Button type="button" variant="outline" size="sm" onClick={() => wizard.goTo(2)}>{t("wizard.verify.addAccount")}</Button>}
                        />
                    ) : (
                        accounts.map((acc) => {
                            const check = v.checks[acc.username];
                            const state = loginRow(check, connected);
                            return (
                                <CheckRow
                                    key={acc.id}
                                    state={state}
                                    title={tn("wizard.verify.login", { user: <Code>{acc.username}</Code> })}
                                    detail={
                                        state === "ok" ? t("wizard.verify.loginOk", { shell: check?.shell === "powershell" ? "PowerShell" : "Unix" })
                                        : state === "fail" && check ? failureHint(acc.username, check)
                                        : state === "wait" ? t("wizard.verify.loginWaiting")
                                        : t("wizard.verify.loginChecking")
                                    }
                                    action={state === "fail" && (
                                        <Button type="button" variant="ghost" size="sm" onClick={() => v.checkLogin(acc.username)} disabled={!connected}>
                                            <RotateCcw /> {t("wizard.verify.retry")}
                                        </Button>
                                    )}
                                />
                            );
                        })
                    )}
                </ol>
                {accounts.length > 0 && (
                    <div className="flex items-center justify-end border-t border-border bg-muted/30 px-4 py-2">
                        <Button type="button" variant="ghost" size="sm" onClick={v.checkAll} disabled={!connected || anyChecking}>
                            <RotateCcw className={cn(anyChecking && "animate-spin")} /> {t("wizard.verify.recheck")}
                        </Button>
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("wizard.verify.nextTitle")}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                    <NextTile href={getTerminalPageUrl(tunnel)} icon={TerminalSquare} title={t("wizard.verify.openTerminal")} desc={t("wizard.verify.openTerminalDesc")} primary={v.allLoginsOk} />
                    <NextTile href={getTerminalPageUrl(tunnel, { mainView: "files" })} icon={FolderOpen} title={t("wizard.verify.openFiles")} desc={t("wizard.verify.openFilesDesc")} />
                    <NextTile href={`/tunnels/cheatsheet?tunnel=${created.id}`} icon={Route} title={t("wizard.verify.openSheet")} desc={t("wizard.verify.openSheetDesc")} />
                    <NextTile href="/tunnels" icon={LayoutGrid} title={t("wizard.goToDashboard")} desc={t("wizard.verify.dashboardDesc")} />
                </div>
            </div>

            <Disclosure title={t("wizard.verify.laptopTitle")} icon={<FileCode2 size={15} />}>
                <p className="mb-2 text-xs text-muted-foreground">{tn("wizard.sshConfigBody", { path: <Code>~/.ssh/config</Code> })}</p>
                {v.configLoading ? (
                    <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
                ) : (
                    <CodeBlock language="txt" value={v.configContent} />
                )}
            </Disclosure>

            <StepFooter onBack={() => wizard.goTo(4)}>
                <Button asChild variant={v.allLoginsOk ? "outline" : "default"}>
                    <Link href="/tunnels" prefetch={false}>{t("wizard.verify.finish")}</Link>
                </Button>
            </StepFooter>
        </div>
    );
}
