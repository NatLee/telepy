"use client";

/**
 * 「裝置的基本狀況怎麼來的」：Telepy ─（每天那次登入、隧道自己的服務金鑰、一個唯讀腳本）─ 裝置 ─✗─ 其他地方。
 * 節點跟線依實際狀態上色（讀過 / 失敗 / 還沒讀、裝置連著 / 離線），下面是上次 / 下次什麼時候、實際跑的指令、
 * 什麼都不裝也不往別處送，以及每個警示的門檻與現在的值。直線、直角，寬的時候橫排、窄的時候直排。
 * "How device facts are collected": Telepy ─ (the daily login with the tunnel's own service key, one read-only
 * script) ─ device ─✗─ anywhere else. Nodes and links follow the real state; below: last / next run, the exact
 * commands, nothing installed or sent elsewhere, and each warning's threshold with the current value.
 */
import React from "react";
import { Ban, CheckCircle2, CircleDashed, Globe, Server, TriangleAlert, XCircle, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip, Section } from "@/components/ui/section";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { COMMANDS_POSIX, COMMANDS_WINDOWS, THRESHOLDS, fmtKb, nextProbe, thresholdRows, type ThresholdRow, type ThresholdState } from "@/lib/deviceFacts";
import { formatRelativeTime } from "@/lib/relativeTime";
import { useI18n } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";
import type { TunnelEndpoint } from "@/types/tunnel";
import type { TranslationKey } from "@/locales/en";

type Spot = "ok" | "failed" | "waiting";

const TONE: Record<Spot, string> = { ok: "text-success", failed: "text-destructive", waiting: "text-muted-foreground" };
const BORDER: Record<Spot, string> = { ok: "border-success/50", failed: "border-destructive/70", waiting: "border-border" };

