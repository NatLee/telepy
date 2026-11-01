"use client";

/**
 * 伺服器健康頁「附屬服務」分頁的「IP 與網卡廠商資料」面板：GeoIP（DB-IP Lite 的國家與網路業者）和 IEEE 的網卡廠商表，
 * 每一項是哪個月 / 哪天的、後端在用哪個檔、立即更新（或下載）、每月自動更新的開關、最近一次更新；「怎麼運作」開說明圖。
 * 資料在 `useDatasets`，純函式在 `lib/datasets`。
 * The Server health page's "IP and vendor data" panel (Companion services tab): GeoIP (DB-IP Lite country and network
 * owner) and IEEE's NIC vendor table — which month / day each is from, the file in use, update (or download) now, the
 * monthly auto-update switch and the last run; "How it works" opens the diagram. Data in `useDatasets`, logic in
 * `lib/datasets`.
 */
import { useState } from "react";
import { Download, Globe, Info, Loader2, MapPin } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { SectionHeading } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { useDatasets } from "@/hooks/useDatasets";
import { datasetsFlow, datasetState, needsDownload, runSummary, STATE_TONE, type DatasetId, type DatasetItem, type DatasetRun, type DatasetState, type DatasetsView } from "@/lib/datasets";
import { useI18n } from "@/lib/i18n";
import { formatBytes } from "@/lib/serverStats";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

const DOT: Record<(typeof STATE_TONE)[DatasetState], string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
    muted: "bg-muted-foreground/40",
};

const NAME_KEY: Record<DatasetId, TranslationKey> = {
    country: "datasets.item.country",
    asn: "datasets.item.asn",
    oui: "datasets.item.oui",
};

const SOURCE_KEY: Record<DatasetId, TranslationKey> = {
    country: "datasets.source.dbip",
    asn: "datasets.source.dbip",
    oui: "datasets.source.ieee",
};

export function DatasetsPanel() {
    const { t, tn, locale } = useI18n();
    const { view, failed, busy, error, update, setAuto } = useDatasets();
    const { showSuccess, showError } = useToast();
    const [info, setInfo] = useState(false);
    const when = (iso: string | null) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
    };
    const working = (busy !== null && busy.action === "update") || !!view?.updating;
    const nothingInstalled = !!view && view.items.every((i) => !i.present);

    const runUpdate = async (items?: DatasetId[]) => {
        const run = await update(items);
        if (!run) return showError(t("datasets.doneFailed"));
        const s = runSummary(run);
        if (s.failed.length > 0) showError(t("datasets.doneFailed"));
        else if (s.updated.length > 0) showSuccess(t("datasets.done", { count: s.updated.length }));
        else showSuccess(t("datasets.doneNothing"));
    };
    const toggleAuto = async (on: boolean) => {
        if (await setAuto(on)) showSuccess(t(on ? "datasets.autoSavedOn" : "datasets.autoSavedOff"));
    };

    return (
        <section id="datasets" className="scroll-mt-24 space-y-3">
            <SectionHeading
                icon={<Globe />}
                title={t("datasets.title")}
                description={t("datasets.description")}
                action={
                    <Button type="button" variant="outline" size="sm" onClick={() => setInfo(true)}>
                        <Info aria-hidden /> {t("datasets.how")}
                    </Button>
                }
            />
            {failed && !view ? (
                <Callout tone="danger">{t("datasets.loadFailed")}</Callout>
            ) : !view ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : (
                <div className="space-y-4 rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-card sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-0.5">
                            <p className="text-base text-foreground">{nothingInstalled ? t("datasets.noneInstalled") : t("datasets.localOnly")}</p>
                            <p className="text-sm text-muted-foreground">{view.checked_at ? t("datasets.checkedAt", { time: when(view.checked_at) }) : t("datasets.neverChecked")}</p>
                        </div>
                        <Button type="button" size="sm" onClick={() => void runUpdate()} disabled={working}>
                            {working && !busy?.items ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />} {nothingInstalled ? t("datasets.downloadAll") : t("datasets.updateAll")}
                        </Button>
                    </div>
                    {error && <Callout tone="danger">{error}</Callout>}

                    <div className="space-y-1">
                        <Switch checked={view.auto_update} onCheckedChange={(on) => void toggleAuto(on)} disabled={busy?.action === "auto"} size="sm">
                            {t("datasets.auto")}
                        </Switch>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            {view.auto_update
                                ? nothingInstalled
                                    ? t("datasets.autoOnNothing")
                                    : t("datasets.autoOn", { days: view.refresh_days, time: view.next_check_at ? when(view.next_check_at) : t("datasets.soon") })
                                : tn("datasets.autoOff", { cmd: <code>telepy-server geoip</code> })}
                        </p>
                    </div>

                    <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border" data-refresh-list>
                        {view.items.map((item) => (
                            <DatasetRow key={item.id} item={item} working={working} spinning={working && !!busy?.items?.includes(item.id)} onUpdate={() => void runUpdate([item.id])} />
                        ))}
                    </ol>

                    {view.last_run && <LastRun run={view.last_run} when={when} />}

                    {/* 標籤在上、值在下（手機上長路徑不會被擠成一字一行）；sm 起並排。/ Label above value on phones, side by side from sm. */}
                    <dl className="grid gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">{t("datasets.from")}</dt>
                        <dd className="font-mono text-xs [overflow-wrap:anywhere] sm:text-sm">
                            <span className="block">{view.sources.dbip}</span>
                            <span className="block">{view.sources.oui}</span>
                        </dd>
                        <dt className="text-muted-foreground">{t("datasets.dirs")}</dt>
                        <dd className="font-mono text-xs [overflow-wrap:anywhere] sm:text-sm">
                            <span className="block">{view.geoip_dir}</span>
                            <span className="block">{view.oui_dir}</span>
                        </dd>
                        <dt className="text-muted-foreground">{t("datasets.license")}</dt>
                        <dd className="text-xs [overflow-wrap:anywhere] sm:text-sm">{t("datasets.licenseText")}</dd>
                    </dl>
                </div>
            )}
            <DatasetsInfoDialog open={info} onClose={() => setInfo(false)} view={view} />
        </section>
    );
}

