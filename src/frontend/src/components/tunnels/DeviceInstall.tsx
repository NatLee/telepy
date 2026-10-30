"use client";

/**
 * 「裝置上的安裝」：這條隧道在裝置上叫什麼（隨機安裝代號，看不出是誰裝的）、盤點到裝置上跑它的是什麼，以及把舊名稱
 * （例如 `telepy-natlee.service`）換成新名稱的「在裝置上改名」——先接上新的、確認過再拆舊的，圖上即時顯示兩條線：
 * 舊服務一直帶著隧道，新服務先當備援，確認能登入才接手，最後才拆舊的。另有列表上的「舊名稱」標記。
 * "On the device": the tunnel's names on its device (a random install id that shows nothing about who set it up),
 * what the survey found running it, and "Rename on the device" — make-before-break, drawn live as two lanes: the old
 * service keeps carrying the tunnel, the new one waits as a standby, takes over once checked, then the old one goes.
 * Also the list's "older name" chip.
 */
import React, { useState } from "react";
import { ArrowRightLeft, Box, Copy, FileText, Info, KeyRound, Loader2, Package, RefreshCw, Server, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath, StateLine } from "@/components/flow/PathFlow";
import { useDeviceInstall } from "@/hooks/useDeviceInstall";
import { useNow } from "@/hooks/useNow";
import { BLOCKER_KEY, METHOD_KEY, RENAME_STEPS, TIDY_STEPS, failureKey, groupParts, lanes, mapRows, needsAttention, noteOf, rootCommands, stepStates, untouched, type DeviceInstallSummary, type DeviceInstallView, type InstallPart, type MapRow, type RenameReport, type RenameStep, type ReportedStep } from "@/lib/deviceInstall";
import { formatRelativeTime } from "@/lib/relativeTime";
import { compatNoServerAlive, factChips } from "@/lib/joinScript";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

/** 列表上的標記：上次盤點看到舊名稱的服務（點了開詳細資訊的裝置頁）。/ The list chip for older-named services. */
export function DeviceNameChip({ summary, onOpen }: { summary?: DeviceInstallSummary | null; onOpen: () => void }) {
    const { t } = useI18n();
    const flagged = needsAttention(summary);
    if (flagged.length === 0) return null;
    const extra = (summary?.extra?.length ?? 0) > 0;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-sm bg-warning/12 px-1.5 py-px text-xs text-warning hover:bg-warning/20"
            title={`${flagged.join(", ")}\n${t(extra ? "deviceInstall.chipExtraHint" : "deviceInstall.chipHint")}`}
        >
            <TriangleAlert size={13} aria-hidden /> {t(extra ? "deviceInstall.chipExtra" : "deviceInstall.chip")}
        </button>
    );
}

const KIND_KEY: Record<InstallPart["kind"], TranslationKey> = {
    service: "deviceInstall.kind.service",
    container: "deviceInstall.kind.container",
    process: "deviceInstall.kind.process",
    cron: "deviceInstall.kind.cron",
    script: "deviceInstall.kind.script",
    file: "deviceInstall.kind.file",
};

function PartRow({ part }: { part: InstallPart }) {
    const { t, locale } = useI18n();
    const now = useNow(60_000);
    const named = part.kind === "service" || part.kind === "container";
    const note = noteOf(part);
    return (
        <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
            <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{part.name}</span>
            <span className="flex flex-wrap gap-1">
                {part.what && part.kind !== "process" && <Chip>{part.what}</Chip>}
                <Chip>{part.account}</Chip>
                {named &&
                    (note === "private" ? (
                        <Chip tone="success">{t("deviceInstall.private")}</Chip>
                    ) : note === "extra" ? (
                        <Chip tone="warning" title={t("deviceInstall.extraHint")}>{t("deviceInstall.extra")}</Chip>
                    ) : note === "earlier" ? (
                        <Chip title={t("deviceInstall.earlierHint")}>{t("deviceInstall.earlier")}</Chip>
                    ) : (
                        <Chip tone="warning">{t("deviceInstall.older")}</Chip>
                    ))}
            </span>
            {part.retired && (
                <span className="basis-full text-xs text-muted-foreground">
                    {part.retired.tunnel_name
                        ? t("deviceInstall.retiredNamed", { name: part.retired.tunnel_name, id: part.retired.install_id, time: formatRelativeTime(part.retired.retired_at, locale, now) })
                        : t("deviceInstall.retiredOther", { id: part.retired.install_id, time: formatRelativeTime(part.retired.retired_at, locale, now) })}
                </span>
            )}
        </li>
    );
}

