"use client";

/**
 * 「試一個指令」：用真正的比對（後端）看這一行對你、對被分享的人各會怎樣，以及拆出了哪些指令（看得出 sudo / sh -c 被看穿了）。
 * "Try a command": the real matcher (backend) shows what happens to you and to shared users, and which commands the
 * line was split into (so you can see sudo / sh -c being looked through).
 */
import React, { useEffect, useState } from "react";
import { Ban, CircleCheck, FlaskConical, Hourglass } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { CheckResult, CheckVerdict } from "@/types/commandRules";

function Verdict({ label, v }: { label: string; v: CheckVerdict }) {
    const { t } = useI18n();
    const icon = v.action === "block" ? <Ban size={15} className="text-destructive" aria-hidden /> : v.action === "approve" ? <Hourglass size={15} className="text-warning" aria-hidden /> : <CircleCheck size={15} className="text-success" aria-hidden />;
    const text = v.action === "block" ? t("commands.tester.blocked") : v.action === "approve" ? t("commands.tester.held") : t("commands.tester.allowed");
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
            {icon}
            <span className="text-foreground">{text}</span>
            {v.rule && (
                <span className="text-xs text-muted-foreground">
                    {t(v.rule.scope === "site" ? "commands.matchedSiteRule" : "commands.matchedTunnelRule")} <code className="font-mono text-foreground">{v.rule.pattern}</code>
                </span>
            )}
        </li>
    );
}

export function CommandTester({ check, scopeIsTunnel }: { check: (command: string) => Promise<CheckResult | null>; scopeIsTunnel: boolean }) {
    const { t } = useI18n();
    const [command, setCommand] = useState("");
    const [result, setResult] = useState<CheckResult | null>(null);

    useEffect(() => {
        if (!command.trim()) return;
        let cancelled = false;
        const id = setTimeout(async () => {
            const r = await check(command);
            if (!cancelled) setResult(r);
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(id);
        };
    }, [command, check]);
    const shown = command.trim() ? result : null;

    return (
        <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-1 flex items-center gap-2 text-sm text-foreground">
                <FlaskConical size={16} className="text-muted-foreground" aria-hidden /> {t("commands.tester.title")}
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">{t(scopeIsTunnel ? "commands.tester.hintTunnel" : "commands.tester.hintSite")}</p>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sudo systemctl stop nginx" className="font-mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={t("commands.tester.title")} />
            {shown && (
                <div className="mt-3 space-y-2">
                    <ul className="space-y-1.5">
                        <Verdict label={t("commands.tester.forApprovers")} v={shown.for_approvers} />
                        <Verdict label={t("commands.tester.forSharees")} v={shown.for_sharees} />
                    </ul>
                    {shown.commands.length > 0 && (
                        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            {t("commands.tester.seenAs")}
                            {shown.commands.map((c, i) => (
                                <Chip key={i} mono>
                                    {[c.program, ...c.args].join(" ")}
                                </Chip>
                            ))}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
