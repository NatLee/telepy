"use client";

/**
 * 新增 / 修改一條指令規則，左側三步：攔什麼（擋下 / 要核准 / 允許、指令或正規表示式、比對式與常用範例、「試一個指令」的
 * 即時結果）→ 管誰、在哪（所有人 / 被分享的人 / 只有我、網頁終端機或 agent、所有隧道或勾選幾條）→ 核准與說明（要核准的
 * 規則：預設 owner + Admin、指定的人，「只有我」= 自己；給人看的說明；開關）。填好的步驟變綠，存檔失敗跳到第一個有錯的。
 * Add or change a command rule in three side steps: what to catch (block / approval / allow, command or regex, the
 * pattern with examples and a live "try a command") → who and where (everyone / shared users / only me, terminal or
 * agents, every tunnel or picked ones) → approval and note (approve rules: owner + Admins by default, named people,
 * or yourself for "only me"; a note people see; on / off). Finished steps turn green; a failed save jumps to the
 * first step with an error.
 */
import React, { useEffect, useState } from "react";
import { Minus, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { StepTabs, type StepTab } from "@/components/ui/step-tabs";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RULE_PRESETS, WHO_KEY, newRuleInput, pickableIds, ruleToInput, tunnelPickable } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RuleErrors } from "@/hooks/useCommandRulesPage";
import type { CheckResult, CommandRule, RuleInput, RuleScope, TunnelChoice, UserBrief } from "@/types/commandRules";
import { ActionIcon } from "./RuleList";

/** 隧道多到要搜尋。/ Show a search box from this many tunnels. */
const SEARCH_FROM = 7;

type RuleStep = "match" | "scope" | "extra";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** null = 新增。/ null = a new rule. */
    rule: CommandRule | null;
    /** personal = 自己的規則；site = 全站（管理員）。/ personal = your own rule; site = site-wide (admins). */
    scope: RuleScope;
    /** 新規則先只套用這條隧道（畫面上選的那條）。/ A new rule starts limited to this tunnel (the one on screen). */
    startTunnel: number | null;
    /** 可以勾的隧道（個人：我看得到的，`manage` = 我是 owner / Admin；全站：所有隧道）。/ Tunnels to pick from. */
    tunnels: TunnelChoice[];
    /** 可以指定的核准人。/ Who may be named as an approver. */
    approverCandidates: UserBrief[];
    onSave: (input: RuleInput, existing: CommandRule | null) => Promise<RuleErrors | null>;
    check: (command: string, draft?: { kind: string; pattern: string }) => Promise<CheckResult | null>;
}

export function RuleDialog(props: Props) {
    // 每次打開都從頭來（key 換掉 = 重設表單）。/ Fresh form every time it opens.
    return props.isOpen ? <RuleForm key={props.rule?.id ?? "new"} {...props} /> : null;
}