const NOTE_KEY: Record<MapRow["services"][number]["note"], TranslationKey> = {
    private: "deviceInstall.private",
    earlier: "deviceInstall.earlier",
    older: "deviceInstall.older",
    extra: "deviceInstall.extra",
    process: "deviceInstall.map.process",
    other: "deviceInstall.map.otherService",
};

/**
 * 「這台裝置連到哪裡」：裝置上每個讓通道連著的東西 ─ 它連的伺服器，一列一台；這台伺服器那列在最上面，
 * 別台的列標「不會動」；兩邊共用的金鑰畫在下面。直線，寬的時候橫排、窄的時候直排。
 * "Who this device connects to": each thing that keeps a tunnel up ─ the server it dials, one row per server; this
 * server's row first, other servers' rows marked as never touched; a shared key below. Straight lines only.
 */
export function DeviceMap({ view, deviceName }: { view: Pick<DeviceInstallView, "parts" | "others" | "server_port" | "shared_key" | "online">; deviceName: string }) {
    const { t } = useI18n();
    const rows = mapRows(view);
    const otherPorts = rows.filter((r) => r.kind === "other").map((r) => r.port);
    return (
        <div className="space-y-3">
            {rows.map((row, i) => {
                const mine = row.kind === "this";
                return (
                    <FlowPath key={`${row.kind}-${row.port}-${i}`}>
                        <FlowNode
                            icon={Box}
                            compact
                            wide
                            title={<span className="font-mono text-xs break-all">{row.services.map((s) => s.name).join(", ") || "—"}</span>}
                            sub={
                                <span className="mt-1 flex flex-wrap gap-1">
                                    <Chip>{deviceName}</Chip>
                                    {[...new Set(row.services.map((s) => s.note))].map((n) => (
                                        <Chip key={n} tone={n === "private" ? "success" : n === "older" || n === "extra" ? "warning" : "neutral"}>{t(NOTE_KEY[n])}</Chip>
                                    ))}
                                </span>
                            }
                            state={mine ? (view.online ? "ok" : "waiting") : "waiting"}
                            stateText={mine ? t("deviceInstall.map.carries") : t("deviceInstall.map.untouched")}
                        />
                        <FlowLink compact label={mine ? t("deviceInstall.map.thisLink", { port: row.port }) : row.port === "?" ? t("deviceInstall.map.otherPortUnknown") : t("deviceInstall.map.otherLink", { port: row.port })} state={mine ? (view.online ? "ok" : "waiting") : "waiting"} />
                        {mine ? (
                            <FlowNode brand compact title={t("deviceInstall.map.thisServer")} sub={t("deviceInstall.map.thisServerSub")} state={view.online ? "ok" : "waiting"} stateText={view.online ? t("deviceInstall.flow.online") : undefined} />
                        ) : (
                            <FlowNode icon={Server} compact title={t("deviceInstall.map.otherServer")} sub={t("deviceInstall.map.otherServerSub")} state="waiting" stateText={t("deviceInstall.map.untouched")} />
                        )}
                    </FlowPath>
                );
            })}
            {view.shared_key && (
                <p className="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    <KeyRound size={14} className="mt-0.5 shrink-0 text-foreground" aria-hidden />
                    <span className="min-w-0">
                        {t("deviceInstall.map.sharedKey", { path: view.shared_key, ports: otherPorts.filter((p) => p !== "?").join(", ") || "?" })}
                    </span>
                </p>
            )}
        </div>
    );
}

