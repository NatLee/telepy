"use client";

/**
 * 預覽與編輯：圖片（≤ 10 MiB）直接顯示；文字檔（≤ 1 MiB、UTF-8、開頭沒有 NUL）用 CodeMirror 顯示，按「編輯」就地改，
 * 存檔走暫存檔 + 原子取代。存檔時裝置上的檔案已經被改過（mtime / 大小不同）→ 409 `modified`：可以重新載入（丟掉我的修改）
 * 或覆蓋。其他（二進位、太大）只提供下載。
 * Preview and edit: images shown directly; text in CodeMirror with in-place editing, saved via temp file + atomic
 * replace. A file changed on the device meanwhile → 409 `modified`: reload (drop my changes) or overwrite. Anything
 * else offers a download.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eye, Loader2, Pencil, RotateCcw, Save, WrapText } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useI18n } from "@/lib/i18n";
import { formatBytes, imageMime, languageFor, previewKind } from "@/lib/fileManager";
import type { FileOps, TextFile } from "@/hooks/useFileOps";
import { CodeEditor } from "./CodeEditor";

export interface ViewerTarget {
    path: string;
    name: string;
    bytes: number | null;
    /** 直接進編輯模式。/ Open straight in edit mode. */
    edit: boolean;
}

const WRAP_KEY = "telepy.fileEditorWrap";

function readWrap(): boolean {
    try {
        return localStorage.getItem(WRAP_KEY) !== "0";
    } catch {
        return true;
    }
}

