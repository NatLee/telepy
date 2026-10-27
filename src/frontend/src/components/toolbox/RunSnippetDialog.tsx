"use client";

/**
 * 執行前的小對話框：填變數（秘密變數用密碼欄、不預填、不存），預覽最後送出的指令（秘密遮住），要確認的片段在這裡確認。
 * The small dialog before a run: fill the variables (secrets in password fields, never prefilled or stored), preview
 * the final command (secrets masked), and confirm snippets that ask for it.
 */
import React, { useState } from "react";
import { Play, TextCursorInput, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { useI18n } from "@/lib/i18n";
import { askedVariables, initialValues, isMultiline, maskedPreview, substitute, type Snippet } from "@/lib/snippets";

interface Props {
    snippet: Snippet | null;
    /** 開成「插入」（不按 Enter）。/ Opened for Insert (no Enter). */
    insert: boolean;
    where: string;
    onClose: () => void;
    onRun: (command: string, enter: boolean) => void;
}

export function RunSnippetDialog(props: Props) {
    // 每次打開都重新掛載：秘密值不會留在記憶體裡。/ Remounted on every open, so secret values never linger.
    if (!props.snippet) return null;
    return <RunDialog key={`${props.snippet.id}-${props.insert}`} {...props} snippet={props.snippet} />;
}

function RunDialog({ snippet, insert, where, onClose, onRun }: Props & { snippet: Snippet }) {
    const { t } = useI18n();
    const vars = askedVariables(snippet);
    const [values, setValues] = useState<Record<string, string>>(() => initialValues(vars));

    const preview = maskedPreview(snippet.command, vars, values);
    const go = (enter: boolean) => {
        const command = substitute(snippet.command, values);
        setValues({});
        onRun(command, enter);
    };
    const multi = isMultiline(snippet.command);

    return (
        <Modal
            isOpen={!!snippet}
            onClose={() => { setValues({}); onClose(); }}
            title={snippet.name}
            description={snippet.description || undefined}
            icon={snippet.confirm ? <TriangleAlert /> : <Play />}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={() => { setValues({}); onClose(); }}>{t("common.cancel")}</Button>
                    {!multi && (
                        <Button variant={insert ? "default" : "outline"} onClick={() => go(false)}>
                            <TextCursorInput /> {t("toolbox.insert")}
                        </Button>
                    )}
                    {!insert && (
                        <Button onClick={() => go(true)}>
                            <Play /> {snippet.confirm ? t("toolbox.run.confirmRun") : t("toolbox.run")}
                        </Button>
                    )}
                </>
            }
        >
            <form
                className="space-y-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    go(!insert);
                }}
            >
                {vars.map((v, i) => (
                    <Field key={v.name} label={<span>{v.label || v.name} <code className="ml-1 font-mono text-xs text-muted-foreground">${v.name}</code></span>} hint={v.secret ? t("toolbox.run.secretHint") : undefined}>
                        <Input
                            type={v.secret ? "password" : "text"}
                            autoComplete={v.secret ? "new-password" : "off"}
                            spellCheck={false}
                            autoFocus={i === 0}
                            value={values[v.name] ?? ""}
                            onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                            className="font-mono"
                        />
                    </Field>
                ))}
                <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{t("toolbox.run.preview", { where })}</p>
                    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-surface p-2.5 font-mono text-xs text-foreground ring-1 ring-inset ring-border/70">{preview}</pre>
                </div>
                {snippet.confirm && <Callout tone="warning">{t("toolbox.run.confirmNote")}</Callout>}
                {multi && <p className="text-xs text-muted-foreground">{t("toolbox.run.multiNote")}</p>}
                <button type="submit" hidden aria-hidden tabIndex={-1} />
            </form>
        </Modal>
    );
}
