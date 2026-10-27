"use client";

/**
 * 新增 / 編輯片段：範圍（我的 / 這台裝置 / 全站，依權限開放；編輯時不能換）、名稱、指令、說明、變數（指令裡每個 `$name`
 * 一列：要不要在執行前問、標籤、預設值、秘密）、執行前先確認。
 * Add / edit a snippet: scope (mine / this device / site, as permitted; fixed when editing), name, command,
 * description, variables (one row per `$name`: ask before running or not, label, default, secret) and "ask first".
 */
import React, { useMemo, useState } from "react";
import { Bookmark, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/callout";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { declaredFromRows, editorRows, type Snippet, type SnippetDraft, type SnippetScope, type SnippetVariable } from "@/lib/snippets";
import type { SaveResult } from "@/hooks/useSnippets";
import { SCOPE_LABEL } from "./ToolboxFlow";

type Row = SnippetVariable & { asked: boolean };

interface Props {
    isOpen: boolean;
    onClose: () => void;
    /** 編輯這個；null = 新增。/ The snippet being edited; null = a new one. */
    snippet: Snippet | null;
    /** 可以選的範圍。/ The scopes the person may pick. */
    scopes: SnippetScope[];
    tunnelName: string;
    onSave: (scope: SnippetScope, draft: SnippetDraft) => Promise<SaveResult>;
}

export function SnippetDialog(props: Props) {
    // 每次打開重新掛載，表單從這個片段（或空白）開始。/ Remounted on every open, starting from the snippet (or blank).
    if (!props.isOpen) return null;
    return <EditDialog key={props.snippet?.id ?? "new"} {...props} />;
}

function EditDialog({ isOpen, onClose, snippet, scopes, tunnelName, onSave }: Props) {
    const { t } = useI18n();
    const [scope, setScope] = useState<SnippetScope>(snippet?.scope ?? scopes[0] ?? "user");
    const [name, setName] = useState(snippet?.name ?? "");
    const [command, setCommand] = useState(snippet?.command ?? "");
    const [description, setDescription] = useState(snippet?.description ?? "");
    const [confirm, setConfirm] = useState(snippet?.confirm ?? false);
    /** 使用者改過的變數設定（依名稱）。/ Variable settings the person touched, by name. */
    const [settings, setSettings] = useState<Record<string, Row>>(() =>
        Object.fromEntries((snippet ? editorRows(snippet.command, snippet.variables) : []).map((r) => [r.name, r])),
    );
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [message, setMessage] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // 指令裡的每個 $name 一列；改過的沿用設定。/ One row per $name; touched ones keep their settings.
    const rows: Row[] = useMemo(() => editorRows(command, []).map((r) => settings[r.name] ?? r), [command, settings]);
    const setRow = (name: string, patch: Partial<Row>) => {
        const base = rows.find((r) => r.name === name);
        if (base) setSettings((prev) => ({ ...prev, [name]: { ...base, ...patch } }));
    };

    const save = async () => {
        setSaving(true);
        setErrors({});
        setMessage(null);
        const res = await onSave(scope, { name: name.trim(), command, description: description.trim(), variables: declaredFromRows(rows), confirm });
        setSaving(false);
        if (res.ok) {
            onClose();
            return;
        }
        setErrors(res.fields);
        setMessage(res.message ?? (res.fields.scope || res.fields.tunnel_id || res.fields.variables || null));
    };

    const scopeOptions = (snippet ? [snippet.scope] : scopes).map((s) => ({
        value: s,
        label: s === "tunnel" ? t("toolbox.scope.tunnelNamed", { name: tunnelName }) : t(SCOPE_LABEL[s]),
        title: t(SCOPE_LABEL[s]),
    }));

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={snippet ? t("toolbox.edit.titleEdit") : t("toolbox.edit.titleNew")}
            icon={<Bookmark />}
            size="xl"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button onClick={save} disabled={saving || !name.trim() || !command.trim()}>
                        {saving && <Loader2 className="animate-spin" />} {t("common.save")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <Field label={t("toolbox.edit.scope")} hint={snippet ? t("toolbox.edit.scopeFixed") : t(`toolbox.edit.scopeHint.${scope}`)}>
                    <div>
                        <Segmented options={scopeOptions} value={scope} onChange={setScope} fullWidth size="sm" aria-label={t("toolbox.edit.scope")} />
                    </div>
                </Field>
                <Field label={t("toolbox.edit.name")} error={errors.name} required>
                    <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("toolbox.edit.namePlaceholder")} autoFocus />
                </Field>
                <Field label={t("toolbox.edit.command")} error={errors.command} hint={t("toolbox.edit.commandHint")} required>
                    <Textarea
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        rows={4}
                        maxLength={4000}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="font-mono text-sm"
                        placeholder="journalctl -u $unit -n 100 --no-pager"
                    />
                </Field>
                <Field label={t("toolbox.edit.description")} addon={<span className="text-xs text-muted-foreground">{t("common.optional")}</span>} error={errors.description}>
                    <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
                </Field>

                {rows.length > 0 && (
                    <div className="space-y-2">
                        <SectionHeading title={t("toolbox.edit.variables")} description={t("toolbox.edit.variablesHint")} />
                        <ul className="space-y-2">
                            {rows.map((r) => (
                                <li key={r.name} className="rounded-lg bg-surface p-2.5 ring-1 ring-inset ring-border/70">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <Chip mono tone={r.asked ? "primary" : "neutral"}>${r.name}</Chip>
                                        <Switch size="sm" checked={r.asked} onCheckedChange={(v) => setRow(r.name, { asked: v })}>
                                            {t("toolbox.edit.ask")}
                                        </Switch>
                                    </div>
                                    {r.asked ? (
                                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                            <Input value={r.label} onChange={(e) => setRow(r.name, { label: e.target.value })} maxLength={60} placeholder={t("toolbox.edit.label")} aria-label={t("toolbox.edit.label")} className="h-8 text-sm" />
                                            <Input
                                                value={r.secret ? "" : r.default}
                                                onChange={(e) => setRow(r.name, { default: e.target.value })}
                                                disabled={r.secret}
                                                maxLength={500}
                                                placeholder={r.secret ? t("toolbox.edit.secretNoDefault") : t("toolbox.edit.default")}
                                                aria-label={t("toolbox.edit.default")}
                                                className="h-8 font-mono text-sm"
                                            />
                                            <Switch size="sm" checked={r.secret} onCheckedChange={(v) => setRow(r.name, { secret: v })} className="sm:col-span-2">
                                                {t("toolbox.edit.secret")}
                                            </Switch>
                                        </div>
                                    ) : (
                                        <p className="mt-1.5 text-xs text-muted-foreground">{t("toolbox.edit.notAsked")}</p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <Switch checked={confirm} onCheckedChange={setConfirm}>
                    <span className="flex flex-col text-left">
                        <span>{t("toolbox.edit.confirm")}</span>
                        <span className="text-xs text-muted-foreground">{t("toolbox.edit.confirmHint")}</span>
                    </span>
                </Switch>

                {message && <Callout tone="danger">{message}</Callout>}
            </div>
        </Modal>
    );
}
