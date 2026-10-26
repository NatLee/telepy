"use client";

/**
 * 新增 RustDesk 裝置的對話框：取名 → 拿到一行指令（Linux / macOS / Windows）→ 看著它登記、連上 Telepy。
 * 指令把 RustDesk 的 ID / API 伺服器指到 Telepy、打開 WebSocket，再用一次性權杖 `rustdesk --deploy`。
 * The add-device dialog: name it, run the one command (Linux / macOS / Windows), watch it enrol and connect.
 */
import React, { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Clock, Loader2, MonitorSmartphone, RotateCcw, ScreenShare, ShieldCheck, Terminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { PropertyList, Property } from "@/components/ui/section";
import { CopyLine, Disclosure } from "@/components/tunnels/CreateWizardSteps/parts";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { enrolSteps, guessOs, serverProblemKey, type DeviceOs } from "@/lib/rustdeskDevices";
import { useRustDeskEnrol } from "@/hooks/useRustDeskEnrol";
import type { TranslationKey } from "@/locales/en";

function formatLeft(ms: number): string {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Step({ state, title, detail }: { state: "done" | "active" | "todo"; title: string; detail?: string }) {
    const Icon = state === "done" ? CheckCircle2 : state === "active" ? Loader2 : Circle;
    return (
        <li className="flex gap-3">
            <Icon size={18} className={cn("mt-0.5 shrink-0", state === "done" && "text-success", state === "active" && "animate-spin text-primary", state === "todo" && "text-muted-foreground/40")} aria-hidden />
            <div className="min-w-0">
                <p className={cn("text-sm", state === "todo" ? "text-muted-foreground" : "text-foreground")}>{title}</p>
                {detail && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>}
            </div>
        </li>
    );
}

const OS_HINT: Record<DeviceOs, TranslationKey> = { unix: "rustdesk.enrol.hintUnix", windows: "rustdesk.enrol.hintWindows" };

/** 對話框開著時才掛上（關掉就丟掉狀態，下次重來）。/ Mounted only while open, so closing starts over. */
export function EnrolDialog({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const enrol = useRustDeskEnrol();
    const { form, ticket, expired, msLeft, actions } = enrol;
    const [os, setOs] = useState<DeviceOs>(() => guessOs(typeof navigator !== "undefined" ? navigator : undefined));

    const close = () => {
        void actions.cancel();
        onClose();
    };

    if (!ticket) {
        return (
            <Modal
                isOpen
                onClose={close}
                title={t("rustdesk.enrol.title")}
                description={t("rustdesk.enrol.description")}
                icon={<MonitorSmartphone />}
                size="xl"
                footer={
                    <>
                        <Button variant="outline" onClick={close}>{t("common.cancel")}</Button>
                        <Button onClick={() => void actions.create()} disabled={form.creating}>
                            {form.creating ? <Loader2 className="animate-spin" /> : <Terminal />} {t("rustdesk.enrol.create")}
                        </Button>
                    </>
                }
            >
                <form
                    className="space-y-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void actions.create();
                    }}
                >
                    <Field label={t("rustdesk.enrol.nameLabel")} hint={t("rustdesk.enrol.nameHint")} error={form.nameError ?? undefined}>
                        <Input value={form.name} onChange={(e) => form.setName(e.target.value)} maxLength={64} autoComplete="off" autoFocus />
                    </Field>
                    <Callout tone="info" title={t("rustdesk.enrol.needs")}>
                        <ul className="list-disc space-y-1 pl-5">
                            <li>{t("rustdesk.enrol.need1")}</li>
                            <li>{t("rustdesk.enrol.need2")}</li>
                            <li>{t("rustdesk.enrol.need3")}</li>
                        </ul>
                    </Callout>
                    {form.error && <Callout tone="danger">{form.error}</Callout>}
                </form>
            </Modal>
        );
    }

    const steps = enrolSteps(ticket.phase, expired);
    const command = ticket.commands[os];
    const problem = serverProblemKey(ticket.server.problem);
    const online = ticket.phase === "online";

    return (
        <Modal
            isOpen
            onClose={online ? onClose : close}
            title={t("rustdesk.enrol.title")}
            description={t("rustdesk.enrol.runTitle")}
            icon={<MonitorSmartphone />}
            size="xl"
            footer={
                <>
                    {ticket.phase === "waiting" && !expired && <Button variant="ghost" onClick={close}>{t("rustdesk.enrol.cancel")}</Button>}
                    {(expired || online) && (
                        <Button variant="outline" onClick={actions.reset}>
                            <RotateCcw /> {online ? t("rustdesk.enrol.another") : t("rustdesk.enrol.newCommand")}
                        </Button>
                    )}
                    {online && ticket.device_id ? (
                        <Button asChild>
                            <Link href={`/tunnels/desktop?rustdesk=${ticket.device_id}`} prefetch={false}>
                                <ScreenShare /> {t("rustdesk.enrol.connect")}
                            </Link>
                        </Button>
                    ) : (
                        ticket.phase !== "waiting" && <Button variant="outline" onClick={onClose}>{t("rustdesk.enrol.close")}</Button>
                    )}
                </>
            }
        >
            <div className="space-y-5">
                {problem && <Callout tone="warning" title={t("rustdesk.problem.title")}>{t(problem)}</Callout>}
                {ticket.phase === "waiting" && !expired && (
                    <div className="space-y-3">
                        <Segmented
                            options={[
                                { value: "unix", label: "Linux / macOS" },
                                { value: "windows", label: "Windows" },
                            ]}
                            value={os}
                            onChange={setOs}
                            size="sm"
                            aria-label={t("rustdesk.enrol.osLabel")}
                        />
                        <CopyLine value={command} />
                        <p className="text-xs leading-relaxed text-muted-foreground">{t(OS_HINT[os])}</p>
                        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Clock size={13} aria-hidden /> {t("rustdesk.enrol.expiresIn", { time: formatLeft(msLeft) })}</p>
                        <Disclosure title={t("rustdesk.enrol.whatItDoes")} icon={<ShieldCheck size={15} />}>
                            <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                                <li>{t("rustdesk.enrol.does1")}</li>
                                <li>{t("rustdesk.enrol.does2")}</li>
                                <li>{t("rustdesk.enrol.does3")}</li>
                                <li>{t("rustdesk.enrol.does4")}</li>
                            </ol>
                            <PropertyList className="mt-3">
                                <Property label={t("rustdesk.enrol.idServer")} mono>{ticket.server.rendezvous}</Property>
                                <Property label={t("rustdesk.enrol.apiServer")} mono>{ticket.server.api_server}</Property>
                            </PropertyList>
                        </Disclosure>
                    </div>
                )}
                {expired && <Callout tone="warning">{t("rustdesk.enrol.expired")}</Callout>}
                <ol className="space-y-4 rounded-xl border border-border bg-surface p-4" aria-live="polite">
                    <Step state={steps[0]} title={t("rustdesk.enrol.step1")} />
                    <Step state={steps[1]} title={t("rustdesk.enrol.step2")} detail={ticket.rustdesk_id ? t("rustdesk.enrol.step2Detail", { id: ticket.rustdesk_id }) : undefined} />
                    <Step state={steps[2]} title={t("rustdesk.enrol.step3")} detail={ticket.phase === "enrolled" ? t("rustdesk.enrol.step3Detail") : undefined} />
                </ol>
                {online && <Callout tone="tip">{t("rustdesk.enrol.done", { name: ticket.name ?? ticket.rustdesk_id ?? "" })}</Callout>}
            </div>
        </Modal>
    );
}