/** 改名的圖：Telepy ─ 隧道 ─ 裝置（裡面兩個服務：舊的 / 新的，各自的狀態）。/ The rename diagram. */
function RenameFlow({ view, steps, running, report }: { view: DeviceInstallView; steps: ReportedStep[]; running: boolean; report?: RenameReport | null }) {
    const { t } = useI18n();
    const l = lanes(steps, running);
    // 改完之後 view 已經沒有舊名稱了：用回報裡的。/ After the rename the view has no older names left: use the report's.
    const oldName = report?.old.join(", ") || view.rename.old.join(", ") || [...view.older, ...view.earlier].join(", ") || "—";
    const newName = report?.new_name ?? view.rename.new_name ?? view.names.systemd;
    const oldText = l.carrying === "old" ? t("deviceInstall.lane.carrying") : l.old === "waiting" ? t("deviceInstall.lane.removed") : l.old === "failed" ? t("deviceInstall.lane.leftover") : t("deviceInstall.lane.removing");
    const newText = l.new === "failed" ? t("deviceInstall.lane.undone") : l.carrying === "new" ? t("deviceInstall.lane.carrying") : steps.some((s) => s.id === "standby" && s.state === "done") ? t("deviceInstall.lane.standby") : running ? t("deviceInstall.lane.starting") : t("deviceInstall.lane.notYet");
    return (
        <FlowPath>
            <FlowNode brand title="Telepy" sub={t("deviceInstall.flow.telepy")} state="ok" />
            <FlowLink label={l.carrying === "new" ? t("deviceInstall.flow.viaNew") : t("deviceInstall.flow.viaOld")} state={running ? "active" : "ok"} />
            <FlowNode
                icon={Server}
                wide
                title={t("deviceInstall.flow.device")}
                state={running ? "active" : "ok"}
                stateText={running ? undefined : t("deviceInstall.flow.online")}
                control={
                    <ul className="space-y-2">
                        <li className="rounded-lg border border-border bg-surface px-2.5 py-2">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs text-muted-foreground">{t("deviceInstall.flow.old")}</span>
                                <StateLine state={l.old} text={oldText} />
                            </span>
                            <span className="block font-mono text-xs break-all">{oldName}</span>
                        </li>
                        <li className="rounded-lg border border-border bg-surface px-2.5 py-2">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs text-muted-foreground">{t("deviceInstall.flow.new")}</span>
                                <StateLine state={l.new} text={newText} />
                            </span>
                            <span className="block font-mono text-xs break-all">{newName}</span>
                        </li>
                    </ul>
                }
            />
        </FlowPath>
    );
}

