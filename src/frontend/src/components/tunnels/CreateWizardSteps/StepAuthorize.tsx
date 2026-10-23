/**
 * 建立精靈 Step 3：把 Telepy 服務金鑰（與你自己的金鑰）附加到裝置帳號的 authorized_keys。
 * 一條指令搞定（Linux/macOS 或 Windows PowerShell），只附加、可重跑。
 * Wizard step 3: append Telepy's service key (and your own keys) to authorized_keys of the device accounts —
 * one command (Linux/macOS or Windows PowerShell), append-only and safe to re-run.
 */
"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Info, KeyRound, Laptop, Lock, ServerCog, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { authorizeKeysCommand, checkPublicKey } from "@/lib/tunnelSetup";
import type { CreateTunnelWizard, PublicKeyItem } from "@/hooks/useCreateTunnelWizard";
import { Code, Segmented, StepFooter, StepHeading, useCopy } from "./parts";

function KeyRow({ item, kind, included, onToggle }: {
    item: PublicKeyItem;
    kind: "service" | "user";
    included: boolean;
    onToggle?: () => void;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const { copied, copy } = useCopy();
    const parsed = checkPublicKey(item.key);
    const Icon = kind === "service" ? ServerCog : Laptop;
    return (
        <li className={cn("rounded-xl border bg-background/60 transition-colors", included ? "border-border" : "border-dashed border-border/70")}>
            <div className="flex items-center gap-3 px-3 py-2.5">
                {kind === "service" ? (
                    <span className="grid size-5 place-items-center rounded-md bg-primary text-primary-foreground" title={t("wizard.authorize.required")}>
                        <Lock size={11} aria-hidden />
                    </span>
                ) : (
                    <input
                        type="checkbox"
                        checked={included}
                        onChange={onToggle}
                        aria-label={t("wizard.authorize.includeKey", { name: item.name })}
                        className="size-4 accent-primary"
                    />
                )}
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", kind === "service" ? "bg-primary text-primary-foreground" : "bg-info/12 text-info")} aria-hidden>
                    <Icon size={15} />
                </span>
                <span className={cn("min-w-0 flex-1", !included && "opacity-60")}>
                    <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
                        {kind === "service" && (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[0.6875rem] font-semibold text-primary">{t("wizard.authorize.required")}</span>
                        )}
                    </span>
                    <span className="block truncate font-mono text-[0.75rem] text-muted-foreground">
                        {parsed.kind === "valid" ? `${parsed.algo} …${parsed.tail}` : item.key.slice(0, 24)}
                        {" · "}
                        {kind === "service" ? t("wizard.authorize.serviceUse") : t("wizard.authorize.userUse")}
                    </span>
                </span>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => copy(item.key)} aria-label={t("wizard.authorize.copyKey", { name: item.name })}>
                    {copied ? <Check className="text-primary" /> : <Copy />}
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("wizard.authorize.showKey", { name: item.name })}>
                    <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
                </Button>
            </div>
            {open && (
                <pre className="mx-3 mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2.5 font-mono text-[0.75rem] leading-relaxed text-foreground/85">
                    {item.key}
                </pre>
            )}
        </li>
    );
}

