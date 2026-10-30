"use client";

/**
 * 「重新封存審計鏈」視窗：打開就抓試算（`GET /api/site/health/audit`），用一條直線說明「鏈對不上 ─ 你封存（附說明）─
 * 新的基準 ─ 留下紀錄 ─ 之後再改照樣變紅」，每張表列出問題與會做的事（重算幾列、作廢幾行錨點檔），提醒只在知道原因時用、
 * 哪些東西會留著，列出之前的封存，最後要一段必填的說明。送出用試算拿到的指紋（視窗裡看到的就是封存的）。
 * The "Re-seal the audit chain" dialog: loads the dry run on open, draws a straight path (the chain doesn't match ─
 * you re-seal with a note ─ a new baseline ─ kept on record ─ later edits still turn it red), lists each table's
 * problem and what re-sealing does there (rows re-hashed, anchors-file lines set aside), warns to use it only when
 * the cause is known, says what stays on record, lists earlier re-seals and asks for a required note. It sends the
 * dry run's fingerprint, so what the dialog shows is what gets re-sealed.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ScanSearch, ScrollText, ShieldAlert, Stamp } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/pagination";
import { Chip, Section, SectionHeading } from "@/components/ui/section";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/Toast";
import { usePagination } from "@/hooks/usePagination";
import type { ResealOutcome } from "@/hooks/useServerHealth";
import { AUDIT_REASON, AUDIT_TABLE_LABEL, groupReseals, resealTotals, tableIssues, type AuditResealPlan, type AuditResealTable, type ResealGroup } from "@/lib/auditReseal";
import { pageSlice } from "@/lib/pagination";
import { ACK_NOTE_MAX, noteLength, noteProblem } from "@/lib/healthAck";
import { useI18n } from "@/lib/i18n";

export function AuditResealDialog({
    open,
    onClose,
    load,
    onSubmit,
}: {
    open: boolean;
    onClose: () => void;
    load: () => Promise<AuditResealPlan | null>;
    onSubmit: (fingerprint: string, note: string) => Promise<ResealOutcome>;
}) {
    // 每次打開都重新掛載：試算、說明、錯誤都不會留到下一次。/ Remounted per open: plan, note and errors never carry over.
    return open ? <ResealForm onClose={onClose} load={load} onSubmit={onSubmit} /> : null;
}

function ResealForm({ onClose, load, onSubmit }: { onClose: () => void; load: () => Promise<AuditResealPlan | null>; onSubmit: (fingerprint: string, note: string) => Promise<ResealOutcome> }) {
    const { t, locale } = useI18n();
    const { showSuccess, showToast } = useToast();
    const [plan, setPlan] = useState<AuditResealPlan | null>(null);
    const [loading, setLoading] = useState(true);
    const [note, setNote] = useState("");
    const [noteError, setNoteError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const n = (v: number) => v.toLocaleString(locale);
    const length = noteLength(note);

    const fetchPlan = useCallback(async () => {
        setLoading(true);
        setPlan(await load());
        setLoading(false);
    }, [load]);

    useEffect(() => {
        void fetchPlan();
    }, [fetchPlan]);

    const ready = !!plan && plan.canReseal;

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (busy || !plan || !ready) return;
        const problem = noteProblem(note);
        if (problem) {
            setNoteError(problem === "empty" ? t("health.reseal.noteEmpty") : t("health.ack.noteTooLong", { max: String(ACK_NOTE_MAX) }));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const out = await onSubmit(plan.fingerprint, note);
            switch (out.kind) {
                case "ok": {
                    const rows = out.resealed.reduce((s, r) => s + r.rehashed, 0);
                    const lines = out.resealed.reduce((s, r) => s + r.retired, 0);
                    showSuccess(t("health.reseal.done", { rows: n(rows), lines: n(lines) }));
                    onClose();
                    break;
                }
                case "cancelled":
                    break;
                case "changed":
                    // 結果在你看的時候變了：換上新的試算，讓人再看一次。/ Changed meanwhile: show the new dry run to look at again.
                    showToast(t("health.ack.changed"), "warning");
                    void fetchPlan();
                    break;
                case "notAProblem":
                    showToast(t("health.reseal.notAProblem"), "info");
                    onClose();
                    break;
                case "note":
                    setNoteError(out.message);
                    break;
                default:
                    setError(out.message ?? t("health.reseal.failed"));
            }
        } finally {
            setBusy(false);
        }
    };

    const totals = plan ? resealTotals(plan) : null;
    const history = plan ? groupReseals(plan.reseals) : [];

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("health.reseal.title")}
            description={t("health.reseal.description")}
            icon={<Stamp />}
            tone="danger"
            size="2xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" form="audit-reseal-form" variant="destructive" disabled={busy || !ready}>
                        {busy && <Loader2 className="animate-spin" aria-hidden />}
                        {t("health.reseal.confirm")}
                    </Button>
                </>
            }
        >
            {loading && !plan ? (
                <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t("health.reseal.loading")}
                </p>
            ) : !plan ? (
                <Callout tone="danger">
                    {t("health.reseal.loadFailed")}{" "}
                    <Button type="button" variant="link" size="xs" className="h-auto px-0 text-foreground underline" onClick={() => void fetchPlan()}>
                        {t("health.reseal.retry")}
                    </Button>
                </Callout>
            ) : !plan.canReseal ? (
                <Callout tone={plan.status === "warn" ? "warning" : "info"}>{t(plan.status === "warn" ? "health.reseal.cannotVerify" : "health.reseal.nothing")}</Callout>
            ) : (
                <form id="audit-reseal-form" onSubmit={(e) => void submit(e)} className="space-y-5">
                    <FlowPath>
                        <FlowNode
                            compact
                            icon={ScanSearch}
                            title={t("health.reseal.flow.found")}
                            sub={t(totals!.tables === 1 ? "health.reseal.flow.foundSubOne" : "health.reseal.flow.foundSub", { n: String(totals!.tables) })}
                            state="failed"
                            stateText={t("health.status.fail")}
                        />
                        <FlowLink compact label={t("health.reseal.flow.you")} state="ok" />
                        <FlowNode
                            compact
                            icon={Stamp}
                            title={t("health.reseal.flow.baseline")}
                            sub={t("health.reseal.flow.baselineSub", { rows: n(totals!.rehash), lines: n(totals!.retire) })}
                            state="ok"
                            stateText={t("health.reseal.flow.intact")}
                        />
                        <FlowLink compact label={t("health.reseal.flow.kept")} state="ok" />
                        <FlowNode compact icon={ScrollText} title={t("health.reseal.flow.record")} sub={t("health.reseal.flow.recordSub")} state="ok" stateText={t("health.reseal.flow.recorded")} />
                        <FlowLink compact label={t("health.reseal.flow.change")} state="failed" />
                        <FlowNode compact icon={ShieldAlert} title={t("health.reseal.flow.again")} sub={t("health.reseal.flow.againSub")} state="failed" stateText={t("health.status.fail")} />
                    </FlowPath>

                    <Section title={t("health.reseal.tables")}>
                        <ul className="space-y-2">
                            {plan.tables.map((tb) => (
                                <TablePlan key={tb.table} table={tb} />
                            ))}
                        </ul>
                    </Section>

                    <Callout tone="warning" title={t("health.reseal.when.title")}>
                        {t("health.reseal.when.body")}
                    </Callout>

                    <Callout tone="info" title={t("health.reseal.kept.title")}>
                        <ul className="list-disc space-y-1 pl-4">
                            <li>{t("health.reseal.kept.rows")}</li>
                            <li>{t(plan.anchorsFile ? "health.reseal.kept.record" : "health.reseal.kept.recordNoFile")}</li>
                            <li>{t("health.reseal.kept.final")}</li>
                        </ul>
                    </Callout>

                    <ResealHistory history={history} />

                    <Field
                        label={t("health.reseal.noteLabel")}
                        required
                        addon={<span className={length > ACK_NOTE_MAX ? "text-destructive" : undefined}>{t("health.ack.counter", { n: String(length), max: String(ACK_NOTE_MAX) })}</span>}
                        hint={t("health.reseal.noteHint")}
                        error={noteError}
                    >
                        <Textarea
                            value={note}
                            rows={3}
                            placeholder={t("health.reseal.placeholder")}
                            onChange={(e) => {
                                setNote(e.target.value);
                                if (noteError) setNoteError(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
                            }}
                        />
                    </Field>
                    {error && <Callout tone="danger">{error}</Callout>}
                </form>
            )}
        </Modal>
    );
}

/** 一張表：名稱、問題（鏈本身 / 錨點檔各一句）、封存會做的事；沒問題的表只說「不動」。/ One table: its problem and what happens. */
function TablePlan({ table }: { table: AuditResealTable }) {
    const { t, locale } = useI18n();
    const n = (v: number) => v.toLocaleString(locale);
    const label = AUDIT_TABLE_LABEL[table.table];
    const reason = (code: string) => (AUDIT_REASON[code] ? t(AUDIT_REASON[code]) : code);
    return (
        <li className="space-y-1.5 rounded-md border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground">{label ? t(label) : table.table}</span>
                {table.ok ? <Chip tone="success">{t("logs.verify.intact")}</Chip> : <Chip tone="danger">{t("logs.verify.broken")}</Chip>}
            </div>
            {table.ok ? (
                <p className="text-sm text-muted-foreground">{t("health.reseal.leftAlone")}</p>
            ) : (
                <>
                    {tableIssues(table).map((i) => (
                        <p key={i.kind} className="text-sm text-destructive [overflow-wrap:anywhere]">
                            {t(i.kind === "chain" ? "health.reseal.issueRow" : "health.reseal.issueCheckpoint", { row: n(i.row), reason: reason(i.reason) })}
                            {i.more > 0 && <> {t(i.kind === "chain" ? "health.reseal.moreRows" : "health.reseal.moreLines", { n: n(i.more) })}</>}
                        </p>
                    ))}
                    <p className="text-sm text-foreground/85">
                        {table.rehash > 0 && table.fromRow !== null ? t("health.reseal.rehash", { n: n(table.rehash), row: n(table.fromRow) }) : t("health.reseal.noRehash")}
                        {" · "}
                        {t(table.retire === 1 ? "health.reseal.retireOne" : "health.reseal.retire", { n: n(table.retire) })}
                    </p>
                </>
            )}
        </li>
    );
}

