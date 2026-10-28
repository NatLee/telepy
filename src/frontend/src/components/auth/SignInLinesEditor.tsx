"use client";

/**
 * 低調登入頁的句子（網站設定 → 登入）：用內建的問候語（跟著訪客的語言），或自己寫幾句——一列一句，像在文字編輯器裡：
 * Enter 在游標處換到下一列、開頭按 Backspace 接回上一列、上下鍵換列、一次貼上好幾行就各成一列；每列可以上下移、刪掉。
 * 正在編輯的那列會被預覽「釘住」，直接看它打出來的樣子。
 * The discreet page's lines (Site settings → Sign-in): the built-in greetings (in each visitor's language) or the
 * admin's own — one per row, like a text editor: Enter splits to a new row at the caret, Backspace at the start joins
 * the row above, the arrow keys move between rows, pasting several lines makes one row each; rows move up / down or go.
 * The row being edited is pinned in the preview, so it is typed there as you write.
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import { LINE_MAX, MESSAGE_LINES, lineLength, mergeUp, moveRow, pasteRows, removeRow, type RowEdit } from "@/lib/signinLook";
import { cn } from "@/lib/utils";

export type LinesMode = "builtin" | "custom";

export interface LinesDraft {
    mode: LinesMode;
    /** 自己寫的列（切回內建時也留著，切回來還在）。/ Own rows (kept while the built-in mode is on). */
    rows: string[];
}

