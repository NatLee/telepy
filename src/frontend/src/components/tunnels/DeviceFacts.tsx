"use client";

/**
 * 裝置的基本狀況：詳細資訊視窗的「裝置」段落（OS、kernel、架構、開機多久、CPU、記憶體 / 磁碟用量條、負載、ssh、
 * 要不要重開機、「多久前讀的」+ 重新整理、警示），以及列表卡片 / 表格列上的警示標記。資料來自 `endpoint.facts`，
 * 只給能登入裝置的人（`endpoint` 為 null 時整段不顯示）。
 * Device facts: the details dialog's Device section (OS, kernel, arch, uptime, CPU, memory / disk bars, load, ssh,
 * pending reboot, "checked … ago" + Refresh, warnings) and the warning chip on list cards / rows. Data comes from
 * `endpoint.facts`, which only people who can log in to the device receive.
 */
import React, { useState } from "react";
import { Cpu, Info, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Property, PropertyList, Section } from "@/components/ui/section";
import { useDeviceFacts } from "@/hooks/useDeviceFacts";
import { useNow } from "@/hooks/useNow";
import { bootAt, fmtKb, fmtUptime, nextProbe, usage, warningKinds, type Usage } from "@/lib/deviceFacts";
import { formatRelativeTime } from "@/lib/relativeTime";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DeviceFacts, DeviceWarningKind, TunnelEndpoint } from "@/types/tunnel";
import { DeviceFactsInfoDialog } from "./DeviceFactsInfoDialog";

/** 列表上的警示標記（點了開詳細資訊）。/ The list's warning chip; opens the details. */
export function DeviceWarningChip({ endpoint, onOpen }: { endpoint?: TunnelEndpoint | null; onOpen: () => void }) {
    const { t } = useI18n();
    const kinds = warningKinds(endpoint);
    if (kinds.length === 0) return null;
    const label = kinds.length === 1 ? t(`deviceFacts.chip.${kinds[0]}`) : t("deviceFacts.chip.many", { count: kinds.length });
    const title = `${kinds.map((k) => t(`deviceFacts.chip.${k}`)).join(" · ")}\n${t("deviceFacts.chipHint")}`;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-sm bg-warning/12 px-1.5 py-px text-xs text-warning hover:bg-warning/20"
            title={title}
        >
            <TriangleAlert size={13} aria-hidden /> {label}
        </button>
    );
}

/** 用量條（警示時換成警示色）。/ A usage bar, warning-coloured when warned. */
function UsageBar({ u, warn, text }: { u: Usage; warn: boolean; text: string }) {
    return (
        <span className="block space-y-1">
            <span className="block">{text}</span>
            <span className="block h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.usedPct)} aria-label={text}>
                <span className={cn("block h-full rounded-full", warn ? "bg-warning" : "bg-foreground/45")} style={{ width: `${Math.min(100, Math.max(2, u.usedPct))}%` }} />
            </span>
        </span>
    );
}

function WarningCallouts({ facts }: { facts: DeviceFacts }) {
    const { t } = useI18n();
    const kinds = new Set((facts.warnings ?? []).map((w) => w.kind));
    const disk = usage(facts.disk_total_kb, facts.disk_avail_kb);
    const mem = usage(facts.mem_total_kb, facts.mem_avail_kb);
    const items: { kind: DeviceWarningKind; body: string }[] = [];
    if (kinds.has("disk")) items.push({ kind: "disk", body: disk ? t("deviceFacts.warn.disk", { avail: fmtKb(disk.availKb), total: fmtKb(disk.totalKb), pct: Math.floor(disk.freePct) }) : "" });
    if (kinds.has("memory")) items.push({ kind: "memory", body: mem ? t("deviceFacts.warn.memory", { avail: fmtKb(mem.availKb), total: fmtKb(mem.totalKb), pct: Math.floor(mem.freePct) }) : "" });
    if (kinds.has("load")) items.push({ kind: "load", body: t("deviceFacts.warn.load", { load: (facts.load?.[0] ?? 0).toFixed(2), cpus: facts.cpus ?? "?" }) });
    if (kinds.has("reboot")) items.push({ kind: "reboot", body: t("deviceFacts.warn.reboot") });
    return (
        <>
            {items.map((i) => (
                <Callout key={i.kind} tone="warning" title={t(`deviceFacts.chip.${i.kind}`)}>
                    {i.body}
                </Callout>
            ))}
        </>
    );
}