/** 之前的重新封存：每次一列（誰、什麼時候、哪些表、做了什麼、說明），多了就分頁。/ Earlier re-seals, one row each, paged. */
function ResealHistory({ history }: { history: ResealGroup[] }) {
    const { t, locale } = useI18n();
    const pager = usePagination(history.length, { storageKey: "telepy.resealHistoryPageSize", sizes: [5, 10, 25] });
    const top = useRef<HTMLElement>(null);
    if (history.length === 0) return null;
    const n = (v: number) => v.toLocaleString(locale);
    const when = (at: string) => {
        const d = new Date(at);
        return Number.isNaN(d.getTime()) ? at : d.toLocaleString(locale);
    };
    const label = (table: string) => (AUDIT_TABLE_LABEL[table] ? t(AUDIT_TABLE_LABEL[table]) : table);
    return (
        <section ref={top} className="space-y-3">
            <SectionHeading title={t("health.reseal.history")} action={<span className="text-sm text-muted-foreground">{t("health.reseal.historyCount", { n: n(history.length) })}</span>} />
            <ul className="space-y-1.5 text-sm" data-refresh-list>
                {pageSlice(history, pager.page, pager.size).map((h) => (
                    <li key={h.id} className="space-y-0.5 rounded-md border border-border bg-surface px-3 py-2 [overflow-wrap:anywhere]">
                        <p className="text-muted-foreground">{t("health.reseal.historyLine", { by: h.username, time: when(h.at) })}</p>
                        <p className="text-foreground/85">
                            {t("health.reseal.historyWhat", {
                                tables: h.tables.map((r) => label(r.table)).join(t("health.reseal.listSeparator")),
                                rows: n(h.tables.reduce((s, r) => s + r.rehashed, 0)),
                                lines: n(h.tables.reduce((s, r) => s + r.retired, 0)),
                            })}
                        </p>
                        {h.note && <p className="whitespace-pre-wrap text-foreground">{h.note}</p>}
                    </li>
                ))}
            </ul>
            <Pagination pager={pager} anchor={top} />
        </section>
    );
}
