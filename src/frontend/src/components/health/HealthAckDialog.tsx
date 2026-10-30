"use client";

/**
 * 「確認這個結果」視窗：用一條直線說明「找到問題 ─ 你確認（附備註）─ 結果一樣就保持安靜 ─ 一有變化就再亮起」，
 * 列出它會做 / 不會做什麼，再要一段必填的備註（1–500 字）。送出交給 `onSubmit`（頁面的 hook：要再驗證時它自己問），
 * 這裡依結果收起、顯示欄位錯誤，或說明結果在你看的時候變了。
 * The "Acknowledge this result" dialog: a straight path (found ─ you acknowledge with a note ─ quiet while the
 * result is the same ─ alerts again the moment anything changes), what it does and does not do, and a required note
 * (1–500 characters). `onSubmit` is the page hook's (it asks for re-authentication itself); this dialog closes,
 * shows the field error, or explains that the result changed meanwhile.
 */
import React, { useState } from "react";
import { BellOff, CircleCheck, RefreshCw, ScanSearch, UserCheck } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/Toast";
import type { AckOutcome } from "@/hooks/useServerHealth";
import { ACK_NOTE_MAX, noteLength, noteProblem } from "@/lib/healthAck";
import { useI18n } from "@/lib/i18n";
import type { HealthCheck } from "@/lib/serverHealth";
import type { TranslationKey } from "@/locales/en";

const STATUS_KEY = { ok: "health.status.ok", info: "health.status.info", warn: "health.status.warn", fail: "health.status.fail" } as const satisfies Record<string, TranslationKey>;

export function HealthAckDialog({ check, title, onClose, onSubmit }: { check: HealthCheck | null; title: string; onClose: () => void; onSubmit: (note: string) => Promise<AckOutcome> }) {
    // 每次打開一張卡就重新掛載，備註與錯誤不會留到下一張。/ Remounted per card, so the note and errors never carry over.
    return check ? <AckForm key={`${check.id}-${check.fingerprint}`} check={check} title={title} onClose={onClose} onSubmit={onSubmit} /> : null;
}

function AckForm({ check, title, onClose, onSubmit }: { check: HealthCheck; title: string; onClose: () => void; onSubmit: (note: string) => Promise<AckOutcome> }) {
    const { t } = useI18n();
    const { showSuccess, showToast } = useToast();
    const [note, setNote] = useState("");
    const [noteError, setNoteError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const status = t(STATUS_KEY[check.status]);
    const length = noteLength(note);

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (busy) return;
        const problem = noteProblem(note);
        if (problem) {
            setNoteError(problem === "empty" ? t("health.ack.noteEmpty") : t("health.ack.noteTooLong", { max: String(ACK_NOTE_MAX) }));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const out = await onSubmit(note);
            switch (out.kind) {
                case "ok":
                    showSuccess(t("health.ack.done"));
                    onClose();
                    break;
                case "cancelled":
                    break;
                case "changed":
                    showToast(t("health.ack.changed"), "warning");
                    onClose();
                    break;
                case "notAProblem":
                    showToast(t("health.ack.notAProblem"), "info");
                    onClose();
                    break;
                case "note":
                    setNoteError(out.message);
                    break;
                default:
                    setError(out.message ?? t("health.ack.failed"));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("health.ack.title")}
            description={t("health.ack.description", { check: title, status })}
            icon={<CircleCheck />}
            size="2xl"
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" form="health-ack-form" disabled={busy}>
                        {t("health.ack.confirm")}
                    </Button>
                </>
            }
        >
            <form id="health-ack-form" onSubmit={(e) => void submit(e)} className="space-y-5">
                <FlowPath>
                    <FlowNode compact icon={ScanSearch} title={t("health.ack.flow.found")} sub={t("health.ack.flow.foundSub", { status })} state="failed" stateText={status} />
                    <FlowLink compact label={t("health.ack.flow.read")} state="ok" />
                    <FlowNode compact icon={UserCheck} title={t("health.ack.flow.you")} sub={t("health.ack.flow.youSub")} state="ok" stateText={t("health.ack.flow.youState")} />
                    <FlowLink compact label={t("health.ack.flow.same")} state="ok" />
                    <FlowNode compact icon={BellOff} title={t("health.ack.flow.quiet")} sub={t("health.ack.flow.quietSub")} state="ok" stateText={t("health.ack.state")} />
                    <FlowLink compact label={t("health.ack.flow.change")} state="failed" />
                    <FlowNode compact icon={RefreshCw} title={t("health.ack.flow.again")} sub={t("health.ack.flow.againSub")} state="failed" stateText={status} />
                </FlowPath>

                <Callout tone="info" title={t("health.ack.notes.title")}>
                    <ul className="list-disc space-y-1 pl-4">
                        <li>{t("health.ack.notes.noChange")}</li>
                        <li>{t("health.ack.notes.recorded")}</li>
                        <li>{t("health.ack.notes.undo")}</li>
                        <li>{t(check.id === "audit_log" ? "health.ack.notes.auditChain" : "health.ack.notes.changes")}</li>
                    </ul>
                </Callout>

                <Field
                    label={t("health.ack.noteLabel")}
                    required
                    addon={<span className={length > ACK_NOTE_MAX ? "text-destructive" : undefined}>{t("health.ack.counter", { n: String(length), max: String(ACK_NOTE_MAX) })}</span>}
                    hint={t("health.ack.noteHint")}
                    error={noteError}
                >
                    <Textarea
                        value={note}
                        rows={3}
                        autoFocus
                        placeholder={t(check.id === "audit_log" ? "health.ack.placeholderAudit" : "health.ack.placeholder")}
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
        </Modal>
    );
}
