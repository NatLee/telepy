"use client";

/**
 * 網頁內 RustDesk 的「檔案」面板：列出遠端那台的資料夾、下載到瀏覽器、從瀏覽器上傳（每個檔案 ≤ 2 GB），附進度。
 * - RustDesk 的傳檔是另一條連線（登入成 file_transfer），所以先向 `POST …/rustdesk/{sid}/files` 要一個子 session，
 *   再用 RustDesk 核心自己的檔案 API（`read_remote_dir` / `send_files` / `select_files` + `send_local_files`）。
 * - 核心是 window 上的全域物件，而且同一個核心裡「最上面」的 session 才拿得到畫面：檔案 session 若開在畫面那個
 *   核心裡，遠端畫面就停了。所以這裡在一個看不見的同源 iframe 裡再載一份核心，各管各的。
 * - 存檔 / 選檔對話框要使用者的點擊：在這一頁（點擊發生的地方）開，再交給 iframe 裡的核心（存檔把手、選好的 File）。
 *   沒有存檔對話框的瀏覽器（Firefox / Safari）由核心整個放記憶體再下載，所以有 2 GB 的上限。
 * - Telepy 只中繼：中繼只准這條登入成傳檔（`codec::LoginGuard`），檔案內容不經後端解析。
 * The in-browser RustDesk Files panel. RustDesk transfers files on a second connection, so the panel asks for a files
 * child session and drives the core's own file API. A second copy of the core runs in a hidden same-origin iframe:
 * inside one core only the top-most session gets video, so a files session there would freeze the picture.
 * Pickers need the user's click, so they open in this page and the handle / files are handed to the iframe's core.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, Download, Eye, EyeOff, File as FileIcon, Folder, HardDrive, Home, Info, Loader2, RefreshCw, Upload, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { apiFetch, readJson } from "@/lib/api";
import { getWsOrigin } from "@/lib/wsCommon";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { classifyMsgbox, peerIdFor, RUSTDESK_CORE_URL, rustdeskCloseFailure, rustdeskWsUrl, type RustDeskCore, type RustDeskFilesStart, type RustDeskStart } from "@/lib/rustdesk";
import { activeJobs, applyJobEvent, crumbsFor, formatBytes, isWindowsPeer, joinRemote, jobPercent, parentRemote, parseFileDir, withinLimit, type Job, type JobEvent, type RemoteDir, type RemoteEntry } from "@/lib/rustdeskFiles";
import type { TranslationKey } from "@/locales/en";

type FrameWindow = Window & typeof globalThis & Partial<RustDeskCore> & {
    onGlobalEvent?: ((json: string) => void) | null;
    onInitFinished?: (() => void) | null;
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<unknown>;
};

type SaveFilePicker = (opts?: { suggestedName?: string }) => Promise<unknown>;

/** 看不見的同源 iframe + 一份自己的核心。/ A hidden same-origin iframe with its own copy of the core. */
function createCoreFrame(): Promise<{ frame: HTMLIFrameElement; win: FrameWindow }> {
    return new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        frame.title = "rustdesk-files";
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";
        document.body.appendChild(frame);
        const win = frame.contentWindow as FrameWindow | null;
        const doc = frame.contentDocument;
        if (!win || !doc) {
            frame.remove();
            reject(new Error("no iframe document"));
            return;
        }
        const s = doc.createElement("script");
        s.src = new URL(RUSTDESK_CORE_URL, window.location.href).href;
        s.onload = () => (typeof win.init === "function" && typeof win.setByName === "function" ? resolve({ frame, win }) : reject(new Error("core did not install")));
        s.onerror = () => reject(new Error("core failed to load"));
        (doc.head ?? doc.documentElement).appendChild(s);
    });
}

/**
 * 核心的 select_files 會建一個 <input type=file> 再 click()；那個 click 不在使用者的手勢裡（手勢在這一頁），
 * 所以把 iframe 裡的 click 換成「放進這一頁已經選好的檔案」。沒有待傳的檔案時照原本的行為。
 * The core's select_files creates a file input and clicks it outside any user gesture; hand it the files already
 * picked in this page instead. Without pending files the native click runs.
 */
