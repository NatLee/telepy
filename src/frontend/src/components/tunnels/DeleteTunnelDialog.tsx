"use client";

/**
 * 刪除隧道。開始前：影響圖（誰失去什麼，DeleteImpactMap）+ 「Telepy 會做的六步」，選項就放在對應的那一步裡（移除服務、
 * 哪些金鑰、每個 MCP app 怎麼處理），關掉的步驟變成「略過」。按下刪除後，同一張六步清單即時亮起來（後端每一步都送
 * `TUNNEL-DELETE-PROGRESS`，等裝置斷線那步有倒數），上面換成 Telepy ─ 裝置的進度圖；做完每一步留下一行結果，
 * 裝置上找到的東西收在第一步的「細節」裡，要 root 的指令單獨列出來。
 * Delete a tunnel. Before: the impact map plus "the six steps Telepy will do", with each option inside the step it
 * belongs to (remove the service, which keys, each MCP app); a step that is off shows as skipped. After Delete the same
 * list lights up live (the backend pushes `TUNNEL-DELETE-PROGRESS`; the waits count down) under a Telepy ─ device
 * diagram; each finished step keeps one line of result, what was found on the device sits in step 1's details and the
 * commands that need root are listed on their own.
 */
import React from "react";
import { Bot, Check, ChevronDown, CircleHelp, Loader2, Server, ShieldCheck, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CopyButton } from "@/components/ui/CopyButton";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Elapsed, ProgressSteps, StepStateLine, type ProgressStep } from "@/components/flow/ProgressSteps";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";
import { activeNumber } from "@/lib/progressSteps";
import type { SpotState } from "@/lib/flow";
import type { StepState } from "@/lib/progressSteps";
import { deleteSteps, deleteVerdict, flowStates, stepLine, type DeleteStepView } from "@/lib/deleteTunnel";
import { useDeleteTunnel, type DeleteCheck, type DeleteCheckGrant, type DeleteOptions, type DeleteReport, type GrantChoice, type ServiceItem, type ServiceRemoval } from "@/hooks/useDeleteTunnel";
import { DeleteImpactMap } from "./DeleteImpactMap";

interface DeleteTunnelDialogProps {
    isOpen: boolean;
    tunnelId: number | null;
    name: string;
    onClose: () => void;
    /** 刪除成功(列表要重抓)。/ Deleted; the list should reload. */
    onDeleted: () => void;
}

export function DeleteTunnelDialog({ isOpen, tunnelId, name, onClose, onDeleted }: DeleteTunnelDialogProps) {
    const { t, tn } = useI18n();
    const d = useDeleteTunnel(tunnelId, isOpen, onDeleted);
    const { check, options, report, phase } = d;
    const strong = <strong>{name}</strong>;
    const running = phase === "running";
    const views = check ? deleteSteps(check.online, options.removeService, report?.steps ?? d.events, phase) : [];
    const current = activeNumber(views);

    return (
        <Modal
            isOpen={isOpen}
            onClose={running ? () => {} : onClose}
            title={report ? t("deleteTunnel.doneTitle") : running ? t("deleteTunnel.runningTitle", { name }) : t("tunnels.deleteTitle")}
            description={report ? tn("deleteTunnel.doneDescription", { name: strong }) : running ? t("deleteTunnel.runningDescription") : tn("deleteTunnel.description", { name: strong })}
            icon={report ? <Check /> : <Trash2 />}
            tone={report ? "default" : "danger"}
            size="4xl"
            isLoading={d.loading}
            footer={
                report ? (
                    <Button type="button" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                ) : (
                    <>
                        {running && d.startedAt && (
                            <span className="mr-auto self-center text-xs text-muted-foreground">
                                <Elapsed since={d.startedAt} />
                            </span>
                        )}
                        <Button type="button" variant="outline" onClick={onClose} disabled={running}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="button" variant="destructive" onClick={d.submit} disabled={!check || running}>
                            {running ? <Loader2 className="animate-spin" /> : <Trash2 />}
                            {running ? (current > 0 ? t("deleteTunnel.runningStep", { n: current, total: views.length }) : t("deleteTunnel.deleting")) : phase === "failed" ? t("deleteTunnel.retry") : t("deleteTunnel.confirm")}
                        </Button>
                    </>
                )
            }
        >
            {d.checkError ? (
                <Callout tone="danger">{d.checkError}</Callout>
            ) : check ? (
                phase === "idle" ? (
                    <PlanView check={check} views={views} options={options} setOption={d.setOption} choiceFor={d.choiceFor} setGrantChoice={d.setGrantChoice} />
                ) : (
                    <RunView check={check} views={views} report={report} tunnelId={tunnelId} />
                )
            ) : (
                <div className="min-h-40" aria-hidden />
            )}
            {!report && d.error && <Callout tone="danger" className="mt-4">{d.error}</Callout>}
        </Modal>
    );
}

