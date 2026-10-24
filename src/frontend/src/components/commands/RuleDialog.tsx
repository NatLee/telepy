"use client";

/**
 * 新增 / 修改一條指令規則：做什麼（擋下 / 要核准）、怎麼比（指令 / 正規表示式）、比對式（含常用範例與「試一個指令」的即時結果）、
 * 管誰、管哪裡、給人看的說明。
 * Add or change a command rule: what happens (block / approval), how it matches (command / regex), the pattern (with
 * common examples and a live "try a command" result), who and where it applies, and a note people see.
 */
import React, { useEffect, useState } from "react";
import { Ban, Hourglass, Minus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_RULE, RULE_PRESETS, ruleToInput } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RuleErrors } from "@/hooks/useCommandRulesPage";
import type { CheckResult, CommandRule, RuleInput } from "@/types/commandRules";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** null = 新增。/ null = a new rule. */
    rule: CommandRule | null;
    /** 範圍的說明（全站 / 隧道名稱）。/ The scope in words. */
    scopeLabel: string;
    onSave: (input: RuleInput, existing: CommandRule | null) => Promise<RuleErrors | null>;
    check: (command: string, draft?: { kind: string; pattern: string }) => Promise<CheckResult | null>;
}

export function RuleDialog(props: Props) {
    // 每次打開都從頭來（key 換掉 = 重設表單）。/ Fresh form every time it opens.
    return props.isOpen ? <RuleForm key={props.rule?.id ?? "new"} {...props} /> : null;
}

function RuleForm({ isOpen, onClose, rule, scopeLabel, onSave, check }: Props) {
    const { t } = useI18n();
    const [input, setInput] = useState<RuleInput>(rule ? ruleToInput(rule) : DEFAULT_RULE);
    const [errors, setErrors] = useState<RuleErrors>({});
    const [saving, setSaving] = useState(false);
    const [sample, setSample] = useState("");
    const [result, setResult] = useState<{ matches: boolean; error: string | null } | null>(null);
    const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => {
        setInput((p) => ({ ...p, [k]: v }));
        setErrors((e) => ({ ...e, [k]: undefined }));
    };

    // 「試一個指令」：停手 300ms 後問後端（與真正比對同一套）。/ The live check, debounced, using the real matcher.
    useEffect(() => {
        if (!sample.trim() || !input.pattern.trim()) return;
        let cancelled = false;
        const id = setTimeout(async () => {
            const r = await check(sample, { kind: input.kind, pattern: input.pattern });
            if (!cancelled) setResult(r?.draft ?? null);
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(id);
        };
    }, [sample, input.kind, input.pattern, check]);
    const shownResult = sample.trim() && input.pattern.trim() ? result : null;

    const save = async () => {
        setSaving(true);
        const errs = await onSave(input, rule);
        setSaving(false);
        if (errs === null) onClose();
        else setErrors(errs);
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="xl"
            icon={<ShieldCheck />}
            title={rule ? t("commands.editRule") : t("commands.addRule")}
            description={scopeLabel}
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={saving || !input.pattern.trim()}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <div className="space-y-5">
                <Field label={t("commands.form.action")} error={errors.action}>
                    <Segmented
                        fullWidth
                        value={input.action}
                        onChange={(v) => set("action", v)}
                        options={[
                            { value: "block", label: t("commands.action.block"), icon: <Ban size={15} /> },
                            { value: "approve", label: t("commands.action.approve"), icon: <Hourglass size={15} /> },
                        ]}
                        aria-label={t("commands.form.action")}
                    />
                </Field>
                <p className="-mt-3 text-xs text-muted-foreground">{t(input.action === "block" ? "commands.form.blockHint" : "commands.form.approveHint")}</p>

                <Field label={t("commands.form.match")} error={errors.kind}>
                    <Segmented
                        size="sm"
                        value={input.kind}
                        onChange={(v) => set("kind", v)}
                        options={[
                            { value: "command", label: t("commands.kind.command") },
                            { value: "regex", label: t("commands.kind.regex") },
                        ]}
                        aria-label={t("commands.form.match")}
                    />
                </Field>

                <Field label={t("commands.form.pattern")} required error={errors.pattern} hint={t(input.kind === "command" ? "commands.form.commandHint" : "commands.form.regexHint")}>
                    <Input
                        value={input.pattern}
                        onChange={(e) => set("pattern", e.target.value)}
                        placeholder={input.kind === "command" ? "rm -rf" : "curl .*\\|\\s*sh"}
                        className="font-mono"
                        maxLength={500}
                        autoFocus={!rule}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </Field>
                {!rule && !input.pattern && (
                    <div className="-mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("commands.form.examples")}</span>
                        {RULE_PRESETS.map((p) => (
                            <button
                                key={p.pattern}
                                type="button"
                                onClick={() => setInput((prev) => ({ ...prev, action: p.action, kind: p.kind, pattern: p.pattern }))}
                                className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-foreground hover:border-foreground/30 hover:bg-muted"
                            >
                                {p.pattern}
                            </button>
                        ))}
                    </div>
                )}

                <div className="rounded-lg border border-border bg-surface p-3">
                    <Field label={t("commands.form.tryIt")} hint={t("commands.form.tryItHint")}>
                        <Input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="sudo rm -rf /var/log/app" className="font-mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
                    </Field>
                    {shownResult && (
                        <p className={cn("mt-2 flex items-center gap-1.5 text-sm", shownResult.error ? "text-destructive" : shownResult.matches ? "text-foreground" : "text-muted-foreground")}>
                            {shownResult.error ? (
                                shownResult.error
                            ) : shownResult.matches ? (
                                <>
                                    {input.action === "block" ? <Ban size={15} className="text-destructive" aria-hidden /> : <Hourglass size={15} className="text-warning" aria-hidden />}
                                    {t(input.action === "block" ? "commands.form.wouldBlock" : "commands.form.wouldHold")}
                                </>
                            ) : (
                                <>
                                    <Minus size={15} aria-hidden /> {t("commands.form.wouldPass")}
                                </>
                            )}
                        </p>
                    )}
                </div>

                <Field label={t("commands.form.who")} error={errors.who} hint={t("commands.form.whoHint")}>
                    <Segmented
                        size="sm"
                        value={input.who}
                        onChange={(v) => set("who", v)}
                        options={[
                            { value: "everyone", label: t("commands.who.everyone") },
                            { value: "sharees", label: t("commands.who.sharees") },
                        ]}
                        aria-label={t("commands.form.who")}
                    />
                </Field>

                <Field label={t("commands.form.via")} error={errors.via}>
                    <Segmented
                        size="sm"
                        value={input.via}
                        onChange={(v) => set("via", v)}
                        options={[
                            { value: "all", label: t("commands.via.all") },
                            { value: "terminal", label: t("commands.via.terminal") },
                            { value: "agents", label: t("commands.via.agents") },
                        ]}
                        aria-label={t("commands.form.via")}
                    />
                </Field>

                <Field label={t("commands.form.note")} addon={<span className="text-xs text-muted-foreground">{t("commands.form.optional")}</span>} error={errors.note} hint={t("commands.form.noteHint")}>
                    <Textarea value={input.note} onChange={(e) => set("note", e.target.value)} maxLength={300} rows={2} placeholder={t("commands.form.notePlaceholder")} />
                </Field>

                {rule && (
                    <label className="flex items-center gap-2 text-sm text-foreground">
                        <input type="checkbox" className="size-4 accent-primary" checked={input.enabled} onChange={(e) => set("enabled", e.target.checked)} />
                        {t("commands.form.enabled")}
                    </label>
                )}
            </div>
        </Modal>
    );
}
