"use client";

/**
 * 檔案管理面板（終端機頁的側欄 / 手機的檔案畫面）：列目錄（WebSocket）+ 檔案操作（REST，見 useFileOps）。
 * - 點一下開啟（資料夾進去、檔案預覽 / 編輯）；勾選框、Ctrl/⌘+點、Shift+點多選，選了就出現批次列。
 * - 從桌面拖檔案進來上傳（同時 2 個、每個有進度）；把列拖到資料夾上就是搬過去（拖到「上一層」按鈕 = 搬到上一層）。
 * - 鍵盤：Enter 開啟、Backspace 上一層、F2 改名、Delete 刪除、Ctrl/⌘+A 全選、↑↓ 移動。
 * - 標題列的 info 按鈕打開即時路徑圖（FileFlowDialog）。
 * File manager panel (terminal side panel / phone files view): listing over the WebSocket, operations over REST.
 * Click opens; checkboxes / Ctrl-click / Shift-click select and show the bulk bar; drop files to upload, drag rows onto a
 * folder to move; keyboard shortcuts; the info button opens the live path diagram.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
    Archive, Copy, CornerLeftUp, Download, Eye, File, FileCode2, FilePlus2, Folder, FolderInput, FolderPlus, Home, Image as ImageIcon, Info, KeyRound,
    Keyboard, Link2, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2, Upload, WifiOff, X, CheckCircle2, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { FileItem } from "@/types/tunnel";
import { useFileManager } from "@/hooks/useFileManager";
import { useFileOps } from "@/hooks/useFileOps";
import {
    EMPTY_SELECTION, fileKeyAction, formatBytes, imageMime, isSelected, joinPath, KEY_HINTS, languageFor, modeFromString, moveCursor, parentPath, parseMode,
    previewKind, pruneSelection, selectAll, selectOnly, selectRange, toggleSelection, uploadSummary, type Selection,
} from "@/lib/fileManager";
import { ChmodDialog, DeleteDialog, DestinationDialog, DetailsDialog, NameDialog, type NameKind } from "@/components/files/FileDialogs";
import { FileViewerDialog, type ViewerTarget } from "@/components/files/FileViewerDialog";
import { FileFlowDialog } from "@/components/files/FileFlowDialog";

interface FileManagerPanelProps {
    serverId: string;
    username: string;
    accessToken: string;
    initialPath?: string;
    /** 隧道名稱（info 圖用）。/ The tunnel name, for the info diagram. */
    deviceName?: string;
}

/** 列拖曳時帶的資料型別。/ The drag payload type for rows. */
const DND_TYPE = "application/x-telepy-files";

function isDir(item: FileItem): boolean {
    return item.type === "directory" || !!item.permissions?.string?.startsWith("d");
}

function bytesOf(item: FileItem): number | null {
    if (typeof item.bytes === "number") return item.bytes;
    if (typeof item.size === "number") return item.size;
    const n = Number(item.size);
    return Number.isFinite(n) ? n : null;
}

function sizeText(item: FileItem): string {
    const b = bytesOf(item);
    if (b !== null) return formatBytes(b);
    return String(item.size ?? "");
}

function FileIcon({ item }: { item: FileItem }) {
    if (isDir(item)) return <Folder className="text-info fill-info/15" size={16} />;
    const name = item.name.toLowerCase();
    if (/\.(zip|tar|gz|tgz|rar|7z|xz|bz2)$/.test(name)) return <Archive className="text-warning" size={16} />;
    if (imageMime(name)) return <ImageIcon className="text-success" size={16} />;
    if (languageFor(name)) return <FileCode2 className="text-muted-foreground" size={16} />;
    return <File className="text-muted-foreground" size={16} />;
}

