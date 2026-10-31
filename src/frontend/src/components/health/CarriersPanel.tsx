"use client";

/**
 * 伺服器健康頁「附屬服務」分頁的裝置載體面板：每個平台快取裡的版本與狀態、最新 release、立即檢查、全部更新（或單一平台）、
 * 每天自動更新的開關、最近一次更新的結果、信任的發行公鑰；「怎麼運作」開說明圖。資料在 `useCarriers`，純函式在 `lib/carriers`。
 * The Server health page's device carriers panel (Companion services tab): each platform's cached version and state,
 * the latest release, check now, update all (or one platform), the daily auto-update switch, the last run and the
 * trusted release key; "How it works" opens the diagram. Data in `useCarriers`, pure logic in `lib/carriers`.
 */
import { useState } from "react";
import { Cpu, Download, Info, Loader2, Package, RefreshCw } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { SectionHeading } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { useCarriers } from "@/hooks/useCarriers";
import { carrierFlow, carrierState, carrierSummary, platformLabel, STATE_TONE, type CarrierRun, type CarrierState, type CarrierTarget, type CarriersView } from "@/lib/carriers";
import { useI18n } from "@/lib/i18n";
import { formatBytes } from "@/lib/serverStats";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const DOT: Record<(typeof STATE_TONE)[CarrierState], string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
    muted: "bg-muted-foreground/40",
};

const STATE_KEY: Record<CarrierState, TranslationKey> = {
    current: "carriers.state.current",
    update: "carriers.state.update",
    manual: "carriers.state.manual",
    missing: "carriers.state.missing",
    failed: "carriers.state.failed",
    unknown: "carriers.state.unknown",
};

export function CarriersPanel() {
    const { t, tn, locale } = useI18n();
    const { view, failed, busy, error, check, update, setAuto } = useCarriers();
    const { showSuccess, showError } = useToast();
    const [info, setInfo] = useState(false);
    const when = (iso: string | null) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
    };
    const working = busy !== null || !!view?.updating;

    const runUpdate = async (targets?: string[]) => {
        const run = await update(targets);
        if (!run) return showError(t("carriers.doneFailed"));
        if (run.error || run.failed.length > 0) showError(t("carriers.doneFailed"));
        else if (run.updated.length > 0) showSuccess(t("carriers.done", { tag: run.tag ?? "" }));
        else showSuccess(t("carriers.doneNothing"));
    };
    const runCheck = async () => {
        if (await check()) showSuccess(t("carriers.checkedNow"));
    };
    const toggleAuto = async (on: boolean) => {
        if (await setAuto(on)) showSuccess(t(on ? "carriers.autoSavedOn" : "carriers.autoSavedOff"));
    };

    return (
        <section id="carriers" className="scroll-mt-24 space-y-3">
            <SectionHeading
                icon={<Package />}
                title={t("carriers.title")}
                description={t("carriers.description")}
                action={
                    <Button type="button" variant="outline" size="sm" onClick={() => setInfo(true)}>
                        <Info aria-hidden /> {t("carriers.how")}
                    </Button>
                }
            />
            {failed && !view ? (
                <Callout tone="danger">{t("carriers.loadFailed")}</Callout>
            ) : !view ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : (
                <div className="space-y-4 rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-card sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-0.5">
                            <p className="text-base text-foreground">{view.latest.tag ? t("carriers.latest", { tag: view.latest.tag }) : t("carriers.latestUnknown")}</p>
                            <p className="text-sm text-muted-foreground">{view.latest.checked_at ? t("carriers.checkedAt", { time: when(view.latest.checked_at) }) : t("carriers.neverChecked")}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => void runCheck()} disabled={working}>
                                {busy === "check" ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("carriers.checkNow")}
                            </Button>
                            <Button type="button" size="sm" onClick={() => void runUpdate()} disabled={working}>
                                {busy === "update" || view.updating ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}{" "}
                                {view.latest.tag ? t("carriers.updateAllTo", { tag: view.latest.tag }) : t("carriers.updateAll")}
                            </Button>
                        </div>
                    </div>
                    {view.latest.error && (
                        <Callout tone="warning" title={t("carriers.checkFailed")}>
                            <span className="font-mono text-xs [overflow-wrap:anywhere]">{view.latest.error}</span>
                        </Callout>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}

                    <div className="space-y-1">
                        <Switch checked={view.auto_update} onCheckedChange={(on) => void toggleAuto(on)} disabled={busy === "auto"} size="sm">
                            {t("carriers.auto")}
                        </Switch>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            {view.auto_update
                                ? view.next_check_at
                                    ? t("carriers.autoOn", { time: when(view.next_check_at) })
                                    : t("carriers.autoOnSoon")
                                : tn("carriers.autoOff", { cmd: <code>telepy-server fetch-carriers</code> })}
                        </p>
                    </div>

                    <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border" data-refresh-list>
                        {view.targets.map((tg) => (
                            <CarrierRow key={tg.target} target={tg} latest={view.latest.tag} when={when} working={working} onUpdate={() => void runUpdate([tg.target])} />
                        ))}
                    </ol>

                    {view.last_run && <LastRun run={view.last_run} when={when} />}

                    {/* 標籤在上、值在下（手機上長路徑不會被擠成一字一行）；sm 起並排。/ Label above value on phones, side by side from sm. */}
                    <dl className="grid gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">{t("carriers.source")}</dt>
                        <dd className="font-mono text-xs [overflow-wrap:anywhere] sm:text-sm">{view.releases_url}</dd>
                        <dt className="text-muted-foreground">{t("carriers.keys")}</dt>
                        <dd className="font-mono text-xs [overflow-wrap:anywhere] sm:text-sm">
                            {view.keys.length === 0 ? t("carriers.noKeys") : view.keys.map((k) => <span key={k.fingerprint} className="block">{`${k.fingerprint} (${k.comment})`}</span>)}
                        </dd>
                        <dt className="text-muted-foreground">{t("carriers.dir")}</dt>
                        <dd className="font-mono text-xs [overflow-wrap:anywhere] sm:text-sm">{view.dir}</dd>
                    </dl>
                </div>
            )}
            <CarriersInfoDialog open={info} onClose={() => setInfo(false)} view={view} />
        </section>
    );
}