function Node({ icon: Icon, brand, title, sub, state, muted }: { icon?: LucideIcon; brand?: boolean; title: string; sub: string; state: Spot; muted?: boolean }) {
    return (
        <li className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-center @2xl:flex-1 @2xl:basis-0", BORDER[state], muted ? "border-dashed bg-surface" : "bg-card")}>
            <span className={cn("grid size-10 place-items-center rounded-lg", brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground", muted && "text-muted-foreground")} aria-hidden>
                {brand ? <TelepyGlyph size={22} /> : Icon ? <Icon size={20} /> : null}
            </span>
            <span className={cn("max-w-full truncate text-sm", muted ? "text-muted-foreground" : "text-foreground")} title={title}>{title}</span>
            <span className="text-xs leading-snug text-muted-foreground">{sub}</span>
        </li>
    );
}

/** 一段直線（窄的時候直的、寬的時候橫的）；blocked = 中間一個 ✗。/ A straight link; `blocked` puts a ✗ in the middle. */
function Link({ label, state, blocked }: { label: string; state: Spot; blocked?: boolean }) {
    const dash = blocked ? "3 5" : state === "waiting" ? "4 5" : state === "failed" ? "2 6" : undefined;
    const tone = blocked ? "text-muted-foreground" : TONE[state];
    const line = (vertical: boolean) => (
        <span className={cn("relative", vertical ? "h-10 w-3 @2xl:hidden" : "hidden h-3 w-full @2xl:block")}>
            <svg className={cn("absolute inset-0 size-full", tone)} viewBox={vertical ? "0 0 6 100" : "0 0 100 6"} preserveAspectRatio="none" aria-hidden>
                <line x1={vertical ? 3 : 0} y1={vertical ? 0 : 3} x2={vertical ? 3 : 100} y2={vertical ? 100 : 3} stroke="currentColor" strokeWidth={2} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
            </svg>
            {blocked && (
                <span className="absolute top-1/2 left-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-sm bg-card text-destructive ring-1 ring-border">
                    <Ban size={12} aria-hidden />
                </span>
            )}
        </span>
    );
    return (
        <li className="flex min-w-0 flex-row items-center gap-3 px-6 @2xl:w-40 @2xl:shrink-0 @2xl:flex-col @2xl:gap-1 @2xl:px-1.5" aria-label={label}>
            {line(true)}
            {line(false)}
            <span className={cn("text-xs leading-tight @2xl:text-center", state === "failed" && !blocked ? "text-destructive" : "text-muted-foreground")}>
                {state === "failed" && !blocked && <XCircle size={12} className="mr-1 inline-block align-[-2px]" aria-hidden />}
                {label}
            </span>
        </li>
    );
}

const STATE_CHIP: Record<ThresholdState, { tone: "success" | "warning" | "neutral"; icon: LucideIcon; key: TranslationKey }> = {
    ok: { tone: "success", icon: CheckCircle2, key: "deviceFacts.how.state.ok" },
    warn: { tone: "warning", icon: TriangleAlert, key: "deviceFacts.how.state.warn" },
    unknown: { tone: "neutral", icon: CircleDashed, key: "deviceFacts.how.state.unknown" },
};

function ThresholdLine({ row }: { row: ThresholdRow }) {
    const { t } = useI18n();
    const chip = STATE_CHIP[row.state];
    const ChipIcon = chip.icon;
    const rule =
        row.kind === "disk" ? t("deviceFacts.how.th.disk", { pct: THRESHOLDS.diskMinFreePct, size: fmtKb(THRESHOLDS.diskMinFreeKb) })
            : row.kind === "memory" ? t("deviceFacts.how.th.memory", { pct: THRESHOLDS.memMinAvailPct })
                : row.kind === "load" ? t("deviceFacts.how.th.load", { n: THRESHOLDS.loadPerCpu })
                    : t("deviceFacts.how.th.reboot");
    const now =
        row.value == null ? null
            : row.kind === "load" ? t("deviceFacts.how.nowLoad", { load: row.value.toFixed(2), cpus: row.extra ?? "?" })
                : t("deviceFacts.how.nowFree", { pct: Math.floor(row.value), size: fmtKb(row.extra ?? 0) });
    return (
        <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-sm">
            <span className="min-w-0">
                <span className="text-foreground">{rule}</span>
                {now && <span className="block text-xs text-muted-foreground">{now}</span>}
            </span>
            <Chip tone={chip.tone}><ChipIcon /> {t(chip.key)}</Chip>
        </li>
    );
}

export function DeviceFactsInfoDialog({ isOpen, onClose, endpoint, deviceName }: { isOpen: boolean; onClose: () => void; endpoint: TunnelEndpoint; deviceName: string }) {
    const { t, locale } = useI18n();
    const now = useNow(30_000);
    const read: Spot = endpoint.probe_error ? "failed" : endpoint.facts_at ? "ok" : "waiting";
    const device: Spot = endpoint.live ? "ok" : "waiting";
    const last = endpoint.facts_at ?? endpoint.probed_at ?? null;
    const next = nextProbe(endpoint, now);
    const when = (iso: string) => `${formatRelativeTime(iso, locale, now)} · ${new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    const nextText =
        next.kind === "at" ? when(new Date(next.at).toISOString())
            : next.kind === "soon" ? t("deviceFacts.nextSoon")
                : next.kind === "reconnect" ? t("deviceFacts.nextReconnect")
                    : t("deviceFacts.how.never");
    const nowKey: TranslationKey = endpoint.probe_error ? "deviceFacts.how.nowFailed" : endpoint.facts_at ? "deviceFacts.how.nowOk" : "deviceFacts.how.nowWaiting";

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("deviceFacts.how.title")}
            description={t("deviceFacts.how.description")}
            icon={<Server />}
            size="3xl"
            footer={<Button type="button" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                <p className={cn("rounded-md border px-3 py-2 text-sm", read === "failed" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-surface text-foreground")} role="status">
                    {t(nowKey, { device: deviceName })}
                    {endpoint.probe_error && <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{endpoint.probe_error}</span>}
                </p>

                <div className="@container">
                    <ol className="flex flex-col items-stretch @2xl:flex-row @2xl:items-center">
                        <Node brand title="Telepy" sub={t("deviceFacts.how.telepySub")} state="ok" />
                        <Link label={t("deviceFacts.how.link")} state={read} />
                        <Node icon={Server} title={deviceName} sub={endpoint.live ? t("deviceFacts.how.deviceLive") : t("deviceFacts.how.deviceOffline")} state={device} />
                        <Link label={t("deviceFacts.how.linkElsewhere")} state="waiting" blocked />
                        <Node icon={Globe} title={t("deviceFacts.how.elsewhere")} sub={t("deviceFacts.how.elsewhereSub")} state="waiting" muted />
                    </ol>
                </div>

                <Section title={t("deviceFacts.how.when")}>
                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                            <dt className="text-xs text-muted-foreground">{t("deviceFacts.how.last")}</dt>
                            <dd className="text-foreground">{last ? when(last) : t("deviceFacts.how.never")}</dd>
                        </div>
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                            <dt className="text-xs text-muted-foreground">{t("deviceFacts.how.next")}</dt>
                            <dd className="text-foreground">{nextText}</dd>
                        </div>
                    </dl>
                    <p className="text-sm text-muted-foreground">{t("deviceFacts.how.schedule")}</p>
                </Section>

                <Section title={t("deviceFacts.how.commands")} description={t("deviceFacts.how.commandsHint")}>
                    <div className="grid gap-3">
                        {([["deviceFacts.how.posix", COMMANDS_POSIX], ["deviceFacts.how.windows", COMMANDS_WINDOWS]] as const).map(([key, list]) => (
                            <div key={key} className="min-w-0">
                                <p className="mb-1 text-xs text-muted-foreground">{t(key)}</p>
                                <pre className="overflow-x-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-foreground ring-1 ring-inset ring-border">{list.join("\n")}</pre>
                            </div>
                        ))}
                    </div>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        <li>{t("deviceFacts.how.noteInstall")}</li>
                        <li>{t("deviceFacts.how.noteSend")}</li>
                        <li>{t("deviceFacts.how.noteWho")}</li>
                    </ul>
                </Section>

                <Section title={t("deviceFacts.how.thresholds")} description={t("deviceFacts.how.thresholdsHint")}>
                    <ul className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
                        {thresholdRows(endpoint.facts).map((row) => (
                            <ThresholdLine key={row.kind} row={row} />
                        ))}
                    </ul>
                </Section>
            </div>
        </Modal>
    );
}
