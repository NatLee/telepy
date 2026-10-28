"use client";

/**
 * 「指令是怎麼決定的」路徑圖：指令 ─ 拆開 ─ 全站規則 ─ 個人規則 ─ 結果。每個規則格子有三條道（允許 / 擋下 / 要核准），
 * 試跑過指令後，走到的道會亮起來：哪個範圍攔到、有沒有被同一位作者的例外豁免、最後誰核准。直線與直角，寬容器橫向、窄容器直向。
 * The "how a command is decided" path: command ─ split ─ site rules ─ personal rules ─ verdict. Each rules box has
 * three lanes (allow / block / approve); after a test the lanes the command took light up: which scope caught it,
 * whether an exception of the same author exempted it, and who approves. Straight lines and right angles; a row in
 * a wide container, a column in a narrow one.
 */
import React from "react";
import { CircleCheck, Keyboard, Scissors, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ACTION_KEY, caughtAs, decisionPath, type DecisionPath, type Outcome, type ScopeStep } from "@/lib/commandRules";
import type { CheckVerdict, MatchedRule, RuleAction, RuleScope } from "@/types/commandRules";
import type { TranslationKey } from "@/locales/en";
import { ActionIcon } from "./RuleList";

export interface DecisionFlowProps {
    /** 試跑的指令（空 = 還沒試）。/ The tested command (empty = none yet). */
    command: string;
    verdict: CheckVerdict | null;
    /** 畫的是誰的結果。/ Whose verdict is drawn. */
    who: "approvers" | "sharees";
    /** 個人規則那格有沒有在算（全站頁不算）。/ Whether the personal box takes part (not on the site page). */
    personalCounts: boolean;
}

const LANES: RuleAction[] = ["allow", "block", "approve", "warn"];

const LANE_LIT: Record<RuleAction, string> = {
    allow: "border-success/60 bg-success/10 text-success",
    block: "border-destructive/60 bg-destructive/10 text-destructive",
    approve: "border-warning/60 bg-warning/12 text-warning",
    warn: "border-foreground/40 bg-muted text-foreground",
};

const OUTCOME_TONE: Record<Outcome, string> = { allow: "text-success", block: "text-destructive", approve: "text-warning", warn: "text-foreground" };
const OUTCOME_BORDER: Record<Outcome, string> = { allow: "border-success/50", block: "border-destructive/70", approve: "border-warning/60", warn: "border-foreground/40" };
const OUTCOME_KEY: Record<Outcome, TranslationKey> = { allow: "commands.flow.outcome.allow", block: "commands.flow.outcome.block", approve: "commands.flow.outcome.approve", warn: "commands.flow.outcome.warn" };
const SCOPE_KEY: Record<ScopeStep, TranslationKey> = {
    none: "commands.flow.scope.none",
    block: "commands.flow.scope.block",
    approve: "commands.flow.scope.approve",
    warn: "commands.flow.scope.warn",
    exempted: "commands.flow.scope.exempted",
    allowOnly: "commands.flow.scope.allowOnly",
};

/** 哪些道要亮：攔到的那條（被豁免時劃掉）與豁免它的允許。/ Which lanes light: the caught one (struck when exempted) and the allow. */
function laneState(step: ScopeStep, hit: MatchedRule | null, lane: RuleAction): "lit" | "struck" | "off" {
    const caught: RuleAction | null = hit ? (caughtAs(hit.action) ?? "approve") : step === "block" || step === "approve" || step === "warn" ? step : null;
    if (lane === "allow") return step === "exempted" || step === "allowOnly" ? "lit" : "off";
    if (lane !== caught) return "off";
    return step === "exempted" ? "struck" : "lit";
}

function Box({ children, lit, className, title, sub, icon: Icon, brand }: { children?: React.ReactNode; lit: boolean; className?: string; title: string; sub?: string; icon?: LucideIcon; brand?: boolean }) {
    return (
        <li className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-3 py-3 @3xl:flex-1 @3xl:basis-0", lit ? "border-foreground/30" : "border-border", className)}>
            <span className="flex items-center gap-2">
                {Icon && (
                    <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
                        <Icon size={15} />
                    </span>
                )}
                <span className="min-w-0 text-sm text-foreground">{title}</span>
            </span>
            {sub && <span className="text-xs leading-snug text-muted-foreground">{sub}</span>}
            {children}
        </li>
    );
}

/** 兩格之間的直線：窄直向、寬橫向；有結果時實線、沒有時虛線。/ The straight link: vertical when narrow, horizontal when wide. */
function Link({ lit }: { lit: boolean }) {
    const line = (vertical: boolean) => (
        <svg className={cn(vertical ? "h-6 w-3 @3xl:hidden" : "hidden h-3 w-full @3xl:block", lit ? "text-foreground/60" : "text-muted-foreground/60")} viewBox={vertical ? "0 0 6 100" : "0 0 100 6"} preserveAspectRatio="none" aria-hidden>
            <line x1={vertical ? 3 : 0} y1={vertical ? 0 : 3} x2={vertical ? 3 : 100} y2={vertical ? 100 : 3} stroke="currentColor" strokeWidth={2} strokeDasharray={lit ? undefined : "4 5"} vectorEffect="non-scaling-stroke" />
        </svg>
    );
    return (
        <li className="flex items-center justify-center px-6 @3xl:w-6 @3xl:shrink-0 @3xl:px-0" aria-hidden>
            {line(true)}
            {line(false)}
        </li>
    );
}

