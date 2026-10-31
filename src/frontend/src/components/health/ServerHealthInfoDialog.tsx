"use client";

/**
 * 「伺服器狀態」的 info 按鈕打開的說明：即時的伺服器圖（依最新檢查結果亮起）、「現在」一行、狀態圖例、
 * 每個部分檢查什麼 / 壞了會怎樣，以及須知。點圖上的一站 = 呼叫 `onPick(分頁)` 然後 `onClose()`：
 * 頁面只要切分頁，不必自己關這個視窗。
 * The dialog behind the Server health info button: the live server picture, a "right now" line, the legend, what
 * each part checks / what breaks, and notes. Clicking a spot calls `onPick(tab)` and then `onClose()`: the page
 * only switches the tab, it does not need to close the dialog itself.
 */
import React from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { healthNow, healthSpots, type HealthSpot, type HealthSpotState } from "@/lib/serverHealthFlow";
import type { HealthTab, ServerHealth } from "@/lib/serverHealth";
import type { TranslationKey } from "@/locales/en";
import { SPOT_META, STATE_ICON, ServerHealthFlow } from "./ServerHealthFlow";

/** 表格裡列出的部分（訪客與裝置不檢查，不列）。/ The parts in the table (the visitor and devices are not checked). */
const PARTS: { spot: HealthSpot; checks: TranslationKey; breaks: TranslationKey }[] = [
    { spot: "proxy", checks: "health.flow.check.proxy", breaks: "health.flow.breaks.proxy" },
    { spot: "backend", checks: "health.flow.check.backend", breaks: "health.flow.breaks.backend" },
    { spot: "disk", checks: "health.flow.check.disk", breaks: "health.flow.breaks.disk" },
    { spot: "gateway", checks: "health.flow.check.gateway", breaks: "health.flow.breaks.gateway" },
    { spot: "guacd", checks: "health.flow.check.guacd", breaks: "health.flow.breaks.guacd" },
    { spot: "kasm", checks: "health.flow.check.kasm", breaks: "health.flow.breaks.kasm" },
    { spot: "lookups", checks: "health.flow.check.lookups", breaks: "health.flow.breaks.lookups" },
];

const BREAKS: Partial<Record<HealthSpot, TranslationKey>> = Object.fromEntries(PARTS.map((p) => [p.spot, p.breaks]));

const TONE: Record<HealthSpotState, string> = {
    waiting: "text-muted-foreground",
    ok: "text-success",
    warn: "text-warning",
    failed: "text-destructive",
};

const LEGEND: { state: HealthSpotState; key: TranslationKey }[] = [
    { state: "ok", key: "health.flow.legend.ok" },
    { state: "warn", key: "health.flow.legend.warn" },
    { state: "failed", key: "health.flow.legend.failed" },
    { state: "waiting", key: "health.flow.legend.waiting" },
];

function StateIcon({ state }: { state: HealthSpotState }) {
    const Icon = STATE_ICON[state];
    return <Icon size={14} className={cn("shrink-0", TONE[state])} aria-hidden />;
}

export function ServerHealthInfoDialog({ open, onClose, health, onPick }: { open: boolean; onClose: () => void; health: ServerHealth | null; onPick: (tab: HealthTab) => void }) {
    const { t, tn } = useI18n();
    const spots = healthSpots(health);
    const now = healthNow(health);
    const pick = (tab: HealthTab) => {
        onPick(tab);
        onClose();
    };

    const nowBox = (() => {
        if (now.kind === "loading") return { tone: "border-border bg-surface text-muted-foreground", body: t("health.flow.now.loading") };
        if (now.kind === "ok") return { tone: "border-success/40 bg-success/5 text-foreground", body: t("health.flow.now.ok") };
        const part = t(SPOT_META[now.spot].title);
        // 認得的檢查說它自己的事（不是整個部分的「失敗的話」，那段會提到沒出問題的設定）。
        // A known check explains itself, not the whole part's "if it fails" (which names settings that are fine).
        const id = now.check.id;
        const checkName = id ? t(`health.check.${id}.title` as TranslationKey) : now.check.name;
        const breaks = id ? (`health.check.${id}.what` as TranslationKey) : BREAKS[now.spot];
        return {
            tone: now.kind === "fail" ? "border-destructive/40 bg-destructive/5 text-foreground" : "border-warning/50 bg-warning/5 text-foreground",
            body: (
                <span className="flex flex-col gap-1">
                    <span className={now.kind === "fail" ? "text-destructive" : "text-warning"}>
                        {t(now.kind === "fail" ? "health.flow.now.fail" : "health.flow.now.warn", { part, check: checkName })}
                    </span>
                    {now.check.detail && <span className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">{now.check.detail}</span>}
                    {breaks && <span className="text-muted-foreground">{t(breaks)}</span>}
                    {now.more > 0 && <span className="text-muted-foreground">{t("health.flow.now.more", { count: now.more })}</span>}
                </span>
            ),
        };
    })();

    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            title={t("health.flow.title")}
            description={t("health.flow.description")}
            icon={<Info />}
            size="5xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                <div className="space-y-3">
                    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-sm", nowBox.tone)} role="status">
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-xs text-muted-foreground">{t("health.flow.now.label")}</span>
                            {nowBox.body}
                        </span>
                        {(now.kind === "fail" || now.kind === "warn") && (
                            <Button size="sm" variant="outline" onClick={() => pick(now.tab)}>
                                {t("health.flow.now.open")}
                            </Button>
                        )}
                    </div>
                    <ServerHealthFlow health={health} onPick={pick} />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                        {LEGEND.map((l) => (
                            <span key={l.state} className="inline-flex items-center gap-1">
                                <StateIcon state={l.state} />
                                {t(l.key)}
                            </span>
                        ))}
                        <span>{t("health.flow.pickHint")}</span>
                    </div>
                </div>

                <Section title={t("health.flow.parts.title")}>
                    <div className="@container">
                        <div className="divide-y divide-border rounded-lg border border-border bg-surface">
                            <div className="hidden grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-3 py-2 text-xs text-muted-foreground @2xl:grid">
                                <span>{t("health.flow.parts.part")}</span>
                                <span>{t("health.flow.parts.checks")}</span>
                                <span>{t("health.flow.parts.breaks")}</span>
                            </div>
                            {PARTS.map((p) => (
                                <div key={p.spot} className="grid gap-1 px-3 py-2.5 text-sm @2xl:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] @2xl:gap-4">
                                    <button
                                        type="button"
                                        onClick={() => pick(spots[p.spot].tab)}
                                        className="inline-flex items-start gap-1.5 self-start rounded-sm text-left text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <span className="mt-0.5">
                                            <StateIcon state={spots[p.spot].state} />
                                        </span>
                                        {t(SPOT_META[p.spot].title)}
                                    </button>
                                    <span className="text-muted-foreground @2xl:text-foreground/85">{t(p.checks)}</span>
                                    <span className="text-muted-foreground">
                                        <span className="@2xl:hidden">{t("health.flow.parts.breaks")}: </span>
                                        {t(p.breaks)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </Section>

                <Callout tone="info" title={t("health.flow.notes.title")}>
                    <ul className="list-disc space-y-1 pl-4">
                        <li>{t("health.flow.notes.noChange")}</li>
                        <li>{t("health.flow.notes.refresh")}</li>
                        <li>{t("health.flow.notes.ack")}</li>
                        <li>{tn("health.flow.notes.doctor", { cli: <code>docker compose exec backend telepy-server doctor</code> })}</li>
                    </ul>
                </Callout>
            </div>
        </Modal>
    );
}