/** 步驟的名稱 + 這一行（計畫 / 原因 / 結果）。/ A step's title and its line. */
function useStepText(check: DeleteCheck) {
    const { t } = useI18n();
    const ctx = { keys: check.device_keys.length, lanHosts: check.lan_hosts };
    return (v: DeleteStepView) => {
        const line = stepLine(v, ctx);
        return {
            title: t(`deleteTunnel.step.${v.id}` as TranslationKey),
            line: t(line.key, line.vars),
        };
    };
}

/** 一個小說明按鈕(點開是一段字)。/ A small help button that opens a paragraph. */
function Help({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={label} title={label}>
                    <CircleHelp size={14} aria-hidden />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-2 p-3 text-xs leading-relaxed text-muted-foreground">
                {children}
            </PopoverContent>
        </Popover>
    );
}

/** 步驟裡的一列開關:開關 + 名稱 + 小字。/ A switch row inside a step. */
function OptionRow({ checked, disabled, onChange, label, note }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: React.ReactNode; note?: React.ReactNode }) {
    return (
        <div className={cn("rounded-md border border-border bg-surface px-3 py-2", disabled && "opacity-60")}>
            <Switch size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange}>
                <span className="text-sm text-foreground">{label}</span>
            </Switch>
            {note && <p className="mt-1 pl-11 text-xs leading-relaxed break-words text-muted-foreground">{note}</p>}
        </div>
    );
}

function PlanView({
    check,
    views,
    options,
    setOption,
    choiceFor,
    setGrantChoice,
}: {
    check: DeleteCheck;
    views: DeleteStepView[];
    options: DeleteOptions;
    setOption: <K extends keyof DeleteOptions>(key: K, value: DeleteOptions[K]) => void;
    choiceFor: (g: DeleteCheckGrant) => GrantChoice;
    setGrantChoice: (id: number, choice: GrantChoice) => void;
}) {
    const { t } = useI18n();
    const text = useStepText(check);
    const keyCount = check.device_keys.length;
    const keyNames = check.device_keys.map((k) => `${k.name ?? t("deleteTunnel.keyUnnamed")}${k.owner ? ` (${k.owner})` : ""}${k.in_list ? "" : ` · ${t("deleteTunnel.keyPendingRemoval")}`}`).join(", ");

    const steps: ProgressStep[] = views.map((v) => {
        const base = { id: v.id, state: v.state, ...text(v) };
        switch (v.id) {
            case "service":
                return {
                    ...base,
                    aside: (
                        <Help label={t("deleteTunnel.serviceHelp")}>
                            <p>{t("deleteTunnel.removeServiceHint")}</p>
                            <p>{t("deleteTunnel.removeServiceRoot")}</p>
                        </Help>
                    ),
                    control: (
                        <Switch size="sm" checked={check.online && options.removeService} disabled={!check.online} onCheckedChange={(on) => setOption("removeService", on)} aria-label={t("deleteTunnel.removeService")} />
                    ),
                };
            case "keys":
                return {
                    ...base,
                    children: (
                        <div className="space-y-1.5">
                            {keyCount > 0 ? (
                                <OptionRow
                                    checked={check.online && options.removeDeviceKeys}
                                    disabled={!check.online}
                                    onChange={(on) => setOption("removeDeviceKeys", on)}
                                    label={t("deleteTunnel.removeKeys", { count: keyCount })}
                                    note={keyNames}
                                />
                            ) : (
                                <p className="text-xs text-muted-foreground">{t("deleteTunnel.noKeys")}</p>
                            )}
                            {check.accounts.length > 0 && (
                                <OptionRow
                                    checked={check.online && options.removeServiceKey}
                                    disabled={!check.online}
                                    onChange={(on) => setOption("removeServiceKey", on)}
                                    label={t("deleteTunnel.removeServiceKey", { accounts: check.accounts.join(", ") })}
                                    note={check.last_on_machine ? t("deleteTunnel.removeServiceKeyLast") : t("deleteTunnel.removeServiceKeyOthers", { names: check.same_machine.map((s) => s.name).join(", ") || t("deleteTunnel.anotherTunnel") })}
                                />
                            )}
                            {check.accounts.length > 0 && check.online && (
                                <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                                    <ShieldCheck size={13} aria-hidden />
                                    {t("deleteTunnel.ownKeyRemoved")}
                                </p>
                            )}
                        </div>
                    ),
                };
            case "telepy":
                return check.grants.length > 0 ? { ...base, children: <AppChoices grants={check.grants} choiceFor={choiceFor} setGrantChoice={setGrantChoice} /> } : base;
            default:
                return base;
        }
    });

    return (
        <div className="space-y-6">
            <DeleteImpactMap check={check} options={options} choiceFor={choiceFor} />
            <section className="space-y-2">
                <h3 className="text-sm text-foreground">{t("deleteTunnel.planTitle")}</h3>
                <ProgressSteps steps={steps} planning aria-label={t("deleteTunnel.planTitle")} />
            </section>
        </div>
    );
}