function CarrierRow({ target, latest, when, working, onUpdate }: { target: CarrierTarget; latest: string | null; when: (iso: string | null) => string; working: boolean; onUpdate: () => void }) {
    const { t, locale } = useI18n();
    const state = carrierState(target, latest);
    const version = target.cached?.version;
    const stateText = state === "update" ? t(STATE_KEY.update, { tag: latest ?? "" }) : t(STATE_KEY[state]);
    const canUpdate = state === "update" || state === "missing" || state === "failed" || state === "manual";
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-card px-3 py-2.5" data-refresh-item>
            <span className={cn("size-2 shrink-0 rounded-full", DOT[STATE_TONE[state]])} aria-hidden />
            <div className="min-w-0 flex-1 basis-44">
                <p className="text-sm text-foreground">{platformLabel(target)}</p>
                <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{target.target}</p>
            </div>
            <div className="min-w-0 flex-1 basis-56 text-sm sm:w-72 sm:flex-none">
                <p className="text-foreground">
                    {version ? <span className="font-mono">{version}</span> : null}
                    {version ? " · " : null}
                    {stateText}
                </p>
                <p className="text-xs text-muted-foreground">{target.cached ? t("carriers.fetchedAt", { size: formatBytes(target.cached.size, locale), time: when(target.cached.fetched_at) }) : state === "failed" ? <span className="[overflow-wrap:anywhere]">{target.failure?.error}</span> : t("carriers.missingHint")}</p>
            </div>
            {/* 按鈕欄固定寬，沒有按鈕的列也對得齊。/ A fixed-width action slot, so rows without a button still line up. */}
            <div className="flex sm:w-28 sm:justify-end">
                {canUpdate && (
                    <Button type="button" variant="ghost" size="sm" onClick={onUpdate} disabled={working}>
                        <Download aria-hidden /> {target.cached ? t("carriers.updateOne") : t("carriers.fetchOne")}
                    </Button>
                )}
            </div>
        </li>
    );
}

function LastRun({ run, when }: { run: CarrierRun; when: (iso: string | null) => string }) {
    const { t } = useI18n();
    const head = run.trigger === "auto" ? t("carriers.run.auto", { time: when(run.at) }) : t("carriers.run.manual", { by: run.by ?? "—", time: when(run.at) });
    const failedList = run.failed.map(([target]) => target).join(", ");
    const tone = run.error || run.failed.length > 0 ? "warning" : "info";
    return (
        <Callout tone={tone} title={head}>
            {run.error ? (
                <span className="[overflow-wrap:anywhere]">{t("carriers.run.error", { error: run.error })}</span>
            ) : (
                <>
                    <span className="block">{run.updated.length > 0 ? t("carriers.run.updated", { count: run.updated.length, tag: run.tag ?? "", list: run.updated.map((u) => u.target).join(", ") }) : t("carriers.run.nothing", { tag: run.tag ?? "" })}</span>
                    {failedList && <span className="block [overflow-wrap:anywhere]">{t("carriers.run.failedList", { list: failedList })}</span>}
                </>
            )}
        </Callout>
    );
}

/**
 * 說明圖：release 頁 ─ 簽過的 SHA256SUMS ─ Telepy 的快取 ─ 下載 + sha256 ─ 裝置，加上四條規則。
 * The diagram: release page ─ signed SHA256SUMS ─ Telepy's copy ─ download + sha256 ─ devices, plus four rules.
 */
function CarriersInfoDialog({ open, onClose, view }: { open: boolean; onClose: () => void; view: CarriersView | null }) {
    const { t } = useI18n();
    const f = carrierFlow(view);
    const s = view ? carrierSummary(view) : null;
    let host = "github.com";
    try {
        if (view?.releases_url) host = new URL(view.releases_url).host;
    } catch {
        /* 不是網址就照預設。/ Not a URL: keep the default. */
    }
    return (
        <Modal isOpen={open} onClose={onClose} title={t("carriers.info.title")} description={t("carriers.info.description")} icon={<Package />} size="4xl" footer={<Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>}>
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Package} title={t("carriers.info.release")} sub={<span className="font-mono">{host}</span>} state={f.release} stateText={view?.latest.tag ?? undefined} />
                    <FlowLink label={t("carriers.info.signed")} state={f.signature} />
                    <FlowNode brand title="Telepy" sub={t("carriers.info.telepy")} state={f.cache} stateText={s ? (s.outdated > 0 ? t("carriers.info.outdated", { count: s.outdated, tag: view?.latest.tag ?? "" }) : t("carriers.info.cached", { count: s.cached, total: s.total })) : undefined} />
                    <FlowLink label={t("carriers.info.toDevices")} state={f.devices} />
                    <FlowNode icon={Cpu} title={t("carriers.info.devices")} sub={t("carriers.info.devicesSub")} state={f.devices} />
                </FlowPath>
                <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground/90">
                    <li>{t("carriers.info.p1")}</li>
                    <li>{t("carriers.info.p2")}</li>
                    <li>{t("carriers.info.p3")}</li>
                    <li>{t("carriers.info.p4")}</li>
                </ul>
            </div>
        </Modal>
    );
}