function StepList({ steps, running, order = RENAME_STEPS, hintPrefix = "deviceInstall.step" }: { steps: ReportedStep[]; running: boolean; order?: readonly RenameStep[]; hintPrefix?: string }) {
    const { t } = useI18n();
    const states = stepStates(steps, running, order);
    return (
        <ol className="space-y-1.5">
            {order.map((id, i) => {
                const detail = steps.find((s) => s.id === id)?.detail;
                return (
                    <li key={id} className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm bg-muted text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-x-2">
                                <span className="text-sm">{t(`deviceInstall.step.${id}` as TranslationKey)}</span>
                                <StateLine state={states[id]} text={states[id] === "ok" ? t("deviceInstall.stepDone") : undefined} />
                            </span>
                            <span className="block text-xs leading-snug text-muted-foreground">{t(`${hintPrefix}.${id}Hint` as TranslationKey)}</span>
                            {detail && states[id] === "failed" && <span className="mt-0.5 block font-mono text-xs break-all whitespace-pre-wrap text-destructive">{detail}</span>}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

function ReportResult({ report }: { report: RenameReport }) {
    const { t } = useI18n();
    if (report.ok) {
        return (
            <Callout tone="tip" title={t("deviceInstall.done")}>
                {t("deviceInstall.doneBody", { name: report.new_name ?? "", old: report.old.join(", ") })}
            </Callout>
        );
    }
    const roots = rootCommands(report);
    return (
        <Callout tone={untouched(report) ? "warning" : "danger"} title={t(untouched(report) ? "deviceInstall.failedUntouched" : "deviceInstall.failedPartly")}>
            <p>{t(failureKey(report.code))}</p>
            {report.error && !report.code?.startsWith("old_") && !report.steps.some((s) => s.detail === report.error) && <p className="mt-1 font-mono text-xs break-all">{report.error}</p>}
            {report.log && (
                <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-surface p-2 font-mono text-xs whitespace-pre-wrap">{report.log}</pre>
            )}
            {roots.length > 0 && (
                <>
                    <p className="mt-2">{t("deviceInstall.needsRootAfter")}</p>
                    <pre className="mt-1 max-w-full overflow-x-auto rounded-md bg-surface p-2 font-mono text-xs whitespace-pre-wrap">{roots.join("\n")}</pre>
                </>
            )}
        </Callout>
    );
}

/** 改名對話框：要換掉什麼、會怎麼做、即時進度、結果。/ The rename dialog: what, how, live progress, result. */
function RenameDialog({ isOpen, onClose, view, steps, running, report, onStart, deviceName }: { isOpen: boolean; onClose: () => void; view: DeviceInstallView; steps: ReportedStep[]; running: boolean; report: RenameReport | null; onStart: () => void; deviceName: string }) {
    const { t } = useI18n();
    const started = running || report !== null;
    const method = view.rename.method;
    return (
        <Modal
            isOpen={isOpen}
            onClose={running ? () => {} : onClose}
            title={t("deviceInstall.renameTitle", { name: deviceName })}
            description={t("deviceInstall.renameDescription")}
            icon={<ArrowRightLeft />}
            size="4xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={running}>
                        {report ? t("common.close") : t("common.cancel")}
                    </Button>
                    {!report && (
                        <Button type="button" onClick={onStart} disabled={running || !view.rename.possible}>
                            {running ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
                            {running ? t("deviceInstall.renaming") : t("deviceInstall.renameStart")}
                        </Button>
                    )}
                </>
            }
        >
            <div className="space-y-5">
                {!started && view.rename.possible && method && (
                    <p className="text-sm">
                        {t("deviceInstall.renamePlan", { old: view.rename.old.join(", "), name: view.rename.new_name ?? "", method: t(METHOD_KEY[method]), user: view.rename.run_user ?? "", account: view.rename.account ?? "" })}
                    </p>
                )}
                <RenameFlow view={view} steps={steps} running={running} report={report} />
                <StepList steps={steps} running={running} />
                {!started && <Callout tone="info">{t("deviceInstall.renameNote")}</Callout>}
                {report && <ReportResult report={report} />}
            </div>
        </Modal>
    );
}

/**
 * 拿掉多出來那份的圖：Telepy ─ 隧道（一直走用代號取名的那個）─ 裝置（裡面：帶著隧道的那個 / 多出來的那份）。
 * The extra-copy diagram: Telepy ─ the tunnel (always on the install-id service) ─ the device, holding the service that
 * carries the tunnel and the extra copy beside it.
 */
function TidyFlow({ view, steps, running, report, sample }: { view: DeviceInstallView; steps: ReportedStep[]; running: boolean; report?: RenameReport | null; sample?: { current: string; extra: string } }) {
    const { t } = useI18n();
    const s = stepStates(steps, running, TIDY_STEPS);
    const current = sample?.current ?? (view.parts.find((p) => (p.kind === "service" || p.kind === "container") && p.private)?.name || view.install_id);
    const extra = sample?.extra ?? (report?.old.join(", ") || view.tidy?.names.join(", ") || view.extra?.join(", ") || "—");
    const lost = report?.code === "connection_lost";
    const extraState = s.confirm === "ok" ? "waiting" : s.remove === "failed" || s.confirm === "failed" ? "failed" : s.remove === "active" || s.confirm === "active" ? "active" : "failed";
    const extraText = s.confirm === "ok" ? t("deviceInstall.lane.removed") : extraState === "active" ? t("deviceInstall.lane.removing") : extraState === "failed" && steps.length > 0 ? t("deviceInstall.lane.leftover") : t("deviceInstall.tidyLane.fights");
    return (
        <FlowPath>
            <FlowNode brand title="Telepy" sub={t("deviceInstall.flow.telepy")} state="ok" />
            <FlowLink label={t("deviceInstall.tidyLane.link")} state={lost ? "failed" : running ? "active" : "ok"} />
            <FlowNode
                icon={Server}
                wide
                title={t("deviceInstall.flow.device")}
                state={lost ? "failed" : running ? "active" : "ok"}
                stateText={running ? undefined : t("deviceInstall.flow.online")}
                control={
                    <ul className="space-y-2">
                        <li className="rounded-lg border border-border bg-surface px-2.5 py-2">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs text-muted-foreground">{t("deviceInstall.tidyLane.current")}</span>
                                <StateLine state={lost ? "failed" : "ok"} text={t("deviceInstall.lane.carrying")} />
                            </span>
                            <span className="block font-mono text-xs break-all">{current}</span>
                        </li>
                        <li className="rounded-lg border border-dashed border-border px-2.5 py-2">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Copy size={12} aria-hidden /> {t("deviceInstall.tidyLane.extra")}
                                </span>
                                <StateLine state={extraState} text={extraText} />
                            </span>
                            <span className="block font-mono text-xs break-all">{extra}</span>
                        </li>
                    </ul>
                }
            />
        </FlowPath>
    );
}

function TidyDialog({ isOpen, onClose, view, steps, running, report, onStart, deviceName }: { isOpen: boolean; onClose: () => void; view: DeviceInstallView; steps: ReportedStep[]; running: boolean; report: RenameReport | null; onStart: () => void; deviceName: string }) {
    const { t } = useI18n();
    const started = running || report !== null;
    const possible = view.tidy?.possible ?? false;
    const roots = report ? rootCommands(report) : [];
    return (
        <Modal
            isOpen={isOpen}
            onClose={running ? () => {} : onClose}
            title={t("deviceInstall.tidyTitle", { name: deviceName })}
            description={t("deviceInstall.tidyDescription")}
            icon={<Trash2 />}
            size="4xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={running}>
                        {report ? t("common.close") : t("common.cancel")}
                    </Button>
                    {!report && (
                        <Button type="button" onClick={onStart} disabled={running || !possible}>
                            {running ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                            {running ? t("deviceInstall.tidying") : t("deviceInstall.tidyStart")}
                        </Button>
                    )}
                </>
            }
        >
            <div className="space-y-5">
                <TidyFlow view={view} steps={steps} running={running} report={report} />
                <StepList steps={steps} running={running} order={TIDY_STEPS} hintPrefix="deviceInstall.tidyStep" />
                {!started && <Callout tone="info">{t("deviceInstall.tidyNote")}</Callout>}
                {report &&
                    (report.ok ? (
                        <Callout tone="tip" title={t("deviceInstall.tidyDone")}>
                            {t("deviceInstall.tidyDoneBody", { names: report.old.join(", ") })}
                        </Callout>
                    ) : (
                        <Callout tone={report.code === "connection_lost" ? "danger" : "warning"} title={t("deviceInstall.tidyFailed")}>
                            <p>{t(failureKey(report.code))}</p>
                            {report.error && !report.steps.some((s) => s.detail === report.error) && <p className="mt-1 font-mono text-xs break-all">{report.error}</p>}
                            {roots.length > 0 && (
                                <>
                                    <p className="mt-2">{t("deviceInstall.needsRootAfter")}</p>
                                    <pre className="mt-1 max-w-full overflow-x-auto rounded-md bg-surface p-2 font-mono text-xs whitespace-pre-wrap">{roots.join("\n")}</pre>
                                </>
                            )}
                        </Callout>
                    ))}
            </div>
        </Modal>
    );
}

/** 「怎麼取名的」：代號、舊名稱看得出什麼、改名為什麼不會斷線。/ How the names work and why the rename keeps the tunnel up. */
function InfoDialog({ isOpen, onClose, view }: { isOpen: boolean; onClose: () => void; view: DeviceInstallView }) {
    const { t } = useI18n();
    const rows: { what: TranslationKey; old: string; now: string }[] = [
        { what: "deviceInstall.info.rowSystemd", old: "telepy-alice.service · telepy-tunnel-12.service", now: view.names.systemd },
        { what: "deviceInstall.info.rowLaunchd", old: "info.alice.telepy · com.telepy.tunnel.12", now: view.names.launchd },
        { what: "deviceInstall.info.rowLoop", old: "~/.ssh/telepy-alice-loop.sh", now: view.names.loop },
        { what: "deviceInstall.info.rowKnownHosts", old: "~/.ssh/telepy_known_hosts", now: view.names.known_hosts },
        { what: "deviceInstall.info.rowContainer", old: "telepy-tunnel", now: view.names.container },
        { what: "deviceInstall.info.rowDescription", old: "Telepy reverse tunnel (alice-laptop)", now: view.names.description },
    ];
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("deviceInstall.info.title")} description={t("deviceInstall.info.description")} icon={<Info />} size="4xl" footer={<Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>}>
            <div className="space-y-6">
                <Section title={t("deviceInstall.info.namesTitle")} description={t("deviceInstall.info.namesBody", { id: view.install_id })}>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-left text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1.5 pr-3 font-normal">{t("deviceInstall.info.colWhat")}</th>
                                    <th className="py-1.5 pr-3 font-normal">{t("deviceInstall.info.colOld")}</th>
                                    <th className="py-1.5 font-normal">{t("deviceInstall.info.colNow")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.what} className="border-t border-border align-top">
                                        <td className="py-1.5 pr-3">{t(r.what)}</td>
                                        <td className="py-1.5 pr-3 font-mono text-xs break-all text-muted-foreground">{r.old}</td>
                                        <td className="py-1.5 font-mono text-xs break-all">{r.now}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("deviceInstall.info.notHidden")}</p>
                </Section>
                <Section title={t("deviceInstall.info.decideTitle")} description={t("deviceInstall.info.decideBody")}>
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                        <li>{t("deviceInstall.info.decideTunnel")}</li>
                        <li>{t("deviceInstall.info.decideRunning")}</li>
                        <li>{t("deviceInstall.info.decideName")}</li>
                    </ol>
                    <p className="text-sm text-muted-foreground">{t("deviceInstall.info.decideExample")}</p>
                    <TidyFlow view={view} steps={[]} running={false} sample={{ current: view.names.systemd, extra: "telepy-6m35fshq" }} />
                </Section>
                <Section title={t("deviceInstall.info.renameTitle")} description={t("deviceInstall.info.renameBody")}>
                    <RenameFlow view={view} steps={[]} running={false} />
                    <StepList steps={[]} running={false} />
                </Section>
                <Section title={t("deviceInstall.info.sharedTitle")} description={t("deviceInstall.info.sharedExample")}>
                    <DeviceMap
                        deviceName="pi"
                        view={{
                            online: true,
                            server_port: view.server_port || "56767",
                            shared_key: "~/.ssh/telepy_tunnel_ed25519",
                            parts: [{ kind: "service", what: "systemd", name: view.names.systemd, account: "root", private: true, earlier: false }],
                            others: [{ name: "telepy-tunnel.service", port: 57575, process: false, account: "root" }],
                        }}
                    />
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        <li>{t("deviceInstall.info.sharedNames")}</li>
                        <li>{t("deviceInstall.info.sharedOthers")}</li>
                        <li>{t("deviceInstall.info.sharedKey")}</li>
                        <li>{t("deviceInstall.info.sharedAccounts")}</li>
                    </ul>
                </Section>
                <Section title={t("deviceInstall.info.recordTitle")}>
                    <p className="text-sm text-muted-foreground">{t("deviceInstall.info.recordBody")}</p>
                </Section>
            </div>
        </Modal>
    );
}

export function DeviceInstallSection({ tunnelId, isOpen, deviceName, onChanged }: { tunnelId: number | null; isOpen: boolean; deviceName: string; onChanged?: () => void }) {
    const { t, locale } = useI18n();
    const now = useNow(30_000);
    const d = useDeviceInstall(tunnelId, isOpen, true, onChanged);
    const [renameOpen, setRenameOpen] = useState(false);
    const [tidyOpen, setTidyOpen] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const v = d.view;
    if (!v) {
        return d.error ? <Callout tone="danger">{d.error}</Callout> : null;
    }
    const windows = v.accounts.some((a) => a.platform === "windows");
    const groups = groupParts(v.parts);
    const blocker = v.rename.blocker;
    return (
        <Section
            icon={<Package />}
            title={t("deviceInstall.title")}
            wrapTitle
            description={t("deviceInstall.description")}
            action={
                <span className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setInfoOpen(true)} aria-label={t("deviceInstall.info.button")} title={t("deviceInstall.info.button")}>
                        <Info size={15} />
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void d.survey()} disabled={d.surveying || d.renaming || !v.online} title={v.online ? t("deviceInstall.check") : t("deviceInstall.offline")} aria-label={t("deviceInstall.check")}>
                        {d.surveying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {/* 手機上只留圖示，標題才不會被擠成「…」。/ Icon only on phones, so the title is not cut to "…". */}
                        <span className="hidden sm:inline">{t("deviceInstall.check")}</span>
                    </Button>
                </span>
            }
        >
            {(v.extra?.length ?? 0) > 0 && (
                <Callout tone="warning" title={t("deviceInstall.extraTitle")}>
                    <p>{t("deviceInstall.extraBody", { names: (v.extra ?? []).join(", "), id: v.install_id })}</p>
                    {v.tidy?.possible ? (
                        <Button type="button" size="sm" className="mt-2" onClick={() => setTidyOpen(true)} disabled={!v.online || d.renaming}>
                            <Trash2 size={14} /> {t("deviceInstall.tidyButton")}
                        </Button>
                    ) : (
                        v.tidy?.blocker && <p className="mt-1">{t(BLOCKER_KEY[v.tidy.blocker])}</p>
                    )}
                </Callout>
            )}

            {v.older.length > 0 && (
                <Callout tone="warning" title={t("deviceInstall.olderTitle")}>
                    <p>{t("deviceInstall.olderBody", { names: v.older.join(", ") })}</p>
                    {v.rename.possible ? (
                        <Button type="button" size="sm" className="mt-2" onClick={() => setRenameOpen(true)} disabled={!v.online || d.renaming}>
                            <ArrowRightLeft size={14} /> {t("deviceInstall.renameButton")}
                        </Button>
                    ) : (
                        blocker && <p className="mt-1">{t(BLOCKER_KEY[blocker])}</p>
                    )}
                </Callout>
            )}

            {/* 只有 Telepy 以前的標準名稱：不帶人名、刪除腳本也認得，所以只提一句，改名可選。
                Only Telepy's earlier standard names: no person in them and removal knows them, so just a note. */}
            {v.older.length === 0 && v.earlier.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
                    <span className="min-w-0 text-muted-foreground">{t("deviceInstall.earlierBody", { names: v.earlier.join(", ") })}</span>
                    {v.rename.possible && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setRenameOpen(true)} disabled={!v.online || d.renaming}>
                            <ArrowRightLeft size={14} /> {t("deviceInstall.renameOptional")}
                        </Button>
                    )}
                </div>
            )}

            {(v.others.length > 0 || v.shared_key) && (
                <div className="space-y-2">
                    <p className="text-sm">{t("deviceInstall.map.title")}</p>
                    <p className="text-xs text-muted-foreground">{t("deviceInstall.map.description")}</p>
                    <DeviceMap view={v} deviceName={deviceName} />
                </div>
            )}

            <PropertyList>
                <Property label={t("deviceInstall.installId")} mono>
                    <span className="inline-flex items-center gap-1">
                        {v.install_id}
                        <CopyButton value={v.install_id} />
                    </span>
                </Property>
                {v.renamed_at && v.renamed_from.length > 0 && (
                    <Property label={t("deviceInstall.renamedLabel")}>
                        {t("deviceInstall.renamedValue", { old: v.renamed_from.join(", "), time: formatRelativeTime(v.renamed_at, locale, now) })}
                    </Property>
                )}
                {/* 一鍵加入腳本回報的環境：shell、SSH client → server、服務管理器、keepalive。/ What the join script found. */}
                {v.join && (
                    <Property label={t("deviceInstall.joinLabel")}>
                        <span className="flex flex-wrap items-center gap-1">
                            {factChips(v.join.facts).map((c) => (
                                <Chip key={c.key} title={t(c.label)}>{c.value}</Chip>
                            ))}
                            {v.join.at && <span className="text-xs text-muted-foreground">{t("deviceInstall.joinAt", { time: formatRelativeTime(v.join.at, locale, now) })}</span>}
                        </span>
                    </Property>
                )}
            </PropertyList>

            {v.join && compatNoServerAlive(v.join.facts) && <Callout tone="warning" title={t("join.compatTitle")}>{t("join.compatBody")}</Callout>}
            {v.join?.facts.server?.startsWith("Dropbear") && <Callout tone="info">{t("deviceInstall.dropbear")}</Callout>}

            {windows && <Callout tone="info">{t("deviceInstall.windows")}</Callout>}

            {groups.length > 0 ? (
                <div className="space-y-3">
                    {groups.map((g) => (
                        <div key={g.kind}>
                            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                {g.kind === "service" ? <Box size={13} /> : g.kind === "file" ? <FileText size={13} /> : <Server size={13} />}
                                {t(KIND_KEY[g.kind])}
                            </p>
                            <ul className="divide-y divide-border">
                                {g.parts.map((p, i) => (
                                    <PartRow key={`${p.kind}-${p.name}-${p.account}-${i}`} part={p} />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            ) : (
                !windows && (
                    <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                        {v.surveyed_at ? t("deviceInstall.nothingFound") : d.surveying ? t("deviceInstall.surveying") : v.online ? t("deviceInstall.notYet") : t("deviceInstall.notYetOffline")}
                    </p>
                )
            )}

            <p className="text-xs text-muted-foreground">
                {v.surveyed_at ? t("deviceInstall.checked", { time: formatRelativeTime(v.surveyed_at, locale, now) }) : t("deviceInstall.neverChecked")}
                {v.survey_error && <span className="block text-destructive">{t("deviceInstall.surveyFailed", { error: v.survey_error })}</span>}
            </p>

            <RenameDialog
                isOpen={renameOpen}
                onClose={() => {
                    setRenameOpen(false);
                    d.resetRename();
                }}
                view={v}
                steps={d.steps}
                running={d.renaming}
                report={d.report}
                onStart={() => void d.rename()}
                deviceName={deviceName}
            />
            <TidyDialog
                isOpen={tidyOpen}
                onClose={() => {
                    setTidyOpen(false);
                    d.resetRename();
                }}
                view={v}
                steps={d.steps}
                running={d.renaming}
                report={d.report}
                onStart={() => void d.tidy()}
                deviceName={deviceName}
            />
            <InfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} view={v} />
        </Section>
    );
}