/** 第五步裡每個 MCP app 的選擇。/ Each MCP app's choice, inside step 5. */
function AppChoices({ grants, choiceFor, setGrantChoice }: { grants: DeleteCheckGrant[]; choiceFor: (g: DeleteCheckGrant) => GrantChoice; setGrantChoice: (id: number, choice: GrantChoice) => void }) {
    const { t } = useI18n();
    // 只限這條的「撤銷 / 留著」,涵蓋多條的「只拿掉這條 / 整個撤銷」。/ Single-tunnel apps revoke / keep; multi-tunnel drop this / revoke.
    const grantOptions = (g: DeleteCheckGrant) =>
        g.coverage === "only"
            ? [
                  { value: "revoke" as const, label: t("deleteTunnel.choiceRevoke") },
                  { value: "keep" as const, label: t("deleteTunnel.choiceKeepEmpty") },
              ]
            : [
                  { value: "keep" as const, label: g.coverage === "shared" ? t("deleteTunnel.choiceDropThis") : t("deleteTunnel.choiceKeepOthers") },
                  { value: "revoke" as const, label: t("deleteTunnel.choiceRevokeApp") },
              ];
    const coverageText = (g: DeleteCheckGrant) =>
        g.coverage === "only" ? t("deleteTunnel.coverOnly") : g.coverage === "shared" ? t("deleteTunnel.coverShared", { count: g.other_tunnels }) : t("deleteTunnel.coverAll");
    return (
        <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bot size={13} aria-hidden />
                {t("deleteTunnel.mcpTitle")}
            </p>
            <ul className="divide-y divide-border rounded-md border border-border bg-surface">
                {grants.map((g) => (
                    <li key={g.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0">
                            <span className="block truncate text-sm text-foreground">{g.mine ? g.client_name : t("deleteTunnel.grantOf", { app: g.client_name, user: g.user.username })}</span>
                            <span className="block text-xs text-muted-foreground">{coverageText(g)}</span>
                        </span>
                        {g.can_revoke ? (
                            <Segmented size="sm" options={grantOptions(g)} value={choiceFor(g)} onChange={(v) => setGrantChoice(g.id, v)} aria-label={t("deleteTunnel.choiceFor", { app: g.client_name })} />
                        ) : (
                            <span className="text-xs text-muted-foreground sm:max-w-56 sm:text-right">{t("deleteTunnel.choiceNotYours", { user: g.user.username })}</span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

const SPOT: Record<StepState, SpotState> = { waiting: "waiting", skipped: "waiting", active: "active", done: "ok", warn: "ok", failed: "failed" };

/** 刪除進行中 / 做完的圖:Telepy ─ 隧道 ─ 裝置(裡面:跑隧道的服務、authorized_keys)。/ The live diagram. */
function DeleteFlow({ check, views }: { check: DeleteCheck; views: DeleteStepView[] }) {
    const { t } = useI18n();
    const f = flowStates(views);
    const deviceState: SpotState = f.service === "failed" || f.keys === "failed" ? "failed" : f.service === "active" || f.keys === "active" ? "active" : f.link === "done" ? "ok" : "waiting";
    const part = (state: StepState, prefix: "service" | "keys") => t(`deleteTunnel.flow.${prefix}.${state}` as TranslationKey);
    return (
        <FlowPath>
            <FlowNode brand title="Telepy" sub={t("deleteTunnel.flow.telepySub")} state={SPOT[f.telepy]} stateText={t(`deleteTunnel.flow.telepy.${f.telepy}` as TranslationKey)} />
            <FlowLink label={f.link === "done" ? t("deleteTunnel.flow.linkCut") : t("deleteTunnel.flow.link", { port: check.tunnel.reverse_port })} state={f.link === "done" ? "waiting" : f.link === "active" ? "active" : "ok"} />
            <FlowNode
                icon={Server}
                wide
                title={check.tunnel.name}
                state={deviceState}
                stateText={f.link === "done" ? t(check.online ? "deleteTunnel.flow.deviceDone" : "deleteTunnel.flow.deviceRefused") : check.online ? undefined : t("deleteTunnel.mapOffline")}
                control={
                    <ul className="space-y-1.5">
                        <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                            <span className="text-xs text-muted-foreground">{t("deleteTunnel.mapService")}</span>
                            <StepStateLine state={f.service} text={part(f.service, "service")} />
                        </li>
                        <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                            <span className="font-mono text-xs text-muted-foreground">authorized_keys</span>
                            <StepStateLine state={f.keys} text={part(f.keys, "keys")} />
                        </li>
                    </ul>
                }
            />
        </FlowPath>
    );
}

function RunView({ check, views, report, tunnelId }: { check: DeleteCheck; views: DeleteStepView[]; report: DeleteReport | null; tunnelId: number | null }) {
    const { t, tn } = useI18n();
    const text = useStepText(check);
    const script = <code>{check.uninstall_script ?? `~/.ssh/telepy-uninstall-${tunnelId ?? ""}.sh`}</code>;
    const verdict = report ? deleteVerdict(views) : null;
    const service = report?.service ?? null;
    const roots = service ? service.accounts.flatMap((a) => a.items.filter((i) => i.kind === "needs_root").map((i) => ({ account: a.account, detail: i.detail }))) : [];
    const failedAccounts = report?.accounts.filter((a) => a.error) ?? [];

    const steps: ProgressStep[] = views.map((v) => {
        const base: ProgressStep = { id: v.id, state: v.state, event: v.event, ...text(v) };
        if (v.id === "service" && service && v.state !== "active" && v.state !== "waiting") return { ...base, children: <ServiceDetails service={service} /> };
        if (v.id === "keys" && failedAccounts.length > 0)
            return {
                ...base,
                children: (
                    <ul className="space-y-1">
                        {failedAccounts.map((a) => (
                            <li key={a.account} className="text-xs">
                                <span className="text-foreground">{tn("deleteTunnel.doneAccountFailed", { account: <code>{a.account}</code> })}</span>
                                <span className="block break-words text-muted-foreground">{a.error}</span>
                            </li>
                        ))}
                    </ul>
                ),
            };
        return base;
    });

    return (
        <div className="space-y-5">
            <DeleteFlow check={check} views={views} />
            {verdict && <Callout tone={verdict.tone}>{tn(verdict.key, { script })}</Callout>}
            <ProgressSteps steps={steps} aria-label={t("deleteTunnel.planTitle")} />
            {roots.length > 0 && (
                <Callout tone="warning" title={t("deleteTunnel.svcNeedsRoot")}>
                    <ul className="mt-1 space-y-1.5">
                        {roots.map((r, i) => (
                            <li key={i} className="flex items-start gap-2">
                                <code className="min-w-0 flex-1 break-all text-xs">{r.detail}</code>
                                <CopyButton value={r.detail} />
                            </li>
                        ))}
                    </ul>
                </Callout>
            )}
        </div>
    );
}

/** 腳本回報的 `what` → 顯示名稱;沒對應的照原樣。/ Display names for the script's `what`. */
const SERVICE_WHAT: Record<string, TranslationKey> = {
    systemd: "deleteTunnel.svc.systemd",
    "systemd-user": "deleteTunnel.svc.systemdUser",
    launchd: "deleteTunnel.svc.launchd",
    cron: "deleteTunnel.svc.cron",
    loop: "deleteTunnel.svc.loop",
    process: "deleteTunnel.svc.process",
    script: "deleteTunnel.svc.script",
    docker: "deleteTunnel.svc.docker",
    task: "deleteTunnel.svc.task",
    service: "deleteTunnel.svc.service",
    "run-key": "deleteTunnel.svc.runKey",
    startup: "deleteTunnel.svc.startup",
    join: "deleteTunnel.svc.join",
    file: "deleteTunnel.svc.file",
    unit: "deleteTunnel.svc.unit",
    key: "deleteTunnel.svc.key",
    log: "deleteTunnel.svc.log",
    stop: "deleteTunnel.svc.stop",
    journal: "deleteTunnel.svc.journal",
};

/** 細節只列這幾種(要 root 的另外列在下面)。/ The kinds listed in the details (needs-root ones are listed below the steps). */
const SERVICE_KINDS: { kind: string; label: TranslationKey; state: StepState }[] = [
    { kind: "found", label: "deleteTunnel.svcFound", state: "waiting" },
    { kind: "removed", label: "deleteTunnel.svcRemoved", state: "done" },
    { kind: "scheduled", label: "deleteTunnel.svcScheduled", state: "done" },
    { kind: "failed", label: "deleteTunnel.svcFailed", state: "failed" },
    { kind: "kept", label: "deleteTunnel.svcKept", state: "skipped" },
    { kind: "note", label: "deleteTunnel.svcNote", state: "skipped" },
];

/** 第一步的細節:每個帳號找到、刪掉、留著的東西(收起來)。/ Step 1's details per account, folded. */
function ServiceDetails({ service }: { service: ServiceRemoval }) {
    const { t } = useI18n();
    const what = (i: ServiceItem) => (SERVICE_WHAT[i.what] ? t(SERVICE_WHAT[i.what]) : i.what);
    return (
        <details className="group rounded-md border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                <ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden />
                {t("deleteTunnel.serviceDetails")}
            </summary>
            <div className="space-y-2 border-t border-border px-3 py-2">
                {service.accounts.map((a) => {
                    const shown = SERVICE_KINDS.map((k) => ({ ...k, items: a.items.filter((i) => i.kind === k.kind) })).filter((k) => k.items.length > 0);
                    return (
                        <div key={a.account} className="space-y-1">
                            <p className="flex items-center gap-2 text-xs">
                                <code className="text-foreground">{a.account}</code>
                                {a.os && <span className="text-muted-foreground">{a.os}</span>}
                            </p>
                            {a.error && <p className="text-xs text-destructive">{a.error}</p>}
                            {!a.error && shown.length === 0 && <p className="text-xs text-muted-foreground">{t("deleteTunnel.svcNothingHere")}</p>}
                            {shown.map((k) => (
                                <div key={k.kind}>
                                    <StepStateLine state={k.state} text={t(k.label)} />
                                    <ul className="mt-0.5 space-y-0.5 pl-4">
                                        {k.items.map((i, n) => (
                                            <li key={n} className="flex items-start gap-2 text-xs">
                                                <span className="shrink-0 text-foreground">{what(i)}</span>
                                                <span className="min-w-0 flex-1 break-all font-mono leading-5 text-muted-foreground line-clamp-2" title={i.detail}>{i.detail}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </details>
    );
}
