"use client";

/**
 * 刪除隧道:先用影響圖畫出會斷掉哪些連線、每樣東西的下場(DeleteImpactMap),再讓使用者決定裝置上的金鑰
 * (Telepy 裝過的、服務金鑰)與每個 AI app 怎麼處理(只拿掉這條隧道,或整個撤銷);圖跟著選項即時變。
 * 刪完在同一個對話框顯示清理結果(數字 + 逐項)。
 * Delete a tunnel: an impact map shows which links are cut and what happens to everything, then the user
 * decides about keys on the device and, per AI app, whether to drop only this tunnel or revoke the app;
 * the map follows the choices live. The same dialog then shows what was cleaned (totals + details).
 */
import React from "react";
import { Bot, Check, CircleAlert, CircleCheck, Info, KeyRound, Loader2, RefreshCw, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { CopyButton } from "@/components/ui/CopyButton";
import { cn } from "@/lib/utils";
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

type Tone = "neutral" | "warning" | "success" | "danger";

const TONE_ICON: Record<Tone, React.ReactNode> = {
    neutral: <Info size={15} className="text-muted-foreground" />,
    warning: <TriangleAlert size={15} className="text-warning" />,
    success: <CircleCheck size={15} className="text-success" />,
    danger: <CircleAlert size={15} className="text-destructive" />,
};

/** 一行結果:圖示 + 文字(+ 細節)。/ One result line. */
function Line({ tone = "neutral", children, detail }: { tone?: Tone; children: React.ReactNode; detail?: React.ReactNode }) {
    return (
        <li className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm">
            <span className="mt-0.5 shrink-0" aria-hidden>{TONE_ICON[tone]}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-foreground">{children}</span>
                {detail && <span className="mt-1 block break-words text-xs text-muted-foreground">{detail}</span>}
            </span>
        </li>
    );
}

/** 勾選項:整張卡片可點,停用時變淡。/ A checkbox option card; dimmed when disabled. */
function Option({
    checked,
    disabled,
    onChange,
    title,
    description,
    children,
}: {
    checked: boolean;
    disabled?: boolean;
    onChange: (v: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <label
            className={cn(
                "flex items-start gap-3 rounded-lg border border-border px-3.5 py-3 transition-colors",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/40 has-[:checked]:border-destructive/40 has-[:checked]:bg-destructive/5",
            )}
        >
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-destructive" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{title}</span>
                {description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>}
                {children}
            </span>
        </label>
    );
}

export function DeleteTunnelDialog({ isOpen, tunnelId, name, onClose, onDeleted }: DeleteTunnelDialogProps) {
    const { t, tn } = useI18n();
    const { check, checkError, loading, options, setOption, choiceFor, setGrantChoice, deleting, error, report, submit } = useDeleteTunnel(tunnelId, isOpen, onDeleted);
    const strong = <strong>{name}</strong>;

    const removesService = !!check?.online && options.removeService;
    const touchesDevice = !!check?.online && ((options.removeDeviceKeys && check.device_keys.length > 0) || options.removeServiceKey);

    return (
        <Modal
            isOpen={isOpen}
            onClose={deleting ? () => {} : onClose}
            title={report ? t("deleteTunnel.doneTitle") : t("tunnels.deleteTitle")}
            description={report ? tn("deleteTunnel.doneDescription", { name: strong }) : tn("deleteTunnel.description", { name: strong })}
            icon={report ? <Check /> : <Trash2 />}
            tone={report ? "default" : "danger"}
            size="4xl"
            isLoading={loading}
            footer={
                report ? (
                    <Button type="button" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                ) : (
                    <>
                        <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="button" variant="destructive" onClick={submit} disabled={!check || deleting}>
                            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                            {deleting ? (removesService ? t("deleteTunnel.removingService") : touchesDevice ? t("deleteTunnel.cleaningDevice") : t("deleteTunnel.deleting")) : t("deleteTunnel.confirm")}
                        </Button>
                    </>
                )
            }
        >
            {report ? (
                <ReportView report={report} tunnelId={tunnelId} />
            ) : checkError ? (
                <Callout tone="danger">{checkError}</Callout>
            ) : check ? (
                <CheckView check={check} options={options} setOption={setOption} choiceFor={choiceFor} setGrantChoice={setGrantChoice} />
            ) : (
                <div className="min-h-40" aria-hidden />
            )}
            {!report && error && <Callout tone="danger" className="mt-4">{error}</Callout>}
        </Modal>
    );
}

function CheckView({
    check,
    options,
    setOption,
    choiceFor,
    setGrantChoice,
}: {
    check: DeleteCheck;
    options: DeleteOptions;
    setOption: <K extends keyof DeleteOptions>(key: K, value: DeleteOptions[K]) => void;
    choiceFor: (g: DeleteCheckGrant) => GrantChoice;
    setGrantChoice: (id: number, choice: GrantChoice) => void;
}) {
    const { t, tn } = useI18n();
    const keyCount = check.device_keys.length;

    // 每個 app 的兩個選項:只限這條的「撤銷 / 留著」,涵蓋多條的「只拿掉這條 / 整個撤銷」。
    // Per-app options: single-tunnel apps revoke / keep; multi-tunnel apps drop this tunnel / revoke.
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
        <div className="space-y-6">
            {/* 影響圖 / Impact map */}
            <DeleteImpactMap check={check} options={options} choiceFor={choiceFor} />

            <Callout tone="info">
                {check.online && options.removeService
                    ? t("deleteTunnel.serviceWillGo")
                    : tn("deleteTunnel.deviceRetries", { script: <code>{`~/.ssh/telepy-uninstall-${check.tunnel.id}.sh`}</code> })}{" "}
                {t("deleteTunnel.historyKept")}
            </Callout>

            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <SlidersHorizontal size={14} aria-hidden />
                {t("deleteTunnel.mapFollows")}
            </p>

            {/* 你的選擇:裝置上跑隧道的服務 / Your choices: the tunnel service on the device */}
            <Section icon={<RefreshCw />} title={t("deleteTunnel.serviceTitle")} description={t("deleteTunnel.serviceDescription")}>
                <Option
                    checked={check.online && options.removeService}
                    disabled={!check.online}
                    onChange={(v) => setOption("removeService", v)}
                    title={t("deleteTunnel.removeService")}
                    description={check.online ? t("deleteTunnel.removeServiceHint") : t("deleteTunnel.serviceOffline")}
                >
                    {check.online && <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">{t("deleteTunnel.removeServiceRoot")}</span>}
                </Option>
            </Section>

            {/* 你的選擇:裝置上的金鑰 / Your choices: keys on the device */}
            <Section icon={<KeyRound />} title={t("deleteTunnel.keysTitle")} description={t("deleteTunnel.keysDescription")}>
                {!check.online && (keyCount > 0 || check.accounts.length > 0) && <Callout tone="warning">{t("deleteTunnel.keysOffline")}</Callout>}
                {keyCount > 0 ? (
                    <Option
                        checked={check.online && options.removeDeviceKeys}
                        disabled={!check.online}
                        onChange={(v) => setOption("removeDeviceKeys", v)}
                        title={t("deleteTunnel.removeKeys", { count: keyCount })}
                        description={check.online ? t("deleteTunnel.removeKeysHint") : undefined}
                    >
                        <ul className="mt-2 space-y-1">
                            {check.device_keys.map((k) => (
                                <li key={k.fingerprint} className="text-xs text-muted-foreground">
                                    <span className="text-foreground">{k.name ?? t("deleteTunnel.keyUnnamed")}</span>
                                    {k.owner && ` · ${k.owner}`}
                                    {!k.in_list && ` · ${t("deleteTunnel.keyPendingRemoval")}`}
                                    <span className="block break-all font-mono">{k.fingerprint}</span>
                                </li>
                            ))}
                        </ul>
                    </Option>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("deleteTunnel.noKeys")}</p>
                )}
                {check.accounts.length > 0 && (
                    <Option
                        checked={check.online && options.removeServiceKey}
                        disabled={!check.online}
                        onChange={(v) => setOption("removeServiceKey", v)}
                        title={t("deleteTunnel.removeServiceKey", { accounts: check.accounts.join(", ") })}
                        description={check.last_on_machine
                            ? t("deleteTunnel.removeServiceKeyLast")
                            : t("deleteTunnel.removeServiceKeyOthers", { names: check.same_machine.map((s) => s.name).join(", ") || t("deleteTunnel.anotherTunnel") })}
                    />
                )}
                {check.accounts.length > 0 && check.online && <p className="text-xs text-muted-foreground">{t("deleteTunnel.ownKeyRemoved")}</p>}
            </Section>

            {/* 你的選擇:每個 AI app / Your choices: each AI app */}
            {check.grants.length > 0 && (
                <Section icon={<Bot />} title={t("deleteTunnel.mcpTitle")} description={t("deleteTunnel.mcpDescription")}>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {check.grants.map((g) => (
                            <li key={g.id} className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <span className="min-w-0">
                                    <span className="block truncate text-sm text-foreground">
                                        {g.mine ? g.client_name : t("deleteTunnel.grantOf", { app: g.client_name, user: g.user.username })}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">{coverageText(g)}</span>
                                </span>
                                {g.can_revoke ? (
                                    <Segmented
                                        size="sm"
                                        options={grantOptions(g)}
                                        value={choiceFor(g)}
                                        onChange={(v) => setGrantChoice(g.id, v)}
                                        aria-label={t("deleteTunnel.choiceFor", { app: g.client_name })}
                                    />
                                ) : (
                                    <span className="text-xs text-muted-foreground sm:max-w-56 sm:text-right">{t("deleteTunnel.choiceNotYours", { user: g.user.username })}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </Section>
            )}
        </div>
    );
}

function Stat({ value, label, tone }: { value: React.ReactNode; label: string; tone: Tone }) {
    return (
        <div className="min-w-0 px-3 py-2.5">
            <dd className={cn("text-xl tabular-nums", tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-foreground")}>{value}</dd>
            <dt className="truncate text-xs text-muted-foreground">{label}</dt>
        </div>
    );
}

function ReportView({ report, tunnelId }: { report: DeleteReport; tunnelId: number | null }) {
    const { t, tn } = useI18n();
    const removed = report.accounts.reduce((n, a) => n + a.removed, 0);
    const failed = report.accounts.filter((a) => a.error).length;
    const apps = report.grants_revoked + report.grants_detached;
    return (
        <div className="space-y-4">
            {/* 數字 / Totals */}
            <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border [&>div]:bg-surface", report.service ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
                {report.service && (
                    <Stat
                        value={report.service.stopped && !report.service.came_back ? "✓" : "!"}
                        label={t("deleteTunnel.statService")}
                        tone={report.service.stopped && !report.service.came_back ? "success" : "warning"}
                    />
                )}
                <Stat value={removed} label={t("deleteTunnel.statKeysRemoved")} tone={removed > 0 ? "success" : "neutral"} />
                <Stat value={report.keys_left} label={t("deleteTunnel.statKeysLeft")} tone={report.keys_left > 0 ? "warning" : "neutral"} />
                <Stat value={apps} label={t("deleteTunnel.statApps")} tone={apps > 0 ? "success" : "neutral"} />
                <Stat value={report.ai_sessions_closed} label={t("deleteTunnel.statSessions")} tone="neutral" />
            </dl>

            <ul className="divide-y divide-border rounded-lg border border-border">
                <Line tone="success">{t("deleteTunnel.doneDeleted")}</Line>
                {report.device_disconnected && <Line tone="success">{t("deleteTunnel.doneDisconnected")}</Line>}
                {report.accounts.map((a) =>
                    a.error ? (
                        <Line key={a.account} tone="danger" detail={a.error}>
                            {tn("deleteTunnel.doneAccountFailed", { account: <code>{a.account}</code> })}
                        </Line>
                    ) : (
                        <Line key={a.account} tone="success">
                            {tn(a.service_key_removed ? "deleteTunnel.doneAccountWithService" : "deleteTunnel.doneAccount", { account: <code>{a.account}</code>, count: a.removed })}
                        </Line>
                    ),
                )}
                {report.accounts.length === 0 && report.keys_left === 0 && <Line>{t("deleteTunnel.doneNoKeys")}</Line>}
                {report.keys_left > 0 && (
                    <Line tone="warning" detail={!report.online ? t("deleteTunnel.doneWasOffline") : failed > 0 ? t("deleteTunnel.doneFailedLeft") : t("deleteTunnel.doneKept")}>
                        {t("deleteTunnel.doneKeysLeft", { count: report.keys_left })}
                    </Line>
                )}
                {report.grants_revoked > 0 && <Line tone="success">{t("deleteTunnel.doneRevoked", { count: report.grants_revoked })}</Line>}
                {report.grants_detached > 0 && <Line tone="success">{t("deleteTunnel.doneDetached", { count: report.grants_detached })}</Line>}
                {report.ai_sessions_closed > 0 && <Line tone="success">{t("deleteTunnel.doneSessions", { count: report.ai_sessions_closed })}</Line>}
            </ul>
            {report.service ? (
                <ServiceReport service={report.service} />
            ) : (
                <Callout tone="info">{tn("deleteTunnel.deviceRetries", { script: <code>{`~/.ssh/telepy-uninstall-${tunnelId ?? ""}.sh`}</code> })}</Callout>
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

const SERVICE_KINDS: { kind: string; label: TranslationKey; tone: Tone }[] = [
    { kind: "found", label: "deleteTunnel.svcFound", tone: "neutral" },
    { kind: "removed", label: "deleteTunnel.svcRemoved", tone: "success" },
    { kind: "scheduled", label: "deleteTunnel.svcScheduled", tone: "success" },
    { kind: "needs_root", label: "deleteTunnel.svcNeedsRoot", tone: "warning" },
    { kind: "failed", label: "deleteTunnel.svcFailed", tone: "danger" },
    { kind: "kept", label: "deleteTunnel.svcKept", tone: "neutral" },
    { kind: "note", label: "deleteTunnel.svcNote", tone: "neutral" },
];

function ServiceReport({ service }: { service: ServiceRemoval }) {
    const { t } = useI18n();
    const what = (i: ServiceItem) => (SERVICE_WHAT[i.what] ? t(SERVICE_WHAT[i.what]) : i.what);
    // 結論:裝置自己斷線又沒回來 = 真的移除了。/ Verdict: dropped by itself and stayed down = really gone.
    const verdict: { tone: Tone; text: string } = service.came_back
        ? { tone: "danger", text: t("deleteTunnel.svcCameBack") }
        : service.stopped
          ? { tone: "success", text: t("deleteTunnel.svcStopped") }
          : service.launched
            ? { tone: "warning", text: t("deleteTunnel.svcNotStopped") }
            : { tone: "warning", text: t("deleteTunnel.svcNotFound") };
    return (
        <Section icon={<RefreshCw />} title={t("deleteTunnel.serviceTitle")}>
            <ul className="divide-y divide-border rounded-lg border border-border">
                <Line tone={verdict.tone}>{verdict.text}</Line>
            </ul>
            {service.accounts.map((a) => {
                const shown = SERVICE_KINDS.map((k) => ({ ...k, items: a.items.filter((i) => i.kind === k.kind) })).filter((k) => k.items.length > 0);
                return (
                    <div key={a.account} className="rounded-lg border border-border">
                        <p className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-sm">
                            <code className="text-foreground">{a.account}</code>
                            {a.os && <span className="text-xs text-muted-foreground">{a.os}</span>}
                        </p>
                        {a.error && <p className="px-3.5 py-2 text-sm text-destructive">{a.error}</p>}
                        {!a.error && shown.length === 0 && <p className="px-3.5 py-2 text-sm text-muted-foreground">{t("deleteTunnel.svcNothingHere")}</p>}
                        {shown.map((k) => (
                            <div key={k.kind} className="px-3.5 py-2">
                                <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                    {TONE_ICON[k.tone]}
                                    {t(k.label)}
                                </p>
                                <ul className="space-y-1">
                                    {k.items.map((i, n) => (
                                        <li key={n} className="flex items-start gap-2 text-sm">
                                            <span className="shrink-0 text-foreground">{what(i)}</span>
                                            <span className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-muted-foreground line-clamp-2" title={i.detail}>{i.detail}</span>
                                            {k.kind === "needs_root" && <CopyButton value={i.detail} />}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                );
            })}
        </Section>
    );
}