function patchFileInput(win: FrameWindow, take: () => File[] | null) {
    const proto = win.HTMLInputElement.prototype;
    const nativeClick = proto.click;
    proto.click = function patchedClick(this: HTMLInputElement) {
        const files = this.type === "file" ? take() : null;
        if (files) {
            const dt = new win.DataTransfer();
            for (const f of files) dt.items.add(f);
            this.files = dt.files;
            this.onchange?.(new win.Event("change"));
            return;
        }
        nativeClick.call(this);
    };
}

type Phase = "starting" | "connecting" | "ready" | "failed";

const START_ERROR: Record<string, TranslationKey> = {
    file_transfer_disabled: "desktop.files.err.disabled",
    not_connected: "desktop.files.err.notConnected",
    desktop_disabled: "desktop.err.disabled",
    device_offline: "desktop.err.deviceOffline",
    target_unreachable: "desktop.err.rdDirectIpOff",
};

interface Props {
    /** 畫面那條 session。/ The screen session. */
    parent: RustDeskStart;
    /** RustDesk 的密碼（檔案連線也要登入）。/ The RustDesk password (the files connection logs in too). */
    password: string;
    onClose: () => void;
    /** 面板狀態（說明圖用）。/ The panel's state, for the info diagram. */
    onStateChange?: (open: boolean) => void;
}