function RuleForm({ isOpen, onClose, rule, scope, startTunnel, tunnels, approverCandidates, onSave, check }: Props) {
    const { t } = useI18n();
    const site = scope === "site";
    const [input, setInput] = useState<RuleInput>(rule ? ruleToInput(rule) : newRuleInput(startTunnel));
    const [errors, setErrors] = useState<RuleErrors>({});
    const [tab, setTab] = useState<RuleStep>("match");
    // 「指定的人」模式：一打開有名單就是；切回預設會清空名單。/ "Specific people" mode: on when the rule already names some.
    const [pickApprovers, setPickApprovers] = useState(Boolean(rule && rule.approver_ids.length > 0));
    // 規則指定了現在已經不在候選裡的人（例如不再是 Admin）：還是列出來，讓人看得到、拿得掉。
    // People the rule names who are no longer candidates (e.g. no longer Admin) stay listed so they can be seen and removed.
    const candidates: UserBrief[] = [...approverCandidates, ...(rule?.approvers ?? []).filter((u) => !approverCandidates.some((c) => c.id === u.id))];
    const [saving, setSaving] = useState(false);
    const [sample, setSample] = useState("");
    const [query, setQuery] = useState("");
    const [result, setResult] = useState<{ matches: boolean; error: string | null } | null>(null);
    const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => {
        setInput((p) => ({ ...p, [k]: v }));
        setErrors((e) => ({ ...e, [k]: undefined }));
    };
    const toggleApprover = (id: number) => set("approver_ids", input.approver_ids.includes(id) ? input.approver_ids.filter((x) => x !== id) : [...input.approver_ids, id].sort((a, b) => a - b));

    // 規則原本就套用的隧道（現在可能看不到 / 不再管）：留著才拿得掉。/ Tunnels already on the rule stay tickable.
    const kept = (rule?.tunnels ?? []).map((x) => x.id);
    const gone = (rule?.tunnels ?? []).filter((x) => !tunnels.some((c) => c.id === x.id));
    const choices: (TunnelChoice & { gone?: boolean })[] = [...tunnels, ...gone.map((x) => ({ id: x.id, name: x.name, gone: true }))];
    const shownTunnels = choices.filter((x) => !query.trim() || x.name.toLowerCase().includes(query.trim().toLowerCase()));
    const pickable = (x: TunnelChoice) => tunnelPickable(x, input.who, site, kept.includes(x.id));
    const anyBlocked = choices.some((x) => !pickable(x));
    const pickedIds = pickableIds(input.tunnel_ids, choices, input.who, site, kept);
    const toggleTunnel = (id: number) => set("tunnel_ids", input.tunnel_ids.includes(id) ? input.tunnel_ids.filter((x) => x !== id) : [...input.tunnel_ids, id]);

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

    const selfApproved = !site && input.who === "me";
    const wantsNames = input.action === "approve" && pickApprovers && !selfApproved;
    const stepOf = (e: RuleErrors): RuleStep | null =>
        e.action || e.kind || e.pattern ? "match" : e.who || e.via || e.tunnel_ids || e.all_tunnels ? "scope" : e.approver_ids || e.note || e.enabled ? "extra" : null;
    const save = async () => {
        const local: RuleErrors = {};
        if (!input.all_tunnels && pickedIds.length === 0) local.tunnel_ids = t("commands.form.tunnelsEmpty");
        if (wantsNames && input.approver_ids.length === 0) local.approver_ids = t("commands.form.approversEmpty");
        if (Object.keys(local).length > 0) {
            setErrors((e) => ({ ...e, ...local }));
            setTab(stepOf(local) ?? tab);
            return;
        }
        setSaving(true);
        const errs = await onSave(
            {
                ...input,
                ...(rule ? {} : { scope }),
                tunnel_ids: input.all_tunnels ? [] : pickedIds,
                approver_ids: wantsNames ? input.approver_ids : [],
            },
            rule,
        );
        setSaving(false);
        if (errs === null) onClose();
        else {
            setErrors(errs);
            const first = stepOf(errs);
            if (first) setTab(first);
        }
    };

    const allLabel = site ? t("commands.form.allSite") : input.who === "me" ? t("commands.form.allUsed") : t("commands.form.allManaged");
    const allHint = site ? t("commands.form.allSiteHint") : input.who === "me" ? t("commands.form.allUsedHint") : t("commands.form.allManagedHint");
    const tabs: StepTab<RuleStep>[] = [
        {
            value: "match",
            label: t("commands.step.match"),
            state: errors.action || errors.kind || errors.pattern ? "attention" : input.pattern.trim() ? "done" : "todo",
            status: input.pattern.trim() ? <code className="block truncate font-mono">{input.pattern}</code> : t("commands.step.matchTodo"),
        },
        {
            value: "scope",
            label: t("commands.step.scope"),
            state: errors.who || errors.via || errors.tunnel_ids ? "attention" : input.all_tunnels || pickedIds.length > 0 ? "done" : "todo",
            status: `${t(WHO_KEY[input.who])} · ${input.all_tunnels ? allLabel : t("commands.step.someTunnels", { count: pickedIds.length })}`,
        },
        {
            value: "extra",
            label: t("commands.step.extra"),
            state: errors.approver_ids || errors.note ? "attention" : input.note.trim() || wantsNames ? "done" : "todo",
            status: t("commands.form.optional"),
        },
    ];

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="4xl"
            fixedHeight
            nav={<StepTabs aria-label={t("commands.step.aria")} tabs={tabs} value={tab} onChange={setTab} />}
            icon={<ShieldCheck />}
            title={rule ? t("commands.editRule") : site ? t("commands.admin.add") : t("commands.addRule")}
            description={site ? t("commands.form.descSite") : t("commands.form.descPersonal")}
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
            <div className="space-y-7">
                <section role="tabpanel" hidden={tab !== "match"} className="space-y-5">
                    <h3 className="text-base text-foreground">{t("commands.step.match")}</h3>
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
                </section>

                <section role="tabpanel" hidden={tab !== "scope"} className="space-y-5">
                    <h3 className="text-base text-foreground">{t("commands.step.scope")}</h3>
                    <Field label={t("commands.form.who")} error={errors.who} hint={t(site ? "commands.form.whoHintSite" : "commands.form.whoHint")}>
                        <Segmented
                            size="sm"
                            value={input.who}
                            onChange={(v) => set("who", v)}
                            options={[
                                { value: "everyone", label: t("commands.who.everyone") },
                                { value: "sharees", label: t("commands.who.sharees") },
                                ...(site ? [] : [{ value: "me" as const, label: t("commands.who.me") }]),
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

                    <Field label={t("commands.form.scope")} error={errors.tunnel_ids} hint={input.all_tunnels ? allHint : t("commands.form.someHint")}>
                        <Segmented
                            size="sm"
                            value={input.all_tunnels ? "all" : "some"}
                            onChange={(v) => set("all_tunnels", v === "all")}
                            options={[
                                { value: "all", label: allLabel },
                                { value: "some", label: t("commands.form.someTunnels") },
                            ]}
                            aria-label={t("commands.form.scope")}
                        />
                    </Field>
                    {!input.all_tunnels && (
                        <div className="-mt-2 space-y-2">
                            {choices.length >= SEARCH_FROM && (
                                <div className="relative">
                                    <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("commands.form.searchTunnels")} className="pl-8" aria-label={t("commands.form.searchTunnels")} />
                                </div>
                            )}
                            {choices.length === 0 ? (
                                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">{t("commands.form.noTunnels")}</p>
                            ) : (
                                <ul className="divide-y divide-border rounded-lg border border-border">
                                    {shownTunnels.map((x) => {
                                        const ok = pickable(x);
                                        return (
                                            <li key={x.id}>
                                                <label className={cn("flex items-center gap-3 px-3 py-2", ok ? "cursor-pointer hover:bg-muted/40" : "cursor-not-allowed opacity-60")}>
                                                    <input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={!ok} checked={ok && input.tunnel_ids.includes(x.id)} onChange={() => toggleTunnel(x.id)} />
                                                    <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{x.name}</span>
                                                    {x.gone && <Chip tone="warning">{t("commands.form.tunnelGone")}</Chip>}
                                                    {!ok && <Chip>{t("commands.form.notManaged")}</Chip>}
                                                </label>
                                            </li>
                                        );
                                    })}
                                    {shownTunnels.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">{t("commands.form.noMatch")}</li>}
                                </ul>
                            )}
                            {anyBlocked && <p className="text-xs text-muted-foreground">{t("commands.form.notManagedHint")}</p>}
                        </div>
                    )}
                </section>

                <section role="tabpanel" hidden={tab !== "extra"} className="space-y-5">
                    <h3 className="text-base text-foreground">{t("commands.step.extra")}</h3>
                    {input.action === "approve" &&
                        (selfApproved ? (
                            <Callout tone="info" title={t("commands.form.approvers")}>
                                {t("commands.form.approversSelf")}
                            </Callout>
                        ) : (
                            <Field label={t("commands.form.approvers")} error={errors.approver_ids} hint={t(site ? "commands.form.approversHintSite" : "commands.form.approversHintPersonal")}>
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
                                        <div className="mt-2 rounded-md border border-border bg-surface p-2">
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
                        ))}

                    <Field label={t("commands.form.note")} addon={<span className="text-xs text-muted-foreground">{t("commands.form.optional")}</span>} error={errors.note} hint={t("commands.form.noteHint")}>
                        <Textarea value={input.note} onChange={(e) => set("note", e.target.value)} maxLength={300} rows={2} placeholder={t("commands.form.notePlaceholder")} />
                    </Field>

                    {rule && (
                        <Switch size="sm" checked={input.enabled} onCheckedChange={(on) => set("enabled", on)}>
                            {t("commands.form.enabled")}
                        </Switch>
                    )}
                </section>
            </div>
        </Modal>
    );
}