function DatasetRow({ item, working, spinning, onUpdate }: { item: DatasetItem; working: boolean; spinning: boolean; onUpdate: () => void }) {
    const { t, locale } = useI18n();
    const state = datasetState(item);
    const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : "—");
    // 廠商表沒有版本：下載日期已經在下一行。/ The vendor table has no version; its date is on the next line.
    const version = item.id === "oui" ? null : item.release;
    const stateText: Record<DatasetState, string> = {
        current: t("datasets.state.current"),
        due: item.id === "oui" ? t("datasets.state.dueOui") : t("datasets.state.due"),
        other: t("datasets.state.other", { file: item.in_use?.file ?? "", source: item.in_use?.source ?? "" }),
        missing: t("datasets.state.missing"),
        failed: t("datasets.state.failed"),
    };
    const detail =
        state === "failed"
            ? <span className="[overflow-wrap:anywhere]">{item.failure?.error}</span>
            : item.present
              ? [item.size !== null ? formatBytes(item.size, locale) : null, item.vendors !== null ? t("datasets.vendors", { count: item.vendors.toLocaleString(locale) }) : null, t("datasets.downloaded", { date: day(item.modified) })].filter(Boolean).join(" · ")
              : t(item.id === "oui" ? "datasets.missingOui" : "datasets.missingGeo");
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-card px-3 py-2.5" data-refresh-item>
            <span className={cn("size-2 shrink-0 rounded-full", DOT[STATE_TONE[state]])} aria-hidden />
            <div className="min-w-0 flex-1 basis-44">
                <p className="text-sm text-foreground">{t(NAME_KEY[item.id])}</p>
                <p className="text-xs text-muted-foreground">{t(SOURCE_KEY[item.id])}</p>
            </div>
            <div className="min-w-0 flex-1 basis-56 text-sm sm:w-80 sm:flex-none">
                <p className="text-foreground">
                    {version && state !== "missing" && state !== "other" ? <span className="font-mono">{version}</span> : null}
                    {version && state !== "missing" && state !== "other" ? " · " : null}
                    {stateText[state]}
                </p>
                <p className="text-xs text-muted-foreground">{detail}</p>
            </div>
            {/* 按鈕欄固定寬，列對得齊。/ A fixed-width action slot, so the rows line up. */}
            <div className="flex sm:w-28 sm:justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={onUpdate} disabled={working}>
                    {spinning ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />} {needsDownload(item) ? t("datasets.downloadOne") : t("datasets.updateOne")}
                </Button>
            </div>
        </li>
    );
}

