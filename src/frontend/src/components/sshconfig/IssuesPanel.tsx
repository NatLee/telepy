"use client";

/**
 * 「值得看一下」與一鍵修正：每則提醒列出能怎麼修（讓它生效 / 拿掉 / 加進 IgnoreUnknown），按下先看「會讓哪個名稱的哪個
 * 設定怎麼變」，確定再套用（可以復原）。修完提醒會重新算，所以清單永遠是目前文字的。
 * "Worth a look" with one-click fixes: each note lists its fixes (make it apply / remove it / add to
 * IgnoreUnknown); a click first previews which setting of which name changes, then applies (undoable). Notes are
 * recomputed afterwards, so the list always matches the current text.
 */
import React, { useMemo, useState } from "react";
import { CircleAlert, Info, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { applyFix, effectChanges, fixesFor, type FixKind } from "@/lib/sshConfigEdit";
import type { Note } from "@/lib/sshConfigTidy";
import { EffectList } from "./EffectList";
import { NoteLine } from "./TidyResultView";
import { editErrorText } from "./HostEditorDialog";

const FIX_LABEL: Record<FixKind, TranslationKey> = { apply: "tidy.fix.apply", remove: "tidy.fix.remove", ignore: "tidy.fix.ignore" };
const FIX_HINT: Record<FixKind, TranslationKey> = { apply: "tidy.fix.applyHint", remove: "tidy.fix.removeHint", ignore: "tidy.fix.ignoreHint" };

function Preview({ text, note, kind, onApply, onCancel }: { text: string; note: Note; kind: FixKind; onApply: (next: string) => void; onCancel: () => void }) {
    const { t } = useI18n();
    const result = useMemo(() => applyFix(text, note, kind), [text, note, kind]);
    const changes = useMemo(() => (result.text !== undefined ? effectChanges(text, result.text) : []), [text, result]);
    return (
        <div className="mt-2 space-y-2 rounded-lg bg-card p-3 ring-1 ring-inset ring-border">
            <p className="text-xs text-muted-foreground">{t(FIX_HINT[kind])}</p>
            {result.error ? (
                <Callout tone="warning">{editErrorText(result.error, t)}</Callout>
            ) : (
                <>
                    <p className="text-xs text-muted-foreground">{t("tidy.edit.whatChanges")}</p>
                    <EffectList changes={changes} />
                </>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
                <Button size="sm" disabled={result.text === undefined} onClick={() => result.text !== undefined && onApply(result.text)}>
                    <Wrench size={15} /> {t(FIX_LABEL[kind])}
                </Button>
            </div>
        </div>
    );
}

export function IssuesPanel({ text, notes, onApply }: { text: string; notes: Note[]; onApply: (next: string) => void }) {
    const { t } = useI18n();
    const [open, setOpen] = useState<{ n: number; kind: FixKind } | null>(null);
    const fixable = notes.filter((n) => n.kind !== "wall");
    const walls = notes.filter((n) => n.kind === "wall");
    if (notes.length === 0) {
        return <Callout tone="info">{t("tidy.issues.none")}</Callout>;
    }
    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("tidy.issues.intro")}</p>
            <ul className="space-y-2">
                {fixable.map((note) => {
                    const fixes = fixesFor(note);
                    const id = `${note.kind}-${"n" in note ? note.n : 0}`;
                    return (
                        <li key={id} className="rounded-lg bg-surface px-3 py-2.5 ring-1 ring-inset ring-border/70">
                            <div className="flex items-start gap-2.5">
                                <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                                <div className="min-w-0 flex-1 space-y-2">
                                    <p className="text-sm text-foreground [overflow-wrap:anywhere]"><NoteLine n={note} /></p>
                                    {fixes.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                            {fixes.map((kind) => (
                                                <Button
                                                    key={kind}
                                                    size="sm"
                                                    variant={open?.n === note.n && open.kind === kind ? "secondary" : "outline"}
                                                    onClick={() => setOpen(open?.n === note.n && open.kind === kind ? null : { n: note.n, kind })}
                                                    aria-expanded={open?.n === note.n && open.kind === kind}
                                                >
                                                    {t(FIX_LABEL[kind])}
                                                </Button>
                                            ))}
                                        </div>
                                    )}
                                    {open && open.n === note.n && (
                                        <Preview
                                            text={text}
                                            note={note}
                                            kind={open.kind}
                                            onCancel={() => setOpen(null)}
                                            onApply={(next) => {
                                                setOpen(null);
                                                onApply(next);
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
            {walls.length > 0 && (
                <p className={cn("flex items-start gap-2 text-xs text-muted-foreground")}>
                    <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
                    {t("tidy.note.wall", { lines: walls.map((w) => w.n).join(", ") })}
                </p>
            )}
        </div>
    );
}
