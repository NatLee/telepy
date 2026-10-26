"use client";

/**
 * 新增 / 修改一條指令規則：做什麼（擋下 / 要核准 / 允許）、怎麼比（指令 / 正規表示式）、比對式（含常用範例與「試一個指令」的即時結果）、
 * 管誰、管哪裡、誰核准（要核准的規則：預設 owner + Admin，或指定的人）、給人看的說明。
 * Add or change a command rule: what happens (block / approval / allow), how it matches (command / regex), the pattern
 * (with common examples and a live "try a command" result), who and where it applies, who approves (approve rules:
 * the owner + Admins by default, or named people), and a note people see.
 */
import React, { useEffect, useState } from "react";
import { Minus, ShieldCheck } from "lucide-react";
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
import type { CheckResult, CommandRule, RuleInput, UserBrief } from "@/types/commandRules";
import { ActionIcon } from "./RuleList";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** null = 新增。/ null = a new rule. */
    rule: CommandRule | null;
    /** 範圍的說明（全站 / 隧道名稱）。/ The scope in words. */
    scopeLabel: string;
    /** 這裡是隧道的規則（核准人候選 = 擁有者 + Admin）還是全站的（任何帳號）。/ Tunnel scope (candidates = owner + Admins) or site (any account). */
    scopeIsTunnel: boolean;
    /** 可以指定的核准人。/ Who may be named as an approver. */
    approverCandidates: UserBrief[];
    onSave: (input: RuleInput, existing: CommandRule | null) => Promise<RuleErrors | null>;
    check: (command: string, draft?: { kind: string; pattern: string }) => Promise<CheckResult | null>;
}

export function RuleDialog(props: Props) {
    // 每次打開都從頭來（key 換掉 = 重設表單）。/ Fresh form every time it opens.
    return props.isOpen ? <RuleForm key={props.rule?.id ?? "new"} {...props} /> : null;
}

function RuleForm({ isOpen, onClose, rule, scopeLabel, scopeIsTunnel, approverCandidates, onSave, check }: Props) {
    const { t } = useI18n();
    const [input, setInput] = useState<RuleInput>(rule ? ruleToInput(rule) : DEFAULT_RULE);
    const [errors, setErrors] = useState<RuleErrors>({});
    // 「指定的人」模式：一打開有名單就是；切回預設會清空名單。/ "Specific people" mode: on when the rule already names some.
    const [pickApprovers, setPickApprovers] = useState(Boolean(rule && rule.approver_ids.length > 0));
    // 規則指定了現在已經不在候選裡的人（例如不再是 Admin）：還是列出來，讓人看得到、拿得掉。
    // People the rule names who are no longer candidates (e.g. no longer Admin) stay listed so they can be seen and removed.
    const candidates: UserBrief[] = [...approverCandidates, ...(rule?.approvers ?? []).filter((u) => !approverCandidates.some((c) => c.id === u.id))];
    const toggleApprover = (id: number) => set("approver_ids", input.approver_ids.includes(id) ? input.approver_ids.filter((x) => x !== id) : [...input.approver_ids, id].sort((a, b) => a - b));
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

    const wantsNames = input.action === "approve" && pickApprovers;
    const save = async () => {
        if (wantsNames && input.approver_ids.length === 0) {
            setErrors((e) => ({ ...e, approver_ids: t("commands.form.approversEmpty") }));
            return;
        }
        setSaving(true);
        const errs = await onSave({ ...input, approver_ids: wantsNames ? input.approver_ids : [] }, rule);
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
                            { value: "block", label: t("commands.action.block"), icon: <ActionIcon action="block" /> },
                            { value: "approve", label: t("commands.action.approve"), icon: <ActionIcon action="approve" /> },
                            { value: "allow", label: t("commands.action.allow"), icon: <ActionIcon action="allow" /> },
                        ]}
                        aria-label={t("commands.form.action")}
                    />
                </Field>
                <p className="-mt-3 text-xs text-muted-foreground">{t(input.action === "block" ? "commands.form.blockHint" : input.action === "approve" ? "commands.form.approveHint" : "commands.form.allowHint")}</p>

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
                                    <ActionIcon action={input.action} className={input.action === "block" ? "text-destructive" : input.action === "approve" ? "text-warning" : "text-success"} />
                                    {t(input.action === "block" ? "commands.form.wouldBlock" : input.action === "approve" ? "commands.form.wouldHold" : "commands.form.wouldAllow")}
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

                {input.action === "approve" && (
                    <Field label={t("commands.form.approvers")} error={errors.approver_ids} hint={t(scopeIsTunnel ? "commands.form.approversHintTunnel" : "commands.form.approversHintSite")}>
                        <div>
                        <Segmented
                            size="sm"
                            value={pickApprovers ? "pick" : "default"}
                            onChange={(v) => {
                                setPickApprovers(v === "pick");
                                setErrors((e) => ({ ...e, approver_ids: undefined }));
                            }}
                            options={[
                                { value: "default", label: t("commands.form.approversDefault") },
                                { value: "pick", label: t("commands.form.approversPick") },
                            ]}
                            aria-label={t("commands.form.approvers")}
                        />
                        {pickApprovers && (
                            <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-surface p-2">
                                {candidates.length === 0 ? (
                                    <p className="px-1 py-1 text-xs text-muted-foreground">{t("commands.form.approversNone")}</p>
                                ) : (
                                    <ul className="grid gap-1 sm:grid-cols-2">
                                        {candidates.map((u) => (
                                            <li key={u.id}>
                                                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm text-foreground hover:bg-muted">
                                                    <input type="checkbox" className="size-4 accent-primary" checked={input.approver_ids.includes(u.id)} onChange={() => toggleApprover(u.id)} />
                                                    <span className="truncate">{u.username}</span>
                                                </label>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                        </div>
                    </Field>
                )}

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