function LastRun({ run, when }: { run: DatasetRun; when: (iso: string | null) => string }) {
    const { t, locale } = useI18n();
    const s = runSummary(run);
    const list = (parts: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(parts);
    const head = run.trigger === "auto" ? t("datasets.run.auto", { time: when(run.at) }) : t("datasets.run.manual", { by: run.by ?? "—", time: when(run.at) });
    const name = (id: DatasetId) => t(NAME_KEY[id]);
    return (
        <Callout tone={s.failed.length > 0 ? "warning" : "info"} title={head}>
            {s.updated.length > 0 && (
                <span className="block">
                    {t("datasets.run.updated", {
                        // 廠商表的日期是 UTC，跟上面的本地日期對不起來，只寫名字。/ The vendor table's dates are UTC: name only.
                        list: list(s.updated.map((i) => (i.id === "oui" ? name(i.id) : i.from ? `${name(i.id)} ${i.from} → ${i.to}` : `${name(i.id)} ${i.to ?? ""}`))),
                    })}
                </span>
            )}
            {s.current.length > 0 && <span className="block">{t("datasets.run.current", { list: list(s.current.map(name)) })}</span>}
            {s.failed.map((i) => (
                <span key={i.id} className="block [overflow-wrap:anywhere]">
                    {t("datasets.run.failed", { name: name(i.id), error: i.error ?? "" })}
                </span>
            ))}
        </Callout>
    );
}

/**
 * 說明圖：DB-IP / IEEE ─ 下載 ─ Telepy 的資料夾（讀進記憶體）─ 本機查詢 ─ 頁面上的地點與廠商，加上四條規則。
 * The diagram: DB-IP / IEEE ─ download ─ Telepy's folder (loaded in memory) ─ local lookups ─ places and vendors on
 * the pages, plus four rules.
 */
function DatasetsInfoDialog({ open, onClose, view }: { open: boolean; onClose: () => void; view: DatasetsView | null }) {
    const { t } = useI18n();
    const f = datasetsFlow(view);
    const months = view ? [...new Set(view.items.filter((i) => i.id !== "oui" && i.release).map((i) => i.release))].join(" / ") : "";
    return (
        <Modal isOpen={open} onClose={onClose} title={t("datasets.info.title")} description={t("datasets.info.description")} icon={<Globe />} size="4xl" footer={<Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>}>
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Globe} title={t("datasets.info.sources")} sub={<span className="font-mono">db-ip.com · ieee.org</span>} state={f.source} stateText={months || undefined} />
                    <FlowLink label={t("datasets.info.download")} state={f.download} />
                    <FlowNode brand title="Telepy" sub={t("datasets.info.telepy")} state={f.telepy} stateText={f.telepy === "ok" ? t("datasets.info.loaded") : undefined} />
                    <FlowLink label={t("datasets.info.local")} state={f.lookups} />
                    <FlowNode icon={MapPin} title={t("datasets.info.pages")} sub={t("datasets.info.pagesSub")} state={f.lookups} />
                </FlowPath>
                <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground/90">
                    <li>{t("datasets.info.p1")}</li>
                    <li>{t("datasets.info.p2")}</li>
                    <li>{t("datasets.info.p3")}</li>
                    <li>{t("datasets.info.p4")}</li>
                </ul>
                <p className="text-xs text-muted-foreground">{t("datasets.licenseText")}</p>
            </div>
        </Modal>
    );
}