export function FileManagerPanel({ serverId, username, accessToken, initialPath, deviceName }: FileManagerPanelProps) {
    const { t, locale } = useI18n();
    const { showError } = useToast();
    const { state, actions, reconnect } = useFileManager(serverId, username, accessToken, initialPath);
    const { connected, connecting, link, currentPath, setCurrentPath, listedPath, items, loading, shellType, error, setError } = state;
    const { refresh, handlePathSubmit, navigateTo, goUp, goHome } = actions;
    const ops = useFileOps(serverId, username, listedPath, refresh);

    // 選取與游標屬於某個目錄：換目錄就清掉，重新列表後拿掉已經不在的（render 時推導，不用 effect）。
    // Selection and cursor belong to one folder: cleared on a folder change, pruned after a relist (derived in render).
    const [selBox, setSelBox] = useState<{ path: string; sel: Selection; cursor: string | null }>({ path: "", sel: EMPTY_SELECTION, cursor: null });
    const [nameDlg, setNameDlg] = useState<{ kind: NameKind; initial: string } | null>(null);
    const [deleteNames, setDeleteNames] = useState<string[] | null>(null);
    const [dest, setDest] = useState<{ mode: "move" | "copy"; names: string[] } | null>(null);
    const [chmodNames, setChmodNames] = useState<string[] | null>(null);
    const [detailsName, setDetailsName] = useState<string | null>(null);
    const [viewer, setViewer] = useState<ViewerTarget | null>(null);
    const [flowOpen, setFlowOpen] = useState(false);
    const [replace, setReplace] = useState<{ files: File[]; names: string[] } | null>(null);
    const [dragFiles, setDragFiles] = useState(false);
    const [dropRow, setDropRow] = useState<string | null>(null);
    const [showUploads, setShowUploads] = useState(true);
    const dragged = useRef<string[] | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 資料夾在前，其餘照後端的名稱排序。/ Folders first, then the backend's name order.
    const sorted = useMemo(() => [...items].sort((a, b) => Number(isDir(b)) - Number(isDir(a))), [items]);
    const order = useMemo(() => sorted.map((i) => i.name), [sorted]);
    const byName = useMemo(() => new Map(sorted.map((i) => [i.name, i])), [sorted]);

    const here = selBox.path === listedPath;
    const sel = useMemo(() => (here ? pruneSelection(selBox.sel, order) : EMPTY_SELECTION), [here, selBox.sel, order]);
    const cursor = here && selBox.cursor && order.includes(selBox.cursor) ? selBox.cursor : null;
    const setSel = useCallback(
        (next: Selection | ((s: Selection) => Selection)) =>
            setSelBox((b) => {
                const cur = b.path === listedPath ? b.sel : EMPTY_SELECTION;
                return { path: listedPath, sel: typeof next === "function" ? next(cur) : next, cursor: b.path === listedPath ? b.cursor : null };
            }),
        [listedPath],
    );
    const setCursor = useCallback((c: string | null) => setSelBox((b) => ({ path: listedPath, sel: b.path === listedPath ? b.sel : EMPTY_SELECTION, cursor: c })), [listedPath]);

    const enabled = connected && link === "open";
    const selected = sel.names;
    const pathOf = useCallback((name: string) => joinPath(listedPath, name), [listedPath]);

    const open = useCallback(
        (item: FileItem, edit = false) => {
            if (isDir(item)) {
                navigateTo(item.name);
                return;
            }
            const bytes = bytesOf(item);
            if (!edit && previewKind(item.name, bytes) === "download") {
                void ops.download([pathOf(item.name)]);
                return;
            }
            setViewer({ path: pathOf(item.name), name: item.name, bytes, edit });
        },
        [navigateTo, ops, pathOf],
    );

    const askDelete = (names: string[]) => names.length && setDeleteNames(names);
    const askRename = (name: string) => setNameDlg({ kind: "rename", initial: name });

    // ------------------------------------------------------------ uploads (button + drop)

    const startUpload = useCallback(
        (files: File[]) => {
            if (!files.length) return;
            const existing = new Set(sorted.filter((i) => !isDir(i)).map((i) => i.name));
            const clash = files.filter((f) => existing.has(f.name)).map((f) => f.name);
            setShowUploads(true);
            if (clash.length) setReplace({ files, names: clash });
            else ops.enqueue(files);
        },
        [sorted, ops],
    );

    const onDropFiles = (e: React.DragEvent) => {
        const files: File[] = [];
        let folders = 0;
        for (const item of Array.from(e.dataTransfer.items ?? [])) {
            if (item.kind !== "file") continue;
            const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.();
            if (entry?.isDirectory) {
                folders++;
                continue;
            }
            const f = item.getAsFile();
            if (f) files.push(f);
        }
        if (!files.length && !folders) files.push(...Array.from(e.dataTransfer.files ?? []));
        if (folders) showError(t("files.drop.noFolders", { count: folders }));
        startUpload(files);
    };

    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
    const hasRows = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DND_TYPE);

    // ------------------------------------------------------------ keyboard

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!enabled) return;
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable=true]") && !target.closest("[data-row-check]")) return;
        const action = fileKeyAction(e);
        if (!action) return;
        const current = cursor ? byName.get(cursor) : undefined;
        const chosen = selected.length ? [...selected] : cursor ? [cursor] : [];
        e.preventDefault();
        switch (action) {
            case "open":
                if (current) open(current);
                break;
            case "up":
                goUp();
                break;
            case "rename": {
                const name = selected.length === 1 ? selected[0] : cursor;
                if (name) askRename(name);
                break;
            }
            case "delete":
                askDelete(chosen);
                break;
            case "selectAll":
                setSel(selectAll(order));
                break;
            case "next":
            case "prev": {
                const next = moveCursor(order, cursor, action === "next" ? 1 : -1);
                setCursor(next);
                if (next && e.shiftKey) setSel((s) => selectRange(s.anchor ? s : selectOnly(cursor ?? next), order, next));
                if (next) document.getElementById(rowId(next))?.scrollIntoView({ block: "nearest" });
                break;
            }
            case "clear":
                setSel(EMPTY_SELECTION);
                break;
        }
    };
    const rowId = (name: string) => `fm-${serverId}-${encodeURIComponent(name)}`;

    // ------------------------------------------------------------ rendering

    const summary = uploadSummary(ops.uploads);
    const folderInSelection = (names: string[]) => names.some((n) => { const i = byName.get(n); return !!i && isDir(i); });
    const chmodInitial = chmodNames?.length === 1 ? (() => { const i = byName.get(chmodNames[0]); return i ? parseMode(i.mode ?? "") ?? modeFromString(i.perm ?? i.permissions?.string) : null; })() : null;
    const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

    const keyHints = KEY_HINTS.map((h) => (
        <span key={h.keys} className="inline-flex items-center gap-1">
            <kbd className="rounded-sm border border-border bg-surface px-1 font-mono text-[0.7rem] text-foreground">{h.keys}</kbd>
            {t(h.label)}
        </span>
    ));

    const rowMenu = (item: FileItem) => {
        const dir = isDir(item);
        const kind = previewKind(item.name, bytesOf(item));
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 md:h-7 md:w-7 shrink-0" title={t("files.actions")} onClick={(e) => e.stopPropagation()} disabled={!enabled}>
                        <MoreHorizontal size={15} />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    {dir ? (
                        <DropdownMenuItem onSelect={() => open(item)}><Folder size={14} /> {t("files.open")}</DropdownMenuItem>
                    ) : kind !== "download" ? (
                        <DropdownMenuItem onSelect={() => open(item)}><Eye size={14} /> {t("files.preview")}</DropdownMenuItem>
                    ) : null}
                    {!dir && kind === "text" && <DropdownMenuItem onSelect={() => open(item, true)}><Pencil size={14} /> {t("common.edit")}</DropdownMenuItem>}
                    <DropdownMenuItem onSelect={() => void ops.download([pathOf(item.name)])}><Download size={14} /> {dir ? t("files.downloadZip") : t("files.download")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => askRename(item.name)}><Pencil size={14} /> {t("files.rename.title")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDest({ mode: "move", names: [item.name] })}><FolderInput size={14} /> {t("files.move.menu")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDest({ mode: "copy", names: [item.name] })}><Copy size={14} /> {t("files.copy.menu")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setChmodNames([item.name])}><KeyRound size={14} /> {t("files.perm.title")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDetailsName(item.name)}><Info size={14} /> {t("files.details.title")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => askDelete([item.name])}><Trash2 size={14} /> {t("common.delete")}</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    };

    return (
        <div
            className="@container relative flex h-full flex-col bg-card text-card-foreground border-l border-border/50"
            onDragEnter={(e) => { if (enabled && hasFiles(e)) { e.preventDefault(); setDragFiles(true); } }}
            onDragOver={(e) => { if (enabled && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragFiles(false); }}
            onDrop={(e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                setDragFiles(false);
                if (enabled) onDropFiles(e);
            }}
        >
            <div className="p-3 border-b border-border/50 flex flex-col gap-3 shrink-0">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="min-w-0 text-sm flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="inline-flex items-center gap-2"><Folder size={16} className="shrink-0 text-primary" />{t("files.title")}</span>
                        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground" title={t("files.asAccount", { account: username })}>{username}</span>
                    </h2>
                    <div className="flex shrink-0 items-center gap-1">
                        <div className={cn("w-2 h-2 rounded-full mx-1", connecting || link === "connecting" ? "bg-warning animate-pulse" : enabled ? "bg-success" : "bg-destructive")} title={enabled ? t("common.connected") : t("common.disconnected")} />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setFlowOpen(true)} title={t("files.flow.button")} aria-label={t("files.flow.button")}>
                            {ops.busy ? <Loader2 size={14} className="animate-spin" /> : <Info size={14} />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refresh} disabled={!enabled || loading} title={t("files.refresh")}>
                            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                        </Button>
                    </div>
                </div>

                <form onSubmit={handlePathSubmit} className="flex gap-2">
                    <Button type="button" variant="outline" size="icon" className="h-9 md:h-8 w-9 md:w-8 shrink-0" onClick={goHome} disabled={!enabled} title={t("files.home")}>
                        <Home size={14} />
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={cn("h-9 md:h-8 w-9 md:w-8 shrink-0", dropRow === ".." && "ring-2 ring-primary")}
                        onClick={goUp}
                        disabled={!enabled || !parentPath(listedPath)}
                        title={t("files.goUp")}
                        onDragOver={(e) => { if (hasRows(e) && parentPath(listedPath)) { e.preventDefault(); setDropRow(".."); } }}
                        onDragLeave={() => setDropRow(null)}
                        onDrop={(e) => {
                            const up = parentPath(listedPath);
                            setDropRow(null);
                            if (!hasRows(e) || !up || !dragged.current) return;
                            e.preventDefault();
                            void ops.move(dragged.current, up);
                        }}
                    >
                        <CornerLeftUp size={14} />
                    </Button>
                    <Input
                        value={currentPath}
                        onChange={(e) => setCurrentPath(e.target.value)}
                        className="h-9 md:h-8 text-xs font-mono"
                        placeholder={t("files.pathPlaceholder")}
                        disabled={!enabled}
                        spellCheck={false}
                    />
                </form>

                {selected.length > 0 ? (
                    <div className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-1" role="toolbar" aria-label={t("files.bulk")}>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSel(EMPTY_SELECTION)} title={t("files.clearSelection")}><X size={14} /></Button>
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{t("files.selected", { count: selected.length })}</span>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!enabled} onClick={() => void ops.download(selected.map(pathOf))} title={selected.length > 1 ? t("files.downloadZip") : t("files.download")}><Download size={14} /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!enabled} onClick={() => setDest({ mode: "move", names: [...selected] })} title={t("files.move.menu")}><FolderInput size={14} /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!enabled} onClick={() => setDest({ mode: "copy", names: [...selected] })} title={t("files.copy.menu")}><Copy size={14} /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!enabled} onClick={() => setChmodNames([...selected])} title={t("files.perm.title")}><KeyRound size={14} /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" disabled={!enabled} onClick={() => askDelete([...selected])} title={t("common.delete")}><Trash2 size={14} /></Button>
                    </div>
                ) : (
                    <div className="flex gap-2">
                        <input type="file" multiple ref={fileInputRef} onChange={(e) => { startUpload(Array.from(e.target.files ?? [])); e.target.value = ""; }} className="hidden" />
                        <Button size="sm" className="flex-1 text-xs h-9 md:h-8 gap-2" onClick={() => fileInputRef.current?.click()} disabled={!enabled}>
                            <Upload size={14} /> {t("files.uploadFile")}
                        </Button>
                        <Button size="sm" variant="outline" className="h-9 md:h-8 gap-1.5 text-xs" onClick={() => setNameDlg({ kind: "mkdir", initial: "" })} disabled={!enabled} title={t("files.new.folder")} aria-label={t("files.new.folder")}>
                            <FolderPlus size={14} /> <span className="hidden @xs:inline">{t("files.new.folderShort")}</span>
                        </Button>
                        <Button size="sm" variant="outline" className="h-9 md:h-8 gap-1.5 text-xs" onClick={() => setNameDlg({ kind: "touch", initial: "" })} disabled={!enabled} title={t("files.new.file")} aria-label={t("files.new.file")}>
                            <FilePlus2 size={14} /> <span className="hidden @xs:inline">{t("files.new.fileShort")}</span>
                        </Button>
                    </div>
                )}

                {ops.uploads.length > 0 && (
                    <div className="rounded-md border border-border bg-surface text-xs">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                            <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground" onClick={() => setShowUploads((v) => !v)} aria-expanded={showUploads}>
                                {summary.active ? t("files.upload.progress", { done: summary.done, total: summary.total, percent: summary.percent }) : t("files.upload.finished", { done: summary.done, total: summary.total })}
                            </button>
                            {!summary.active && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={ops.clearUploads} title={t("common.dismiss")}><X size={13} /></button>}
                        </div>
                        <div className="h-1 bg-muted"><div className="h-1 bg-primary transition-[width]" style={{ width: `${summary.percent}%` }} /></div>
                        {/* 跑完了而且都成功就只留一行摘要。/ Once all finished fine, keep only the summary line. */}
                        {showUploads && (summary.active > 0 || summary.failed > 0) && (
                            <ul className="divide-y divide-border">
                                {ops.uploads.map((j) => (
                                    <li key={j.id} className="flex items-center gap-2 px-2 py-1">
                                        {j.state === "done" ? <CheckCircle2 size={12} className="shrink-0 text-success" /> : j.state === "failed" ? <XCircle size={12} className="shrink-0 text-destructive" /> : j.state === "uploading" ? <Loader2 size={12} className="shrink-0 animate-spin text-primary" /> : <Upload size={12} className="shrink-0 text-muted-foreground" />}
                                        <span className="min-w-0 flex-1 truncate font-mono" title={j.error ? `${j.name}: ${j.error}` : j.name}>{j.name}</span>
                                        <span className={cn("shrink-0 tabular-nums", j.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                                            {j.state === "failed" ? t("files.upload.failed") : j.state === "queued" ? t("files.upload.queued") : j.size ? `${Math.round((Math.min(j.loaded, j.size) / j.size) * 100)}%` : "100%"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 bg-background">
                {loading && items.length === 0 ? (
                    <div className="flex justify-center p-8">
                        <RefreshCw className="animate-spin text-muted-foreground" size={24} />
                    </div>
                ) : !enabled && !connecting && link !== "connecting" ? (
                    <div className="flex flex-col items-center justify-center p-8 gap-3">
                        <div className="p-3 rounded-full bg-destructive/10">
                            <WifiOff size={24} className="text-destructive" />
                        </div>
                        <p className="text-sm text-foreground">{link === "offline" ? t("files.offline") : link === "stepup" ? t("files.stepUp") : t("files.connectionLost")}</p>
                        <p className="text-xs text-muted-foreground text-center">{link === "offline" ? t("files.offlineHint") : link === "stepup" ? t("files.stepUpHint") : t("files.unableToConnect")}</p>
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={reconnect} className="gap-1.5 text-xs mt-1">
                                <RefreshCw size={13} /> {t("common.reconnect")}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setFlowOpen(true)} className="gap-1.5 text-xs mt-1">
                                <Info size={13} /> {t("files.flow.button")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        {error && (
                            <div className="p-3">
                                <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm">
                                    <WifiOff size={14} className="text-destructive shrink-0 mt-0.5" />
                                    <p className="flex-1 min-w-0 text-xs text-destructive break-words">{error}</p>
                                    <button onClick={() => setError(null)} className="text-destructive/60 hover:text-destructive shrink-0" title={t("common.dismiss")}>
                                        <X size={14} />
                                    </button>
                                </div>
                            </div>
                        )}
                        {items.length === 0 && !error ? (
                            <div className="p-8 text-center text-muted-foreground text-sm">
                                {t("files.emptyDirectory")}
                                {enabled && <p className="mt-1 text-xs">{t("files.drop.hint")}</p>}
                            </div>
                        ) : (
                            <ul
                                ref={listRef}
                                className="divide-y divide-border/50 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                                tabIndex={0}
                                role="listbox"
                                aria-multiselectable
                                aria-label={t("files.title")}
                                aria-activedescendant={cursor ? rowId(cursor) : undefined}
                                onKeyDown={onKeyDown}
                            >
                                {sorted.map((item) => {
                                    const dir = isDir(item);
                                    const checked = isSelected(sel, item.name);
                                    const mtime = typeof item.mtime === "number" ? dateFmt.format(new Date(item.mtime * 1000)) : item.date;
                                    return (
                                        <li
                                            key={item.name}
                                            id={rowId(item.name)}
                                            role="option"
                                            aria-selected={checked}
                                            draggable={enabled}
                                            onDragStart={(e) => {
                                                const names = checked ? [...selected] : [item.name];
                                                dragged.current = names;
                                                e.dataTransfer.setData(DND_TYPE, JSON.stringify(names));
                                                e.dataTransfer.effectAllowed = "move";
                                            }}
                                            onDragEnd={() => { dragged.current = null; setDropRow(null); }}
                                            onDragOver={(e) => {
                                                if (!dir || !hasRows(e) || dragged.current?.includes(item.name)) return;
                                                e.preventDefault();
                                                e.dataTransfer.dropEffect = "move";
                                                setDropRow(item.name);
                                            }}
                                            onDragLeave={() => setDropRow((r) => (r === item.name ? null : r))}
                                            onDrop={(e) => {
                                                if (!dir || !hasRows(e) || !dragged.current) return;
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setDropRow(null);
                                                void ops.move(dragged.current, pathOf(item.name));
                                            }}
                                            onClick={(e) => {
                                                setCursor(item.name);
                                                if (e.shiftKey) setSel((s) => selectRange(s, order, item.name));
                                                else if (e.ctrlKey || e.metaKey) setSel((s) => toggleSelection(s, item.name));
                                                else if (enabled) open(item);
                                            }}
                                            className={cn(
                                                "group flex cursor-pointer items-center gap-2 px-2 py-2.5 md:py-1.5 text-sm transition-colors",
                                                checked ? "bg-primary/8" : "hover:bg-muted/50",
                                                cursor === item.name && "ring-1 ring-inset ring-primary/40",
                                                dropRow === item.name && "bg-primary/15 ring-2 ring-inset ring-primary",
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                data-row-check
                                                className={cn("size-4 shrink-0 accent-(--primary) transition-opacity", checked || selected.length ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100")}
                                                checked={checked}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={() => { setCursor(item.name); setSel((s) => toggleSelection(s, item.name)); }}
                                                aria-label={t("files.select", { name: item.name })}
                                                tabIndex={-1}
                                            />
                                            <span className="shrink-0"><FileIcon item={item} /></span>
                                            <span className={cn("min-w-0 flex-1 truncate", dir && "text-foreground")} title={item.name}>
                                                {item.name}
                                                {item.link && <Link2 size={11} className="ml-1 inline-block align-[-1px] text-muted-foreground" aria-label={t("files.type.symlink")} />}
                                            </span>
                                            {item.perm && <span className="hidden @md:block shrink-0 font-mono text-xs text-muted-foreground">{item.perm}</span>}
                                            {mtime && <span className="hidden @lg:block shrink-0 w-32 text-right text-xs text-muted-foreground tabular-nums">{mtime}</span>}
                                            <span className="hidden @xs:block w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{dir ? "" : sizeText(item)}</span>
                                            {rowMenu(item)}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </>
                )}
            </div>

            {/* 鍵盤提示：寬的時候直接列出，窄的時候收在一個按鈕裡（不占列表的高度）。只給有滑鼠的裝置。
                Keyboard hint: inline when wide, behind one button when narrow (keeps the list tall). Pointer devices only. */}
            <div className="hidden pointer-fine:flex shrink-0 items-center border-t border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
                <div className="hidden @md:flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t("files.key.title")}>{keyHints}</div>
                <Popover>
                    <PopoverTrigger asChild>
                        <button type="button" className="inline-flex items-center gap-1.5 hover:text-foreground @md:hidden">
                            <Keyboard size={13} aria-hidden /> {t("files.key.title")}
                        </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" side="top" className="w-auto p-3">
                        <div className="grid gap-1.5 text-xs text-muted-foreground">{keyHints}</div>
                    </PopoverContent>
                </Popover>
            </div>

            {dragFiles && (
                <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-card/90">
                    <div className="flex flex-col items-center gap-2 px-4 text-center text-sm text-foreground">
                        <Upload size={22} className="text-primary" />
                        {t("files.drop.here")}
                        <span className="max-w-full truncate font-mono text-xs text-muted-foreground">{username}:{listedPath}</span>
                    </div>
                </div>
            )}

            <NameDialog
                kind={nameDlg?.kind ?? null}
                initial={nameDlg?.initial ?? ""}
                taken={order}
                onClose={() => setNameDlg(null)}
                onSubmit={async (name) => {
                    if (!nameDlg) return false;
                    if (nameDlg.kind === "mkdir") return ops.mkdir(name);
                    if (nameDlg.kind === "touch") {
                        const ok = await ops.touch(name);
                        if (ok) setViewer({ path: pathOf(name), name, bytes: 0, edit: true });
                        return ok;
                    }
                    return ops.rename(nameDlg.initial, name);
                }}
            />
            <DeleteDialog names={deleteNames} onClose={() => setDeleteNames(null)} count={ops.countDelete} onConfirm={ops.remove} />
            <DestinationDialog
                mode={dest?.mode ?? null}
                names={dest?.names ?? []}
                initial={listedPath}
                onClose={() => setDest(null)}
                onSubmit={(to) => (dest?.mode === "copy" ? ops.copy(dest.names, to) : ops.move(dest?.names ?? [], to))}
            />
            <ChmodDialog
                names={chmodNames}
                initialMode={chmodInitial}
                hasFolder={!!chmodNames && folderInSelection(chmodNames)}
                onClose={() => setChmodNames(null)}
                onSubmit={(mode, recursive) => ops.chmod(chmodNames ?? [], mode, recursive)}
            />
            <DetailsDialog name={detailsName} account={username} load={ops.stat} onClose={() => setDetailsName(null)} />
            <FileViewerDialog target={viewer} ops={ops} onClose={() => setViewer(null)} onSaved={refresh} />
            <FileFlowDialog
                isOpen={flowOpen}
                onClose={() => setFlowOpen(false)}
                ctx={{ link, busy: ops.busy ?? (loading ? { kind: "listing" } : null), account: username, deviceName: deviceName || t("files.flow.device"), path: listedPath, shell: shellType }}
            />
            <ConfirmDialog
                isOpen={!!replace}
                onClose={() => setReplace(null)}
                onConfirm={() => { if (replace) ops.enqueue(replace.files); }}
                title={t("files.replace.title", { count: replace?.names.length ?? 0 })}
                message={t("files.replace.body", { names: replace?.names.slice(0, 5).join(", ") ?? "" })}
                confirmText={t("files.replace.action")}
                isDestructive
            />
        </div>
    );
}
