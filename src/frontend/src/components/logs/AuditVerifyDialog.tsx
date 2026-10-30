"use client";

/**
 * 稽核紀錄完整性驗證的結果（管理員）：每張表一列，完好 = 檢查了幾列；斷鏈 = 在哪一列、為什麼。重新封存過的表說誰、
 * 什麼時候、為什麼；斷鏈時指向「伺服器狀態」頁（在那裡重新封存）。
 * Result of the audit-log integrity check (admins): one row per table — intact with the rows checked, or
 * where and why the chain breaks. A re-sealed table says who, when and why; a broken one points at the Server
 * health page, where it can be re-sealed.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, Loader2, ShieldCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { Chip } from "@/components/ui/section";
import type { AuditTableReport, AuditVerifyReport } from "@/hooks/useLogsPage";
import { AUDIT_REASON as REASON, AUDIT_TABLE_LABEL as TABLE_LABEL } from "@/lib/auditReseal";
import { useI18n } from "@/lib/i18n";

/** 伺服器狀態頁上審計鏈那一項所在的分頁。/ The Server health tab the audit-log check sits on. */
const HEALTH_AUDIT_HREF = "/tunnels/admin/health?tab=storage";

function TableResult({ r }: { r: AuditTableReport }) {
    const { t, locale } = useI18n();
    const n = (v: number) => v.toLocaleString(locale);
    const when = (at: string) => {
        const d = new Date(at);
        return Number.isNaN(d.getTime()) ? at : d.toLocaleString(locale);
    };
    const label = TABLE_LABEL[r.table];
    return (
        <li className="rounded-md border border-border bg-surface p-3 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground">{label ? t(label) : r.table}</span>
                {r.ok ? (
                    <Chip tone="success">
                        <ShieldCheck /> {t("logs.verify.intact")}
                    </Chip>
                ) : (
                    <Chip tone="danger">
                        <ShieldAlert /> {t("logs.verify.broken")}
                    </Chip>
                )}
            </div>
            <p className="text-sm text-muted-foreground">
                {r.checked > 0 && r.first_id !== null && r.last_id !== null
                    ? t("logs.verify.checked", { count: n(r.checked), first: r.first_id, last: r.last_id })
                    : t("logs.verify.noRows")}
            </p>
            {!r.ok && r.broken_at !== null && (
                <p className="text-sm text-destructive">
                    {t("logs.verify.brokenAt", { id: r.broken_at })}
                    {r.reason ? ` — ${REASON[r.reason] ? t(REASON[r.reason]) : r.reason}` : ""}
                </p>
            )}
            {r.checkpoints_checked > 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("logs.verify.checkpoints", { checked: n(r.checkpoints_checked), mismatched: n(r.checkpoints_mismatched) })}
                </p>
            )}
            {(r.checkpoints_retired ?? 0) > 0 && <p className="text-xs text-muted-foreground">{t("logs.verify.retired", { count: n(r.checkpoints_retired ?? 0) })}</p>}
            {r.unhashed_before > 0 && <p className="text-xs text-muted-foreground">{t("logs.verify.unhashed", { count: n(r.unhashed_before) })}</p>}
            {r.last_reseal && (
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {t("logs.verify.resealed", { by: r.last_reseal.username, time: when(r.last_reseal.at) })}
                    {r.last_reseal.note && <> — <span className="whitespace-pre-wrap">{r.last_reseal.note}</span></>}
                </p>
            )}
        </li>
    );
}

export function AuditVerifyDialog({
    isOpen,
    onClose,
    onRerun,
    loading,
    report,
}: {
    isOpen: boolean;
    onClose: () => void;
    onRerun: () => void;
    loading: boolean;
    report: AuditVerifyReport | null;
}) {
    const { t, tn } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("logs.verify.title")}
            description={t("logs.verify.description")}
            icon={<ShieldCheck />}
            size="lg"
            footer={
                <>
                    <Button variant="outline" onClick={onRerun} disabled={loading}>
                        {t("logs.verify.again")}
                    </Button>
                    <Button onClick={onClose}>{t("common.close")}</Button>
                </>
            }
        >
            {loading || !report ? (
                <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t("logs.verify.running")}
                </div>
            ) : (
                <div className="space-y-4">
                    <Callout tone={report.ok ? "info" : "danger"}>{report.ok ? t("logs.verify.allOk") : t("logs.verify.someBroken")}</Callout>
                    <ul className="space-y-2">
                        {report.tables.map((r) => (
                            <TableResult key={r.table} r={r} />
                        ))}
                    </ul>
                    {!report.ok && (
                        <p className="text-sm text-foreground/85">
                            {t("logs.verify.resealHint")}{" "}
                            <Link href={HEALTH_AUDIT_HREF} className="inline-flex items-center gap-1 rounded-sm text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {t("logs.verify.resealLink")} <ArrowRight size={13} aria-hidden />
                            </Link>
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                        {tn("logs.verify.anchorsHint", { file: <code className="font-mono">audit-anchors.log</code> })}
                    </p>
                </div>
            )}
        </Modal>
    );
}
