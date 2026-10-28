/**
 * 建立精靈 Step 1：裝置的公鑰、名稱、sshd 埠。送出即建立通道；建立後變成唯讀摘要。
 * Wizard step 1: the device's public key, name and sshd port. Submitting creates the tunnel; afterwards it is a
 * read-only summary.
 */
"use client";

import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Fingerprint, KeyRound, Laptop, Loader2, Lock, ShieldAlert } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TunnelNameHelp } from "@/components/tunnels/TunnelNameHelp";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { CreateTunnelWizard } from "@/hooks/useCreateTunnelWizard";
import type { DeviceOs } from "@/lib/tunnelSetup";
import { Code, CopyLine, FieldError, Segmented, StepFooter, StepHeading } from "./parts";

const FIND_KEY: Record<DeviceOs, { show: string; generate: string }> = {
    unix: { show: "cat ~/.ssh/id_ed25519.pub", generate: "ssh-keygen -t ed25519" },
    windows: { show: "type $env:USERPROFILE\\.ssh\\id_ed25519.pub", generate: "ssh-keygen -t ed25519" },
};

export function StepDevice({ wizard }: { wizard: CreateTunnelWizard }) {
    const { t, tn } = useI18n();
    const { created } = wizard;
    const d = wizard.device;
    const [os, setOs] = useState<DeviceOs>("unix");

    if (created) {
        return (
            <form onSubmit={d.submitDevice} className="space-y-6">
                <StepHeading title={t("wizard.device.createdTitle")} subtitle={t("wizard.device.createdBody")} />
                <div className="flex items-start gap-3 rounded-xl border border-success/25 bg-success/[0.06] p-4">
                    <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success" aria-hidden />
                    <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                        <dt className="text-muted-foreground">{t("wizard.device.name")}</dt>
                        <dd className="truncate font-medium text-foreground">{created.name}</dd>
                        <dt className="text-muted-foreground">{t("wizard.device.reservedPort")}</dt>
                        <dd className="font-mono text-foreground">{created.reversePort}</dd>
                        {d.keyCheck.kind === "valid" && (
                            <>
                                <dt className="text-muted-foreground">{t("wizard.device.key")}</dt>
                                <dd className="truncate font-mono text-xs leading-5 text-foreground">{d.keyCheck.algo} …{d.keyCheck.tail}</dd>
                            </>
                        )}
                    </dl>
                    <Lock size={14} className="mt-1 shrink-0 text-muted-foreground" aria-label={t("wizard.device.locked")} />
                </div>
                <StepFooter>
                    <Button type="submit">{t("common.nextStep")} <ChevronRight /></Button>
                </StepFooter>
            </form>
        );
    }

    const kc = d.keyCheck;
    return (
        <form onSubmit={d.submitDevice} className="space-y-6" noValidate>
            <StepHeading title={t("wizard.device.title")} subtitle={t("wizard.device.subtitle")} />

            {/* 去哪裡找公鑰 / Where to find the key */}
            <div className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <Fingerprint size={14} className="text-primary" aria-hidden />
                        {t("wizard.device.findKeyTitle")}
                    </p>
                    <Segmented
                        value={os}
                        onChange={setOs}
                        ariaLabel={t("wizard.osAria")}
                        options={[{ value: "unix", label: t("wizard.osUnix") }, { value: "windows", label: "Windows" }]}
                    />
                </div>
                <CopyLine value={FIND_KEY[os].show} />
                <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                    {tn("wizard.device.findKeyNoKey", { cmd: <Code>{FIND_KEY[os].generate}</Code> })}
                </p>
            </div>

            <div className="space-y-1.5">
                <label htmlFor="wizard-key" className="block text-sm font-medium text-foreground">
                    {t("wizard.device.key")} <span className="text-destructive">*</span>
                </label>
                <textarea
                    id="wizard-key"
                    rows={4}
                    value={d.sshKey}
                    onChange={(e) => d.onKeyChange(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!d.errors.key || kc.kind === "private" || undefined}
                    aria-describedby="wizard-key-status"
                    placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… user@device"
                    className={cn(
                        "block w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground dark:bg-input/30",
                        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        "aria-invalid:border-destructive aria-invalid:ring-destructive/20"
                    )}
                />
                <div id="wizard-key-status" className="min-h-5">
                    {kc.kind === "valid" && !d.errors.key && (
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-success">
                            <CheckCircle2 size={14} aria-hidden />
                            <span className="rounded bg-success/12 px-1.5 py-0.5 font-mono font-semibold">{kc.algo}</span>
                            {kc.comment && <span className="font-mono text-foreground/80">{kc.comment}</span>}
                            <span className="font-mono text-muted-foreground">…{kc.tail}</span>
                        </p>
                    )}
                    {kc.kind === "private" && (
                        <Callout tone="danger" role="alert" icon={<ShieldAlert size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                            {t("wizard.device.keyPrivate")}
                        </Callout>
                    )}
                    {kc.kind === "invalid" && !d.errors.key && (
                        <p className="flex items-center gap-1.5 text-xs text-warning">
                            <AlertTriangle size={14} aria-hidden /> {t("wizard.device.keyInvalid")}
                        </p>
                    )}
                    {kc.kind !== "private" && <FieldError>{d.errors.key}</FieldError>}
                    {/* 貼的是自己的個人金鑰：可以，但只適合「這台就是你平常用的電腦」。/ Your own personal key: fine only for the computer you work from. */}
                    {kc.kind === "valid" && !d.errors.key && d.ownPersonalKey && (
                        <Callout tone="info" className="mt-2" icon={<Laptop size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                            {t("wizard.device.keyOwnPersonal", { name: d.ownPersonalKey })}
                        </Callout>
                    )}
                    {kc.kind === "empty" && !d.errors.key && (
                        <p className="text-xs text-muted-foreground">{t("wizard.device.keyHelper")}</p>
                    )}
                </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <div className="space-y-1.5">
                    <label htmlFor="wizard-name" className="block text-sm font-medium text-foreground">
                        {t("wizard.device.name")} <span className="text-destructive">*</span>
                    </label>
                    <Input
                        id="wizard-name"
                        value={d.hostName}
                        onChange={(e) => d.onNameChange(e.target.value)}
                        placeholder={t("wizard.hostNamePlaceholder")}
                        aria-invalid={!!d.errors.name || undefined}
                        aria-describedby="wizard-name-help"
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 font-mono"
                    />
                    {/* 名稱會變成 ssh 的主機名稱：規則一直看得到，打錯當下就說。/ The name becomes the ssh host name: rules always shown. */}
                    <TunnelNameHelp id="wizard-name-help" value={d.hostName} error={d.errors.name} onUse={d.onNameChange} />
                </div>
                <div className="space-y-1.5">
                    <label htmlFor="wizard-port" className="block text-sm font-medium text-foreground">{t("wizard.device.port")}</label>
                    <Input
                        id="wizard-port"
                        inputMode="numeric"
                        value={d.sshPort}
                        onChange={(e) => d.onPortChange(e.target.value)}
                        placeholder="22"
                        aria-invalid={!!d.errors.port || undefined}
                        className="h-10 font-mono"
                    />
                    {d.errors.port ? <FieldError>{d.errors.port}</FieldError> : <p className="text-xs text-muted-foreground">{t("wizard.device.portHelper")}</p>}
                </div>
            </div>

            {/* 裝置金鑰清單的起點 / Where the device key list starts */}
            <fieldset className="space-y-2">
                <legend className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <KeyRound size={14} className="text-primary" aria-hidden /> {t("wizard.device.keyListTitle")}
                </legend>
                {d.myKeyCount === 0 ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("wizard.device.keyListNoKeys")}</p>
                ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                        {(["mine", "empty"] as const).map((v) => (
                            <label
                                key={v}
                                className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-muted/40 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/6"
                            >
                                <input
                                    type="radio"
                                    name="wizard-key-list"
                                    value={v}
                                    checked={d.keyList === v}
                                    onChange={() => d.setKeyList(v)}
                                    className="mt-0.5 size-4 accent-primary"
                                />
                                <span className="min-w-0">
                                    <span className="block text-sm text-foreground">
                                        {v === "mine" ? t("wizard.device.keyListMine", { n: d.myKeyCount ?? "…" }) : t("wizard.device.keyListEmpty")}
                                    </span>
                                    <span className="block text-xs leading-relaxed text-muted-foreground">
                                        {v === "mine" ? t("wizard.device.keyListMineHint") : t("wizard.device.keyListEmptyHint")}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}
            </fieldset>

            <StepFooter>
                <Button type="submit" disabled={d.creating || kc.kind === "private"} className="">
                    {d.creating ? <Loader2 className="animate-spin" /> : null}
                    {d.creating ? t("wizard.device.creating") : t("wizard.device.create")}
                    {!d.creating && <ChevronRight />}
                </Button>
            </StepFooter>
        </form>
    );
}
