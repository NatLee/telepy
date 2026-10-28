"use client";

/**
 * 「試一個指令」：用真正的比對（後端）看這一行對你、對被分享的人各會怎樣（哪條規則決定、哪條例外豁免、誰核准），以及拆出了
 * 哪些指令（看得出 sudo / sh -c 被看穿了）。結果也交給上層（決定路徑圖用）。
 * "Try a command": the real matcher (backend) shows what happens to you and to shared users (which rule decided, which
 * exception exempted it, who approves), and which commands the line was split into. The result is also handed up (for
 * the decision diagram).
 */
import React, { useEffect, useState } from "react";
import { CircleCheck, FlaskConical } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { CheckResult, CheckVerdict } from "@/types/commandRules";
import { ActionIcon, RuleSource } from "./RuleList";

function Verdict({ label, v }: { label: string; v: CheckVerdict }) {
    const { t } = useI18n();
    const icon = v.action === "allow" ? <CircleCheck size={15} className="text-success" aria-hidden /> : <ActionIcon action={v.action} className={v.action === "block" ? "text-destructive" : "text-warning"} />;
    const text = v.action === "block" ? t("commands.tester.blocked") : v.action === "approve" ? t("commands.tester.held") : t("commands.tester.allowed");
    const approvers = v.action === "approve" && v.approvers ? (v.approvers.default && v.approvers.users.length === 0 ? t("commands.tester.approversDefault") : t("commands.tester.approvers", { names: v.approvers.users.map((u) => u.username).join(", ") })) : null;
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
            {icon}
            <span className="text-foreground">{text}</span>
            {v.rule && (
                <span className="text-xs text-muted-foreground">
                    <RuleSource rule={v.rule} /> <code className="font-mono text-foreground">{v.rule.pattern}</code>
                </span>
            )}
            {/* 放行是因為例外規則。/ Allowed thanks to an exception. */}
            {!v.rule && v.allowed_by && (
                <span className="text-xs text-muted-foreground">
                    {t("commands.tester.allowedBy")} <code className="font-mono text-foreground">{v.allowed_by.pattern}</code> (<RuleSource rule={v.allowed_by} />)
                </span>
            )}
            {approvers && <span className="basis-full pl-34 text-xs text-muted-foreground">{approvers}</span>}
        </li>
    );
}

export function CommandTester({
    check,
    hint,
    markYou = true,
    onResult,
}: {
    check: (command: string) => Promise<CheckResult | null>;
    /** 對照哪些規則。/ Which rules are checked. */
    hint: string;
    /** 標出哪一行是「你」（全站頁不標）。/ Mark which line is you (not on the site page). */
    markYou?: boolean;
    /** 每次有新結果（或清空）就通知。/ Called with every new result (or when cleared). */
    onResult?: (command: string, result: CheckResult | null) => void;
}) {
    const { t } = useI18n();
    const [command, setCommand] = useState("");
    const [result, setResult] = useState<CheckResult | null>(null);

    useEffect(() => {
        if (!command.trim()) {
            onResult?.("", null);
            return;
        }
        let cancelled = false;
        const id = setTimeout(async () => {
            const r = await check(command);
            if (!cancelled) {
                setResult(r);
                onResult?.(command, r);
            }
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(id);
        };
        // onResult 是上層的 setState，不列進依賴。/ onResult is the parent's setState; not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [command, check]);
    const shown = command.trim() ? result : null;
    const you = (label: string, mine: boolean) => (markYou && mine ? t("commands.tester.you", { who: label }) : label);

    return (
        <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-1 flex items-center gap-2 text-sm text-foreground">
                <FlaskConical size={16} className="text-muted-foreground" aria-hidden /> {t("commands.tester.title")}
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">{hint}</p>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sudo systemctl stop nginx" className="font-mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={t("commands.tester.title")} />
            {shown && (
                <div className="mt-3 space-y-2">
                    <ul className="space-y-1.5">
                        <Verdict label={you(t("commands.tester.forApprovers"), shown.you_approve)} v={shown.for_approvers} />
                        <Verdict label={you(t("commands.tester.forSharees"), !shown.you_approve)} v={shown.for_sharees} />
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