function ScopeBox({ scope, step, hit, allowedBy, lit, dim }: { scope: RuleScope; step: ScopeStep; hit: MatchedRule | null; allowedBy: MatchedRule | null; lit: boolean; dim: boolean }) {
    const { t } = useI18n();
    const site = scope === "site";
    return (
        <Box lit={lit} className={cn(dim && "opacity-60")} title={t(site ? "commands.flow.siteRules" : "commands.flow.personalRules")} sub={t(site ? "commands.flow.siteRulesSub" : "commands.flow.personalRulesSub")}>
            <ul className="mt-1 space-y-1">
                {LANES.map((lane) => {
                    const state = laneState(step, hit, lane);
                    const rule = lane === "allow" ? allowedBy : hit;
                    return (
                        <li key={lane} className={cn("flex flex-col rounded-sm border px-1.5 py-0.5 text-xs", state === "off" ? "border-transparent text-muted-foreground" : LANE_LIT[lane])}>
                            <span className={cn("flex items-center gap-1.5", state === "struck" && "line-through decoration-2")}>
                                <ActionIcon action={lane} size={13} className="shrink-0" />
                                <span className="truncate">{t(ACTION_KEY[lane])}</span>
                            </span>
                            {/* 亮起的道標出那條規則；被豁免的劃掉。/ A lit lane names its rule; an exempted one is struck through. */}
                            {state !== "off" && rule && <code className={cn("truncate pl-5 font-mono text-foreground", state === "struck" && "line-through decoration-2")}>{rule.pattern}</code>}
                        </li>
                    );
                })}
            </ul>
            {lit && <span className={cn("mt-1 text-xs leading-snug", step === "none" ? "text-muted-foreground" : "text-foreground")}>{t(SCOPE_KEY[step])}</span>}
        </Box>
    );
}

function VerdictBox({ path }: { path: DecisionPath | null }) {
    const { t } = useI18n();
    const outcome = path?.outcome ?? null;
    const detail: string | null = !path
        ? null
        : path.outcome === "allow"
          ? path.allowedBy
              ? t("commands.flow.allowedBy", { pattern: path.allowedBy.pattern })
              : t("commands.flow.noRule")
          : path.rule
            ? t(path.decidedBy === "site" ? "commands.flow.decidedBySite" : "commands.flow.decidedByPersonal", { pattern: path.rule.pattern })
            : null;
    const approvers = path?.approvers ? (path.approvers.names.length > 0 ? t("commands.flow.approversNamed", { names: path.approvers.names.join(", ") }) : t("commands.flow.approversDefault")) : null;
    return (
        <li className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-3 py-3 @3xl:flex-1 @3xl:basis-0", outcome ? OUTCOME_BORDER[outcome] : "border-border")}>
            <span className="text-sm text-foreground">{t("commands.flow.verdict")}</span>
            <span className={cn("flex items-center gap-2 text-sm", outcome ? OUTCOME_TONE[outcome] : "text-muted-foreground")}>
                {outcome === "allow" ? <CircleCheck size={18} aria-hidden /> : outcome ? <ActionIcon action={outcome} size={18} /> : null}
                {t(outcome ? OUTCOME_KEY[outcome] : "commands.flow.outcome.idle")}
            </span>
            {detail && <span className="text-xs leading-snug text-muted-foreground">{detail}</span>}
            {approvers && <span className="text-xs leading-snug text-foreground">{approvers}</span>}
        </li>
    );
}

export function DecisionFlow({ command, verdict, who, personalCounts }: DecisionFlowProps) {
    const { t } = useI18n();
    const path = verdict ? decisionPath(verdict) : null;
    const lit = path !== null;
    return (
        <div className="space-y-4">
            <p className={cn("rounded-md border px-3 py-2 text-sm", lit ? "border-border bg-surface text-foreground" : "border-dashed border-border text-muted-foreground")} role="status">
                {lit ? (
                    <>
                        {t("commands.flow.now", { who: t(who === "approvers" ? "commands.tester.forApprovers" : "commands.tester.forSharees") })} <code className="break-all font-mono text-foreground">{command}</code>
                    </>
                ) : (
                    t("commands.flow.idle")
                )}
            </p>
            <div className="@container">
                <ol className="flex flex-col items-stretch @3xl:flex-row">
                    <Box lit={lit} icon={Keyboard} title={t("commands.flow.typed")} sub={t("commands.flow.typedSub")}>
                        {command && <code className="mt-1 break-all font-mono text-xs text-foreground">{command}</code>}
                    </Box>
                    <Link lit={lit} />
                    <Box lit={lit} icon={Scissors} title={t("commands.flow.split")} sub={t("commands.flow.splitSub")} />
                    <Link lit={lit} />
                    <ScopeBox scope="site" step={path?.site ?? "none"} hit={path?.scopes.site.hit ?? null} allowedBy={path?.scopes.site.allowedBy ?? null} lit={lit} dim={false} />
                    <Link lit={lit} />
                    <ScopeBox scope="personal" step={path?.personal ?? "none"} hit={path?.scopes.personal.hit ?? null} allowedBy={path?.scopes.personal.allowedBy ?? null} lit={lit && personalCounts} dim={!personalCounts} />
                    <Link lit={lit} />
                    <VerdictBox path={path} />
                </ol>
            </div>
        </div>
    );
}