export function SignInLinesEditor({
    value,
    onChange,
    builtIn,
    onFocusRow,
}: {
    value: LinesDraft;
    onChange: (next: LinesDraft) => void;
    /** 內建的問候語（管理員自己的語言）。/ The built-in greetings, in the admin's language. */
    builtIn: string[];
    /** 正在編輯哪一列（null = 沒有）。/ The row being edited (null = none). */
    onFocusRow: (row: number | null) => void;
}) {
    const { t } = useI18n();
    const inputs = useRef<(HTMLInputElement | null)[]>([]);
    const pending = useRef<{ row: number; caret: number } | null>(null);
    const [dropped, setDropped] = useState(0);
    const { mode, rows } = value;
    const filled = rows.filter((r) => r.trim()).length;

    // 改完列之後把焦點與游標放到該去的地方。/ Put focus and the caret where the edit says, after it renders.
    useLayoutEffect(() => {
        const want = pending.current;
        if (!want) return;
        pending.current = null;
        const el = inputs.current[want.row];
        el?.focus();
        el?.setSelectionRange(want.caret, want.caret);
    });

    const setRows = (next: string[]) => onChange({ mode: "custom", rows: next });
    const apply = (edit: RowEdit) => {
        pending.current = { row: edit.focus, caret: edit.caret };
        setDropped(edit.dropped);
        setRows(edit.rows);
    };
    const focusRow = (row: number, caret: number) => {
        const el = inputs.current[row];
        el?.focus();
        el?.setSelectionRange(caret, caret);
    };

    const onKeyDown = (i: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        const el = e.currentTarget;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        if (e.key === "Enter") {
            e.preventDefault();
            if (rows.length < MESSAGE_LINES) apply(pasteRows(rows, i, start, end, "\n"));
        } else if (e.key === "Backspace" && start === 0 && end === 0 && i > 0) {
            e.preventDefault();
            const edit = mergeUp(rows, i);
            if (edit) apply(edit);
        } else if (e.key === "ArrowUp" && i > 0) {
            e.preventDefault();
            focusRow(i - 1, Math.min(start, rows[i - 1].length));
        } else if (e.key === "ArrowDown" && i < rows.length - 1) {
            e.preventDefault();
            focusRow(i + 1, Math.min(start, rows[i + 1].length));
        }
    };
    const onPaste = (i: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData.getData("text");
        if (!/[\r\n]/.test(text)) return;
        e.preventDefault();
        const el = e.currentTarget;
        apply(pasteRows(rows, i, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, text.replace(/\n+$/, "")));
    };
    const addRow = () => apply({ rows: [...rows, ""], focus: rows.length, caret: 0, dropped: 0 });
    const startFromBuiltIn = () => apply({ rows: builtIn.slice(0, MESSAGE_LINES), focus: 0, caret: builtIn[0]?.length ?? 0, dropped: 0 });
    const setMode = (next: LinesMode) => {
        if (next === "custom" && !filled) pending.current = { row: 0, caret: rows[0]?.length ?? 0 };
        onChange({ mode: next, rows });
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented
                    kind="toggle"
                    size="sm"
                    fullWidth
                    className="w-full sm:inline-grid sm:w-auto"
                    options={[
                        { value: "builtin" as const, label: t("signinLook.modeBuiltIn") },
                        { value: "custom" as const, label: t("signinLook.modeCustom") },
                    ]}
                    value={mode}
                    onChange={setMode}
                    aria-label={t("siteSettings.signin_page_message.label")}
                />
                {mode === "custom" && <span className="text-xs tabular-nums text-muted-foreground">{t("signinLook.linesCount", { count: filled, max: MESSAGE_LINES })}</span>}
            </div>

            {mode === "builtin" ? (
                <div className="rounded-lg border border-border bg-surface p-3">
                    <ol className="space-y-1.5">
                        {builtIn.map((line, i) => (
                            <li key={i} className="flex items-baseline gap-2.5 text-sm text-foreground">
                                <span className="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                                <span className="min-w-0 break-words">{line}</span>
                            </li>
                        ))}
                    </ol>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5">
                        <p className="text-xs leading-relaxed text-muted-foreground">{t("signinLook.builtInNote")}</p>
                        <Button type="button" size="xs" variant="ghost" onClick={startFromBuiltIn}>
                            <Sparkles /> {t("signinLook.startFromBuiltIn")}
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="space-y-2">
                    <ol className="space-y-1.5">
                        {rows.map((row, i) => {
                            const len = lineLength(row);
                            const over = len > LINE_MAX;
                            return (
                                // 窄的時候（手機、放大顯示）按鈕換到輸入框下面，輸入框才不會被擠到看不見字。/ On narrow widths the buttons wrap below, so the input keeps its width.
                                <li key={i} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                    <div className="flex min-w-0 flex-1 basis-[13rem] items-center gap-1.5">
                                        <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground" aria-hidden>
                                            {i + 1}
                                        </span>
                                        <div className="relative min-w-0 flex-1">
                                            <Input
                                                ref={(el) => {
                                                    inputs.current[i] = el;
                                                }}
                                                value={row}
                                                onChange={(e) => {
                                                    setDropped(0);
                                                    setRows(rows.map((r, k) => (k === i ? e.target.value : r)));
                                                }}
                                                onKeyDown={onKeyDown(i)}
                                                onPaste={onPaste(i)}
                                                onFocus={() => onFocusRow(i)}
                                                onBlur={() => onFocusRow(null)}
                                                placeholder={t("signinLook.linePlaceholder")}
                                                aria-label={t("signinLook.lineN", { n: i + 1 })}
                                                aria-invalid={over || undefined}
                                                className="h-8 pr-14"
                                            />
                                            <span className={cn("pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs tabular-nums", over ? "text-destructive" : "text-muted-foreground/70")}>
                                                {t("signinLook.lineCount", { count: len, max: LINE_MAX })}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="ml-auto flex shrink-0 items-center">
                                        <Button type="button" size="icon-xs" variant="ghost" disabled={i === 0} onClick={() => setRows(moveRow(rows, i, -1))} aria-label={t("signinLook.moveUp")} title={t("signinLook.moveUp")}>
                                            <ArrowUp />
                                        </Button>
                                        <Button type="button" size="icon-xs" variant="ghost" disabled={i === rows.length - 1} onClick={() => setRows(moveRow(rows, i, 1))} aria-label={t("signinLook.moveDown")} title={t("signinLook.moveDown")}>
                                            <ArrowDown />
                                        </Button>
                                        <Button type="button" size="icon-xs" variant="ghost" disabled={rows.length === 1 && !row} onClick={() => setRows(removeRow(rows, i))} aria-label={t("signinLook.removeLine")} title={t("signinLook.removeLine")}>
                                            <Trash2 />
                                        </Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
                        <Button type="button" size="xs" variant="ghost" disabled={rows.length >= MESSAGE_LINES} onClick={addRow}>
                            <Plus /> {t("signinLook.addLine")}
                        </Button>
                        <span className="text-xs text-muted-foreground">{t("signinLook.linesKeys")}</span>
                    </div>
                    {rows.some((r) => lineLength(r) > LINE_MAX) && (
                        <p className="pl-6 text-xs text-destructive" role="alert">
                            {t("signinLook.lineTooLong", { max: LINE_MAX })}
                        </p>
                    )}
                    {dropped > 0 && (
                        <p className="pl-6 text-xs text-warning" role="status">
                            {t("signinLook.pasteDropped", { max: MESSAGE_LINES, count: dropped })}
                        </p>
                    )}
                    {!filled && <Callout tone="info">{t("signinLook.linesEmpty")}</Callout>}
                </div>
            )}
        </div>
    );
}
