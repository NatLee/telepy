/**
 * 建立精靈 Step 2：Telepy 可以用哪些 OS 帳號登入裝置（目標使用者允許清單）。
 * Wizard step 2: which OS accounts Telepy may log in to the device as (the target-user allow-list).
 */
"use client";

import React from "react";
import { ChevronRight, Loader2, Plus, UserRound, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { commentUser } from "@/lib/tunnelSetup";
import type { CreateTunnelWizard } from "@/hooks/useCreateTunnelWizard";
import { Code, StepFooter, StepHeading } from "./parts";

const COMMON_ACCOUNTS = ["root", "ubuntu", "pi", "admin", "ec2-user"];

export function StepAccounts({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t, tn } = useI18n();
    const a = wizard.accounts;
    const name = wizard.created?.name ?? "";
    const fromKey = commentUser(a.suggestedFromKey);
    const taken = new Set(a.list.map((x) => x.username));
    const suggestions = Array.from(new Set([fromKey, ...COMMON_ACCOUNTS].filter((s): s is string => !!s))).filter((s) => !taken.has(s));

    return (
        <div className="space-y-6">
            <StepHeading title={t("wizard.accounts.title")} subtitle={tn("wizard.accounts.subtitle", { name: <strong className="text-foreground">{name}</strong> })} />

            <div className="space-y-3">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        a.add(a.newAccount);
                    }}
                    className="flex gap-2"
                >
                    <label htmlFor="wizard-account" className="sr-only">{t("wizard.accounts.inputLabel")}</label>
                    <Input
                        id="wizard-account"
                        value={a.newAccount}
                        onChange={(e) => a.setNewAccount(e.target.value)}
                        placeholder={t("wizard.step3UserPlaceholder")}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 font-mono"
                    />
                    <Button type="submit" variant="secondary" className="h-10" disabled={!a.newAccount.trim() || a.adding}>
                        {a.adding ? <Loader2 className="animate-spin" /> : <Plus />} {t("wizard.addUser")}
                    </Button>
                </form>
                {suggestions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("wizard.accounts.suggestions")}</span>
                        {suggestions.map((s) => (
                            <button
                                key={s}
                                type="button"
                                disabled={a.adding}
                                onClick={() => a.add(s)}
                                className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 font-mono text-xs text-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
                            >
                                <Plus size={11} aria-hidden /> {s}
                                {s === fromKey && <span className="font-sans text-[0.6875rem] text-muted-foreground">· {t("wizard.accounts.fromKey")}</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {a.list.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center">
                    <span className="mb-3 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary" aria-hidden>
                        <Users size={20} />
                    </span>
                    <p className="text-sm font-medium text-foreground">{t("wizard.accounts.emptyTitle")}</p>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                        {tn("wizard.accounts.emptyBody", { whoami: <Code>whoami</Code> })}
                    </p>
                </div>
            ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                    {a.list.map((acc) => (
                        <li key={acc.id} className="flex items-center gap-3 rounded-xl border border-border bg-background/60 px-3 py-2.5 animate-fade-in-up">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                                <UserRound size={16} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-sm font-medium text-foreground">{acc.username}</span>
                                <span className="block truncate text-[0.75rem] text-muted-foreground">{acc.username}@{name}</span>
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => a.remove(acc)}
                                aria-label={t("wizard.accounts.remove", { name: acc.username })}
                                className="text-muted-foreground hover:text-destructive"
                            >
                                <X />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <StepFooter onBack={() => wizard.goTo(1)}>
                {a.list.length === 0 && (
                    <Button type="button" variant="ghost" onClick={() => wizard.setStep(3)} className="text-muted-foreground">
                        {t("wizard.skipForNow")}
                    </Button>
                )}
                <Button type="button" onClick={() => wizard.setStep(3)} disabled={a.list.length === 0}>
                    {t("common.nextStep")} <ChevronRight />
                </Button>
            </StepFooter>
        </div>
    );
}