export function DeviceFactsSection({ tunnelId, isOpen, endpoint: initial, deviceName, canRefresh }: { tunnelId: number | null; isOpen: boolean; endpoint?: TunnelEndpoint | null; deviceName: string; canRefresh: boolean }) {
    const { t, locale } = useI18n();
    const { endpoint, busy, refresh, wait } = useDeviceFacts(tunnelId, isOpen, initial);
    const [infoOpen, setInfoOpen] = useState(false);
    const now = useNow(30_000);
    // 看不到裝置細節（只看狀態的 sharee）或從沒連過：整段不顯示。/ Hidden from status-only sharees and before any connection.
    if (!endpoint) return null;

    const facts = endpoint.facts ?? null;
    const warned = new Set((facts?.warnings ?? []).map((w) => w.kind));
    const unknown = <span className="text-muted-foreground">{t("deviceFacts.unknown")}</span>;
    const disk = usage(facts?.disk_total_kb, facts?.disk_avail_kb);
    const mem = usage(facts?.mem_total_kb, facts?.mem_avail_kb);
    const boot = bootAt(facts, endpoint.facts_at);
    const next = nextProbe(endpoint, now);
    const checkedAt = endpoint.facts_at ?? endpoint.probed_at ?? null;
    const nextText =
        next.kind === "at" ? t("deviceFacts.nextAt", { time: formatRelativeTime(new Date(next.at).toISOString(), locale, now) })
            : next.kind === "soon" ? t("deviceFacts.nextSoon")
                : next.kind === "reconnect" ? t("deviceFacts.nextReconnect")
                    : "";

    return (
        <Section
            icon={<Cpu />}
            title={t("deviceFacts.title")}
            description={t("deviceFacts.description")}
            action={
                <span className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setInfoOpen(true)} aria-label={t("deviceFacts.info")} title={t("deviceFacts.info")}>
                        <Info size={15} />
                    </Button>
                    {canRefresh && (
                        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()} disabled={busy || wait > 0 || !endpoint.live} title={endpoint.live ? undefined : t("deviceFacts.offline")}>
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                            {wait > 0 ? t("deviceFacts.refreshIn", { seconds: wait }) : t("deviceFacts.refresh")}
                        </Button>
                    )}
                </span>
            }
        >
            {facts && <WarningCallouts facts={facts} />}

            {!facts ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                    {endpoint.probe_error ? t("deviceFacts.failed", { error: endpoint.probe_error }) : endpoint.live ? t("deviceFacts.notYet") : t("deviceFacts.notYetOffline")}
                </p>
            ) : (
                <PropertyList>
                    <Property label={t("deviceFacts.os")}>{facts.os ?? unknown}</Property>
                    <Property label={t("deviceFacts.kernel")} mono>
                        {facts.kernel ?? unknown}
                        {facts.arch && <span className="text-muted-foreground"> · {facts.arch}</span>}
                    </Property>
                    <Property label={t("deviceFacts.uptime")}>
                        {facts.uptime_s != null && boot != null
                            ? t("deviceFacts.uptimeValue", { duration: fmtUptime(facts.uptime_s), date: new Date(boot).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })
                            : unknown}
                    </Property>
                    <Property label={t("deviceFacts.cpu")}>
                        {facts.cpu_model || facts.cpus ? (
                            <>
                                {facts.cpu_model}
                                {facts.cpus != null && <span className={facts.cpu_model ? "text-muted-foreground" : undefined}>{facts.cpu_model ? " · " : ""}{t("deviceFacts.cpuCount", { count: facts.cpus })}</span>}
                            </>
                        ) : unknown}
                    </Property>
                    <Property label={t("deviceFacts.memory")}>
                        {mem ? <UsageBar u={mem} warn={warned.has("memory")} text={t("deviceFacts.memoryValue", { avail: fmtKb(mem.availKb), total: fmtKb(mem.totalKb) })} /> : unknown}
                    </Property>
                    <Property label={t("deviceFacts.disk")}>
                        {disk ? <UsageBar u={disk} warn={warned.has("disk")} text={t("deviceFacts.diskValue", { avail: fmtKb(disk.availKb), total: fmtKb(disk.totalKb) })} /> : unknown}
                    </Property>
                    <Property label={t("deviceFacts.load")} mono>
                        {facts.load ? (
                            <span className={warned.has("load") ? "text-warning" : undefined}>{facts.load.map((l) => l.toFixed(2)).join(" · ")}</span>
                        ) : unknown}
                    </Property>
                    <Property label={t("deviceFacts.ssh")} mono>{facts.ssh ?? unknown}</Property>
                    {facts.reboot_required != null && (
                        <Property label={t("deviceFacts.reboot")}>
                            {facts.reboot_required ? <span className="text-warning">{t("deviceFacts.rebootYes")}</span> : t("deviceFacts.rebootNo")}
                        </Property>
                    )}
                </PropertyList>
            )}

            <p className="text-xs text-muted-foreground">
                {checkedAt ? t("deviceFacts.checked", { time: formatRelativeTime(checkedAt, locale, now) }) : t("deviceFacts.neverChecked")}
                {nextText && <> · {nextText}</>}
                {facts && endpoint.probe_error && <span className="block text-destructive">{t("deviceFacts.failed", { error: endpoint.probe_error })}</span>}
            </p>

            <DeviceFactsInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} endpoint={endpoint} deviceName={deviceName} />
        </Section>
    );
}