export function FileViewerDialog({ target, ops, onClose, onSaved }: { target: ViewerTarget | null; ops: FileOps; onClose: () => void; onSaved: () => void }) {
    const { t } = useI18n();
    const kind = target ? previewKind(target.name, target.bytes) : "download";
    const [text, setText] = useState<TextFile | null>(null);
    const [image, setImage] = useState<string | null>(null);
    const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
    const [editing, setEditing] = useState(false);
    const [wrap, setWrap] = useState(true);
    const [revision, setRevision] = useState(0);
    const [saving, setSaving] = useState(false);
    const [conflict, setConflict] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);
    const draft = useRef<string>("");
    const [dirty, setDirty] = useState(false);

    useEffect(() => setWrap(readWrap()), []);

    const loadText = useCallback(
        async (path: string) => {
            const r = await ops.readText(path);
            if (r.ok && r.data) {
                setText(r.data);
                draft.current = r.data.content ?? "";
                setDirty(false);
                setConflict(false);
                setRevision((n) => n + 1);
            } else setError({ code: r.code, message: r.message });
        },
        [ops],
    );

    useEffect(() => {
        setText(null);
        setError(null);
        setConflict(false);
        setDirty(false);
        setEditing(!!target?.edit);
        if (!target) return;
        let url: string | null = null;
        let cancelled = false;
        if (kind === "image") {
            void ops.fetchBlob(target.path).then(async (blob) => {
                if (cancelled) return;
                if (!blob) {
                    setError({ code: null, message: t("files.preview.failed") });
                    return;
                }
                // 下載回來是 octet-stream；SVG 要有正確的 type 才畫得出來。/ SVG needs its real type to render.
                url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: imageMime(target.name) ?? "application/octet-stream" }));
                setImage(url);
            });
        } else if (kind === "text") {
            void loadText(target.path);
        }
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
            setImage(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const save = useCallback(
        async (force = false) => {
            if (!text || saving) return;
            setSaving(true);
            const r = await ops.saveText(text.path, draft.current, { mtime: text.mtime_epoch, size: text.size }, force);
            setSaving(false);
            if (r.ok && r.data) {
                setText({ ...r.data, content: draft.current });
                setDirty(false);
                setConflict(false);
                onSaved();
            } else if (r.code === "modified") {
                setConflict(true);
            } else {
                setError({ code: r.code, message: r.message });
            }
        },
        [text, saving, ops, onSaved],
    );

    const requestClose = () => {
        if (dirty) setConfirmClose(true);
        else onClose();
    };

    const lang = target ? languageFor(target.name) : null;
    const download = () => target && void ops.download([target.path]);

    return (
        <>
            <Modal
                isOpen={!!target}
                onClose={requestClose}
                title={target?.name ?? ""}
                description={<span className="font-mono text-xs break-all">{target?.path}</span>}
                icon={editing ? <Pencil /> : <Eye />}
                size="4xl"
                fixedHeight={kind === "text"}
                bodyClassName={kind === "text" ? "py-3" : undefined}
                toolbar={
                    kind === "text" && text ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Chip mono>{lang ?? t("files.editor.plain")}</Chip>
                            <Chip mono>{formatBytes(text.size)}</Chip>
                            <Chip mono>{text.mode}</Chip>
                            {dirty && <Chip tone="warning">{t("files.editor.unsaved")}</Chip>}
                            <span className="ml-auto inline-flex items-center gap-3">
                                <Switch size="sm" checked={wrap} onCheckedChange={(v) => { setWrap(v); try { localStorage.setItem(WRAP_KEY, v ? "1" : "0"); } catch { /* private mode */ } }}>
                                    <span className="inline-flex items-center gap-1 text-sm"><WrapText size={14} aria-hidden /> {t("files.editor.wrap")}</span>
                                </Switch>
                            </span>
                        </div>
                    ) : undefined
                }
                footer={
                    <>
                        {target && <Button variant="outline" onClick={download}><Download size={15} /> {t("files.download")}</Button>}
                        <span className="flex-1" />
                        {kind === "text" && text && !editing && (
                            <Button variant="outline" onClick={() => setEditing(true)}><Pencil size={15} /> {t("common.edit")}</Button>
                        )}
                        {kind === "text" && text && editing ? (
                            <>
                                <Button variant="outline" onClick={requestClose}>{t("common.cancel")}</Button>
                                <Button onClick={() => void save()} disabled={!dirty || saving} title="Ctrl/⌘ S">
                                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t("common.save")}
                                </Button>
                            </>
                        ) : (
                            <Button onClick={onClose}>{t("common.close")}</Button>
                        )}
                    </>
                }
            >
                {conflict && (
                    <Callout tone="warning" title={t("files.editor.conflictTitle")} className="mb-3">
                        <p>{t("files.editor.conflictBody")}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => text && void loadText(text.path)}><RotateCcw size={14} /> {t("files.editor.reload")}</Button>
                            <Button size="sm" variant="destructive" onClick={() => void save(true)}><Save size={14} /> {t("files.editor.overwrite")}</Button>
                        </div>
                    </Callout>
                )}
                {error ? (
                    <Callout tone={error.code === "binary" || error.code === "too_large" || error.code === "not_utf8" ? "info" : "danger"}>
                        {error.message} {(error.code === "binary" || error.code === "too_large" || error.code === "not_utf8") && t("files.preview.downloadInstead")}
                    </Callout>
                ) : kind === "download" ? (
                    <Callout tone="info">{t("files.preview.none", { size: formatBytes(target?.bytes ?? 0) })}</Callout>
                ) : kind === "image" ? (
                    image ? (
                        <div className="grid place-items-center rounded-md border border-border bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={image} alt={target?.name ?? ""} className="max-h-[65dvh] max-w-full object-contain" />
                        </div>
                    ) : (
                        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" /> {t("common.loading")}</p>
                    )
                ) : text ? (
                    <CodeEditor
                        className="flex min-h-64 flex-1 flex-col"
                        initial={text.content ?? ""}
                        language={lang}
                        wrap={wrap}
                        readOnly={!editing}
                        revision={revision}
                        onChange={(v) => {
                            draft.current = v;
                            setDirty(v !== (text.content ?? ""));
                        }}
                        onSave={() => void save()}
                    />
                ) : (
                    <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" /> {t("common.loading")}</p>
                )}
            </Modal>
            <ConfirmDialog
                isOpen={confirmClose}
                onClose={() => setConfirmClose(false)}
                onConfirm={onClose}
                title={t("files.editor.discardTitle")}
                message={t("files.editor.discardBody")}
                confirmText={t("files.editor.discard")}
                isDestructive
            />
        </>
    );
}
