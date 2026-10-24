"use client";

/**
 * 稽核紀錄完整性驗證的結果（管理員）：每張表一列，完好 = 檢查了幾列；斷鏈 = 在哪一列、為什麼。
 * Result of the audit-log integrity check (admins): one row per table — intact with the rows checked, or
 * where and why the chain breaks.
 */
import React from "react";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { Chip } from "@/components/ui/section";
import type { AuditTableReport, AuditVerifyReport } from "@/hooks/useLogsPage";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const TABLE_LABEL: Record<string, TranslationKey> = {
    telepy_gateway_event: "logs.verify.table.gateway",
    telepy_sign_in_event: "logs.verify.table.signIn",
    telepy_ai_audit_event: "logs.verify.table.ai",
};

const REASON: Record<string, TranslationKey> = {
    hash_mismatch: "logs.verify.reason.hash_mismatch",
    link_mismatch: "logs.verify.reason.link_mismatch",
    missing_hash: "logs.verify.reason.missing_hash",
    checkpoint_mismatch: "logs.verify.reason.checkpoint_mismatch",
    checkpoint_missing: "logs.verify.reason.checkpoint_missing",
};

function TableResult({ r }: { r: AuditTableReport }) {
    const { t, locale } = useI18n();
    const n = (v: number) => v.toLocaleString(locale);
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
            {r.unhashed_before > 0 && <p className="text-xs text-muted-foreground">{t("logs.verify.unhashed", { count: n(r.unhashed_before) })}</p>}
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
                    <p className="text-xs text-muted-foreground">
                        {tn("logs.verify.anchorsHint", { file: <code className="font-mono">audit-anchors.log</code> })}
                    </p>
                </div>
            )}
        </Modal>
    );
}