export function RustDeskFiles({ parent, password, onClose, onStateChange }: Props) {
    const { t, locale } = useI18n();
    const [phase, setPhase] = useState<Phase>("starting");
    const [failure, setFailure] = useState<TranslationKey | null>(null);
    const [failureText, setFailureText] = useState("");
    const [dir, setDir] = useState<RemoteDir | null>(null);
    const [home, setHome] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showHidden, setShowHidden] = useState(false);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [platform, setPlatform] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const winRef = useRef<FrameWindow | null>(null);
    const dirRef = useRef<RemoteDir | null>(null);
    const jobId = useRef(1);
    const pendingFiles = useRef<File[] | null>(null);
    const uploadTarget = useRef(new Map<number, string>());
    const fileInput = useRef<HTMLInputElement | null>(null);
    const showHiddenRef = useRef(showHidden);
    const passwordRef = useRef(password);
    // t 換語言時會變；連線只建一次，所以從 ref 讀。/ `t` changes with the language; the connection is built once.
    const tRef = useRef(t);
    const windows = isWindowsPeer(platform);
    const windowsRef = useRef(windows);
    useEffect(() => {
        dirRef.current = dir;
        tRef.current = t;
        showHiddenRef.current = showHidden;
        windowsRef.current = windows;
    });

    const call = useCallback((name: string, arg?: unknown) => {
        const w = winRef.current;
        if (!w?.setByName) return;
        w.setByName(name, typeof arg === "string" || arg === undefined ? arg : JSON.stringify(arg));
    }, []);

    const open = useCallback((path: string) => {
        setLoading(true);
        call("read_remote_dir", { path, include_hidden: showHiddenRef.current });
    }, [call]);

    useEffect(() => {
        onStateChange?.(true);
        return () => onStateChange?.(false);
    }, [onStateChange]);

    useEffect(() => {
        let disposed = false;
        let frame: HTMLIFrameElement | null = null;
        // 這次開的子 session；還沒連上就被收掉時請後端作廢票證。/ This run's child session; voided when dropped unconnected.
        let childId: string | null = null;
        let childConnected = false;
        const fail = (key: TranslationKey, text = "") => {
            if (disposed) return;
            setFailure(key);
            setFailureText(text);
            setPhase("failed");
            setLoading(false);
        };
        (async () => {
            const res = await apiFetch(`/api/reverse/server/rustdesk/${parent.session_id}/files`, { method: "POST", body: "{}" }).catch(() => null);
            if (!res) return fail("desktop.err.network");
            const data = await readJson<RustDeskFilesStart & { code?: string; error?: string }>(res);
            if (!res.ok || !data?.ticket) return fail(START_ERROR[data?.code ?? ""] ?? "desktop.files.err.start", data?.error ?? "");
            childId = data.session_id;
            if (disposed) {
                void apiFetch(`/api/reverse/server/rustdesk/${data.session_id}/stop`, { method: "POST", body: "{}" }).catch(() => undefined);
                return;
            }
            setPhase("connecting");
            let made: { frame: HTMLIFrameElement; win: FrameWindow };
            try {
                made = await createCoreFrame();
            } catch {
                return fail("desktop.err.rdCore");
            }
            frame = made.frame;
            const win = made.win;
            if (disposed) {
                frame.remove();
                return;
            }
            winRef.current = win;
            // 上傳：核心的 select_files 會建一個 <input type=file> 再 click()；那個 click 不在使用者的手勢裡，
            // 所以換成「把這一頁選好的檔案放進去」。/ Uploads: hand the files picked in this page to the core's input.
            patchFileInput(win, () => {
                const files = pendingFiles.current;
                pendingFiles.current = null;
                return files;
            });
            win.onGlobalEvent = (json: string) => {
                let e: Record<string, unknown>;
                try {
                    e = JSON.parse(json);
                } catch {
                    return;
                }
                const name = String(e.name ?? "");
                switch (name) {
                    case "peer_info":
                        childConnected = true;
                        setPlatform(String(e.platform ?? ""));
                        setPhase("ready");
                        // 登入後裝置不一定主動送第一個清單：自己要一次（空路徑 = 家目錄）。/ Ask for the first listing (empty = home).
                        if (!dirRef.current) call("read_remote_dir", { path: "", include_hidden: showHiddenRef.current });
                        break;
                    case "file_dir": {
                        if (e.is_local === "true") break;
                        const d = parseFileDir(e.value);
                        if (!d) break;
                        setDir(d);
                        setHome((h) => h ?? d.path);
                        setLoading(false);
                        setPhase("ready");
                        break;
                    }
                    case "job_progress":
                    case "job_done":
                    case "job_error":
                    case "update_folder_files":
                    case "override_file_confirm":
                        setJobs((list) => applyJobEvent(list, e as unknown as JobEvent));
                        // 上傳完成 → 重讀它所在的資料夾。/ An upload finished: re-read its folder.
                        if (name === "job_done") {
                            const target = uploadTarget.current.get(Number(e.id));
                            const cur = dirRef.current;
                            if (target && cur && parentRemote(target, windowsRef.current) === cur.path) open(cur.path);
                        }
                        break;
                    case "selected_files": {
                        let f: { name?: string; size?: number } = {};
                        try {
                            f = JSON.parse(String(e.file ?? "{}"));
                        } catch {
                            break;
                        }
                        const cur = dirRef.current;
                        const fileName = String(f.name ?? "file");
                        const size = Number(f.size) || 0;
                        const id = jobId.current++;
                        if (!cur) break;
                        if (!withinLimit(size)) {
                            setJobs((list) => [...list, { id, kind: "upload", name: fileName, total: size, done: 0, speed: 0, state: "failed", error: tRef.current("desktop.files.tooLarge") }]);
                            break;
                        }
                        const to = joinRemote(cur.path, fileName, windowsRef.current);
                        uploadTarget.current.set(id, to);
                        setJobs((list) => [...list, { id, kind: "upload", name: fileName, total: size, done: 0, speed: 0, state: "running", error: null }]);
                        call("send_local_files", { id, handle_index: String(e.handleIndex ?? ""), to });
                        break;
                    }
                    case "msgbox": {
                        const m = { type: String(e.type ?? ""), title: String(e.title ?? ""), text: String(e.text ?? "") };
                        const closed = /WebSocket closed \((\d+)\)/.exec(m.text);
                        if (closed) {
                            const code = Number(closed[1]);
                            if (code === 4403) fail("desktop.files.err.refused");
                            else if (code === 4014) fail("desktop.files.err.ended");
                            else fail(rustdeskCloseFailure(code)?.key ?? "desktop.files.err.ended");
                            break;
                        }
                        if (m.type === "success") break;
                        const action = classifyMsgbox(m);
                        // 核心先發事件、之後才等答案：下一個 tick 再答。/ The core stores the resolver after emitting: answer next tick.
                        if (action.kind === "continue") setTimeout(() => call("common", { name: "continue-insecure-connection", value: "Y" }), 0);
                        else if (action.kind === "failure") fail(action.failure.key, m.text);
                        break;
                    }
                    default:
                        break;
                }
            };
            if (!win.rdCore?.ready) {
                await new Promise<void>((resolve) => {
                    win.onInitFinished = () => resolve();
                    win.init?.();
                });
            }
            if (disposed) return;
            const url = rustdeskWsUrl(getWsOrigin(), data);
            call("option", { name: "custom-rendezvous-server", value: url });
            call("option", { name: "relay-server", value: url });
            call("option", { name: "key", value: "" });
            call("session_add_sync", { id: peerIdFor(data), password: passwordRef.current, isFileTransfer: true, isTerminal: false });
            call("session_start", { id: peerIdFor(data) });
        })();
        return () => {
            disposed = true;
            const w = winRef.current;
            if (w?.setByName) {
                try {
                    w.setByName("session_close", "");
                } catch {
                    // 已經關了。/ Already closed.
                }
            }
            if (w) w.onGlobalEvent = null;
            winRef.current = null;
            frame?.remove();
            if (childId && !childConnected) void apiFetch(`/api/reverse/server/rustdesk/${childId}/stop`, { method: "POST", body: "{}", keepalive: true }).catch(() => undefined);
        };
    }, [parent.session_id, call, open]);

    const download = async (entry: RemoteEntry) => {
        const cur = dirRef.current;
        if (!cur || entry.isDir) return;
        if (!withinLimit(entry.size)) {
            setNotice(t("desktop.files.tooLarge"));
            return;
        }
        const w = winRef.current;
        if (!w) return;
        // 存檔對話框在這一頁開（點擊在這裡），把手交給 iframe 裡的核心。/ Open the save dialog here, hand the handle over.
        const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
        let restore: (() => void) | null = null;
        if (picker) {
            let handle: unknown;
            try {
                handle = await picker.call(window, { suggestedName: entry.name });
            } catch (err) {
                if ((err as { name?: string })?.name === "AbortError") return;
                handle = null;
            }
            if (handle) {
                const before = w.showSaveFilePicker;
                w.showSaveFilePicker = async () => handle;
                restore = () => {
                    w.showSaveFilePicker = before;
                };
            }
        }
        const id = jobId.current++;
        setJobs((list) => [...list, { id, kind: "download", name: entry.name, total: entry.size, done: 0, speed: 0, state: "running", error: null }]);
        call("send_files", { id, path: joinRemote(cur.path, entry.name, windows), include_hidden: false, is_remote: true, is_dir: false });
        setTimeout(() => restore?.(), 0);
    };

    const upload = (files: File[]) => {
        if (files.length === 0 || !dirRef.current) return;
        pendingFiles.current = files;
        call("select_files", "false");
    };

    const cancel = (j: Job) => {
        call("cancel_job", String(j.id));
        setJobs((list) => list.map((x) => (x.id === j.id ? { ...x, state: "cancelled", speed: 0 } : x)));
    };
    const decide = (j: Job, replace: boolean) => {
        call("confirm_override_file", { id: j.id, file_num: j.confirm?.fileNum ?? 0, need_override: replace, is_upload: true });
        setJobs((list) => list.map((x) => (x.id === j.id ? { ...x, state: replace ? "running" : "cancelled", confirm: undefined } : x)));
    };

    const ready = phase === "ready" && !!dir;
    const crumbs = dir ? crumbsFor(dir.path, windows) : [];
    const up = dir ? parentRemote(dir.path, windows) : null;
    const running = activeJobs(jobs);
    // 清單只顯示最近幾筆（還在跑的優先），不讓傳輸把檔案清單擠掉。/ Show the latest few (running first) so transfers never crowd the listing.
    const shownJobs = [...jobs.filter((j) => j.state === "running" || j.state === "confirm"), ...jobs.filter((j) => j.state !== "running" && j.state !== "confirm").reverse()].slice(0, 4);
    const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);

    return (
        <aside className="@container flex h-full min-h-0 flex-col bg-card text-card-foreground" aria-label={t("desktop.files.title")}>
            <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <Folder size={16} className="shrink-0 text-primary" aria-hidden /> {t("desktop.files.title")}
                        <span className={cn("size-2 shrink-0 rounded-full", phase === "ready" ? "bg-success" : phase === "failed" ? "bg-destructive" : "animate-pulse bg-warning")} title={t(phase === "ready" ? "common.connected" : phase === "failed" ? "common.disconnected" : "desktop.files.connecting")} />
                    </h2>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => dir && open(dir.path)} disabled={!ready || loading} title={t("common.refresh")} aria-label={t("common.refresh")}>
                            <RefreshCw size={14} className={loading && phase === "ready" ? "animate-spin" : ""} />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
                            <X size={14} />
                        </Button>
                    </div>
                </div>
                {ready && (
                    <>
                        <nav className="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-xs" aria-label={t("desktop.files.path")}>
                            {crumbs.map((c, i) => (
                                <React.Fragment key={c.path || "root"}>
                                    {i > 1 && <span className="text-muted-foreground">{windows ? "\\" : "/"}</span>}
                                    <button type="button" onClick={() => open(c.path)} className={cn("max-w-40 truncate rounded-sm px-1 hover:bg-muted", i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground")}>
                                        {c.label || t("desktop.files.drives")}
                                    </button>
                                </React.Fragment>
                            ))}
                        </nav>
                        <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => up !== null && open(up)} disabled={up === null} title={t("desktop.files.up")} aria-label={t("desktop.files.up")}>
                                <ArrowUp size={14} />
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => home !== null && open(home)} disabled={home === null} title={t("desktop.files.home")} aria-label={t("desktop.files.home")}>
                                <Home size={14} />
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => { const next = !showHidden; setShowHidden(next); showHiddenRef.current = next; if (dir) open(dir.path); }} aria-pressed={showHidden} title={t("desktop.files.hidden")} aria-label={t("desktop.files.hidden")}>
                                {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                            </Button>
                            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                            <Button size="sm" className="h-8 flex-1 gap-1.5 text-xs" onClick={() => fileInput.current?.click()}>
                                <Upload size={14} /> {t("desktop.files.upload")}
                            </Button>
                        </div>
                    </>
                )}
                {notice && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                        <span className="min-w-0 flex-1">{notice}</span>
                        <button type="button" onClick={() => setNotice(null)} aria-label={t("common.dismiss")}><X size={12} /></button>
                    </p>
                )}
            </div>

            {jobs.length > 0 && (
                <div className="shrink-0 border-b border-border bg-surface text-xs">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
                        <span className="min-w-0 flex-1">{running > 0 ? t("desktop.files.transfersActive", { count: running }) : t("desktop.files.transfersDone")}</span>
                        {running === 0 && <button type="button" className="hover:text-foreground" onClick={() => setJobs([])} title={t("common.dismiss")} aria-label={t("common.dismiss")}><X size={13} /></button>}
                    </div>
                    <ul className="divide-y divide-border">
                        {shownJobs.map((j) => (
                            <li key={j.id} className="space-y-1 px-3 py-1.5" data-job={j.kind} data-state={j.state}>
                                <div className="flex items-center gap-2">
                                    {j.state === "done" ? <CheckCircle2 size={12} className="shrink-0 text-success" /> : j.state === "failed" ? <XCircle size={12} className="shrink-0 text-destructive" /> : j.state === "cancelled" ? <X size={12} className="shrink-0 text-muted-foreground" /> : j.kind === "download" ? <Download size={12} className="shrink-0 text-primary" /> : <Upload size={12} className="shrink-0 text-primary" />}
                                    <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={j.error ? `${j.name}: ${j.error}` : j.name}>{j.name}</span>
                                    <span className={cn("shrink-0 tabular-nums", j.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                                        {j.state === "failed" ? t("desktop.files.failed") : j.state === "cancelled" ? t("desktop.files.cancelled") : j.state === "done" ? formatBytes(j.total) : `${jobPercent(j)}%${j.speed > 0 ? ` · ${formatBytes(j.speed)}/s` : ""}`}
                                    </span>
                                    {(j.state === "running" || j.state === "confirm") && (
                                        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => cancel(j)} title={t("common.cancel")} aria-label={t("common.cancel")}><X size={12} /></button>
                                    )}
                                </div>
                                {j.state === "running" && <div className="h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-primary transition-[width]" style={{ width: `${jobPercent(j)}%` }} /></div>}
                                {j.state === "confirm" && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1 text-foreground">{t(j.confirm?.identical ? "desktop.files.identical" : "desktop.files.exists")}</span>
                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => decide(j, false)}>{t("desktop.files.skip")}</Button>
                                        <Button size="sm" className="h-6 px-2 text-xs" onClick={() => decide(j, true)}>{t("desktop.files.replace")}</Button>
                                    </div>
                                )}
                                {j.state === "failed" && j.error && <p className="text-destructive [overflow-wrap:anywhere]">{j.error}</p>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div
                className={cn("min-h-0 flex-1 overflow-y-auto bg-background", dragging && "ring-2 ring-inset ring-primary")}
                onDragOver={(e) => { if (ready && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (ready) upload(Array.from(e.dataTransfer.files)); }}
            >
                {phase === "failed" ? (
                    <div className="p-3">
                        <Callout tone="danger">
                            <p>{t(failure ?? "desktop.files.err.start")}</p>
                            {failureText && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{failureText}</p>}
                        </Callout>
                    </div>
                ) : !dir ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center text-xs text-muted-foreground">
                        <Loader2 size={20} className="animate-spin" aria-hidden />
                        {t("desktop.files.connecting")}
                    </div>
                ) : dir.entries.length === 0 ? (
                    <p className="p-6 text-center text-xs text-muted-foreground">{t("desktop.files.empty")}</p>
                ) : (
                    <ul className="divide-y divide-border/60 text-sm">
                        {dir.entries.map((en) => (
                            <li key={en.name} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/60">
                                {en.isDrive ? <HardDrive size={16} className="shrink-0 text-muted-foreground" /> : en.isDir ? <Folder size={16} className="shrink-0 fill-info/15 text-info" /> : <FileIcon size={16} className="shrink-0 text-muted-foreground" />}
                                {en.isDir ? (
                                    <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground" onClick={() => open(joinRemote(dir.path, en.name, windows))} title={en.name}>{en.name}</button>
                                ) : (
                                    <span className="min-w-0 flex-1 truncate text-foreground" title={en.name}>{en.name}</span>
                                )}
                                {!en.isDir && (
                                    <>
                                        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @[18rem]:inline" title={en.modified ? dateFmt.format(new Date(en.modified * 1000)) : undefined}>{formatBytes(en.size)}</span>
                                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void download(en)} title={t("desktop.files.download")} aria-label={t("desktop.files.downloadName", { name: en.name })}>
                                            <Download size={14} />
                                        </Button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <p className="flex shrink-0 items-start gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <Info size={13} className="mt-px shrink-0" aria-hidden /> {t("desktop.files.footnote")}
            </p>
        </aside>
    );
}