export function StepAuthorize({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t, tn } = useI18n();
    const k = wizard.keys;
    const accounts = wizard.accounts.list;
    const name = wizard.created?.name ?? "";
    const review = wizard.review[3];
    const command = useMemo(() => authorizeKeysCommand(k.authorizedKeys, k.deviceOs), [k.authorizedKeys, k.deviceOs]);

    return (
        <div className="space-y-6">
            <StepHeading title={t("wizard.authorize.title")} subtitle={tn("wizard.authorize.subtitle", { path: <Code>~/.ssh/authorized_keys</Code> })} />

            {/* 自從上次按「我已經執行了」後又加了帳號 / 改了金鑰：要再跑一次。/ Accounts or keys changed since "I've run it": run it again. */}
            {review && (
                <Callout tone="warning">
                    {review.kind === "accountsAdded"
                        ? tn("wizard.authorize.rerunAccounts", { names: <Code>{review.names.join(", ")}</Code> })
                        : t("wizard.authorize.rerunKeys")}
                </Callout>
            )}

            <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                        <span>{tn("wizard.authorize.runOn", { name: <strong>{name}</strong> })}</span>
                        {accounts.length > 0 ? (
                            accounts.map((acc) => {
                                const fresh = k.newSinceAuthorize.includes(acc.username);
                                return (
                                    <span
                                        key={acc.id}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs",
                                            fresh ? "bg-warning/15 text-foreground ring-1 ring-inset ring-warning/50" : "bg-primary/10 text-primary"
                                        )}
                                    >
                                        <UserRound size={11} aria-hidden /> {acc.username}
                                        {fresh && <span className="font-sans text-[0.6875rem] text-foreground/70">· {t("wizard.authorize.new")}</span>}
                                    </span>
                                );
                            })
                        ) : (
                            <span className="text-muted-foreground">{t("wizard.authorize.runAsAny")}</span>
                        )}
                    </p>
                    <Segmented
                        value={k.deviceOs}
                        onChange={k.setDeviceOs}
                        ariaLabel={t("wizard.osAria")}
                        options={[{ value: "unix", label: t("wizard.osUnix") }, { value: "windows", label: "Windows" }]}
                    />
                </div>

                {k.loading && !command ? (
                    <div className="h-40 animate-pulse rounded-md bg-muted" />
                ) : command ? (
                    <CodeBlock language={k.deviceOs === "windows" ? "powershell" : "bash"} value={command} />
                ) : (
                    <Callout tone="warning">{t("wizard.noServiceKeys")}</Callout>
                )}

                <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    <li className="flex gap-2">
                        <Info size={13} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                        <span>{t("wizard.authorize.appendOnly")}</span>
                    </li>
                    {accounts.length > 1 && (
                        <li className="flex gap-2">
                            <Info size={13} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                            <span>{tn("wizard.authorize.eachAccount", { su: <Code>sudo -iu {accounts[1].username}</Code> })}</span>
                        </li>
                    )}
                    {k.deviceOs === "windows" && (
                        <li className="flex gap-2">
                            <Info size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                            <span>{tn("wizard.authorize.windowsAdmin", { path: <Code>C:\ProgramData\ssh\administrators_authorized_keys</Code> })}</span>
                        </li>
                    )}
                </ul>
            </div>

            <div className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-sm text-foreground [&>svg]:text-muted-foreground">
                    <KeyRound size={13} aria-hidden /> {t("wizard.authorize.keysIncluded", { n: k.authorizedKeys.length })}
                </h3>
                <ul className="space-y-2">
                    {k.serviceKeys.map((item) => <KeyRow key={`s${item.id}`} item={item} kind="service" included />)}
                    {!k.keysInstalledByTelepy &&
                        k.userKeys.map((item) => (
                            <KeyRow key={`u${item.id}`} item={item} kind="user" included={!k.excludedUserKeys.has(item.id)} onToggle={() => k.toggleUserKey(item.id)} />
                        ))}
                </ul>
                {k.keysInstalledByTelepy && (
                    <p className="flex flex-wrap items-start gap-1.5 rounded-xl border border-primary/20 bg-primary/6 p-3 text-xs leading-relaxed text-foreground/85">
                        <Laptop size={14} className="mt-px shrink-0 text-primary" aria-hidden />
                        <span className="min-w-0 flex-1">
                            {t("wizard.authorize.userKeysAuto", { n: k.userKeys.length })}{" "}
                            {wizard.created && (
                                <Link href={`/tunnels/keys?device=${wizard.created.id}`} target="_blank" prefetch={false} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                                    {t("wizard.authorize.manageKeys")} <ExternalLink size={11} aria-hidden />
                                </Link>
                            )}
                        </span>
                    </p>
                )}
                {!k.loading && k.userKeys.length === 0 && (
                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <Laptop size={13} aria-hidden /> {t("wizard.authorize.noUserKeys")}
                        <Link href="/tunnels/keys" target="_blank" prefetch={false} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                            {t("wizard.authorize.addUserKey")} <ExternalLink size={11} aria-hidden />
                        </Link>
                    </p>
                )}
            </div>

            <StepFooter onBack={() => wizard.goTo(2)}>
                <Button type="button" onClick={k.markAuthorized}>
                    {review ? t("wizard.authorize.doneAgain") : t("wizard.authorize.done")} <ChevronRight />
                </Button>
            </StepFooter>
        </div>
    );
}
