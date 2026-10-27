"use client";

/**
 * 工具箱面板：常用指令片段依範圍分組（最愛 / 我的 / 這台裝置 / 全站），可搜尋；「執行」填好變數後把指令打進作用中的
 * shell（每行一個 Enter，跟自己打字走同一條 `pty_input`，所以指令規則照樣檢查），「插入」只打字不按 Enter，「複製」
 * 複製原文；能改的可以編輯 / 刪除。空的工具箱提供內建範例一鍵加入。info 按鈕打開路徑圖（最近一次執行走到哪）。
 * The toolbox panel: snippets grouped by scope (favourites / mine / this device / site), searchable. Run fills the
 * variables and types the command into the active shell (one Enter per line, the same `pty_input` as the keyboard,
 * so command rules still apply); Insert types without Enter; Copy copies the text; editable ones can be changed or
 * deleted. An empty toolbox offers built-in examples. The info button opens the path diagram of the latest run.
 */
import React, { useMemo, useState } from "react";
import { Bookmark, Copy, Info, Loader2, Pencil, Play, Plus, Search, ShieldAlert, Star, TextCursorInput, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useSnippets } from "@/hooks/useSnippets";
import type { HoldBanner } from "@/lib/commandRules";
import {
    addedBuiltins, askedVariables, BUILTIN_SNIPPETS, draftFromBuiltin, groupSnippets, isMultiline, settle, stageFromBanner,
    terminalLines, typeLines, type RunStage, type Snippet, type SnippetScope, type ToolboxTarget,
} from "@/lib/snippets";
import type { TranslationKey } from "@/locales/en";
import { SnippetDialog } from "./SnippetDialog";
import { RunSnippetDialog } from "./RunSnippetDialog";
import { ToolboxInfoDialog } from "./ToolboxFlow";

interface Props {
    target: ToolboxTarget;
    tunnelName: string;
    /** 送出之後（手機上關掉底部面板、聚焦終端機）。/ After sending (close the phone sheet, focus the terminal). */
    onSent?: () => void;
    /** 放在對話框裡：不重複標題、不自己捲（對話框本體是唯一的捲動區）。/ Inside a dialog: no title, no own scroll. */
    embedded?: boolean;
    className?: string;
}

interface LastRun {
    name: string;
    scope: SnippetScope;
    variableCount: number;
    stage: RunStage;
    at: number;
    /** 開始時的提示（之後換了一個 = 這次的結果）。/ The banner at the start (a new one = this run's outcome). */
    banner: HoldBanner | null;
}

/** 現在的時間（事件處理用，不在 render 裡呼叫）。/ The current time, for event handlers. */
const stamp = () => Date.now();

const GROUPS: { key: "favourites" | SnippetScope; label: TranslationKey }[] = [
    { key: "favourites", label: "toolbox.group.favourites" },
    { key: "user", label: "toolbox.group.user" },
    { key: "tunnel", label: "toolbox.group.tunnel" },
    { key: "site", label: "toolbox.group.site" },
];

/**
 * 每個終端機最近一次執行（模組層）：手機的底部面板送出後就收起來（元件卸載），重新打開時 info 圖還要看得到結果。
 * The latest run per terminal (module level): the phone sheet closes (unmounts) after sending, and the info diagram
 * must still show the outcome when it reopens.
 */
const RUNS = new Map<string, LastRun>();

export function ToolboxPanel({ target, tunnelName, onSent, embedded = false, className }: Props) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const { data, loading, error, create, update, remove, markUsed, favourites, toggleFav } = useSnippets(target.tunnelId);
    const [query, setQuery] = useState("");
    const [editing, setEditing] = useState<Snippet | null | "new">(null);
    const [deleting, setDeleting] = useState<Snippet | null>(null);
    const [running, setRunning] = useState<{ snippet: Snippet; insert: boolean } | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);
    const runKey = `${target.tunnelId}|${target.where}`;
    const [lastRun, setLastRunState] = useState<LastRun | null>(() => RUNS.get(runKey) ?? null);
    const setLastRun = (next: LastRun | null | ((r: LastRun | null) => LastRun | null)) => {
        const value = typeof next === "function" ? next(RUNS.get(runKey) ?? null) : next;
        if (value) RUNS.set(runKey, value);
        else RUNS.delete(runKey);
        setLastRunState(value);
    };
    const [adding, setAdding] = useState<string | null>(null);


    /**
     * 送出之後看指令規則的提示：3 秒內出現新的 = 這次的結果；等核准時一直看到有結果（最多 15 分鐘）。
     * After sending, watch the command-rule banner: a new one within 3 s is this run's outcome; while it is held,
     * keep watching until it is decided (15 minutes at most).
     */
    const watchOutcome = (start: HoldBanner | null) => {
        const began = stamp();
        let seen: HoldBanner | null = start;
        const tick = () => {
            const b = target.banner();
            if (b && b !== seen) {
                seen = b;
                setLastRun((r) => (r ? { ...r, stage: stageFromBanner(b.state) } : r));
            }
            const pending = seen !== start && seen?.state === "pending";
            if (stamp() - began < (pending ? 15 * 60_000 : 3000)) setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
    };

    const list = useMemo(() => data?.snippets ?? [], [data]);
    const groups = useMemo(() => groupSnippets(list, query, favourites), [list, query, favourites]);
    const scopes: SnippetScope[] = ["user", ...(data?.tunnel?.can_edit ? (["tunnel"] as const) : []), ...(data?.can_edit_site ? (["site"] as const) : [])];

    const send = async (s: Snippet, command: string, enter: boolean) => {
        const start = target.banner();
        setLastRun({ name: s.name, scope: s.scope, variableCount: askedVariables(s).length, stage: "typing", at: stamp(), banner: start });
        setRunning(null);
        onSent?.();
        const outcome = await typeLines(terminalLines(command), enter, {
            send: target.send,
            settle: () => settle(target.onOutput),
            stopped: () => {
                const b = target.banner();
                return b !== start && b !== null && (b.state === "blocked" || b.state === "pending" || b.state === "error");
            },
        });
        if (outcome === "offline") {
            showError(t("toolbox.offline"));
            setLastRun((r) => (r ? { ...r, stage: "idle" } : r));
            return;
        }
        if (!enter) return;
        markUsed(s.id);
        const b = target.banner();
        setLastRun((r) => (r && r.stage === "typing" ? { ...r, stage: b && b !== start ? stageFromBanner(b.state) : "sent" } : r));
        watchOutcome(start);
    };

    const onRun = (s: Snippet) => {
        if (askedVariables(s).length > 0 || s.confirm) {
            setRunning({ snippet: s, insert: false });
        } else void send(s, s.command, true);
    };
    const onInsert = (s: Snippet) => {
        if (askedVariables(s).length > 0) setRunning({ snippet: s, insert: true });
        else void send(s, s.command, false);
    };
    const onCopy = (s: Snippet) => {
        navigator.clipboard.writeText(s.command).then(() => showSuccess(t("toolbox.copied")), () => showError(t("toolbox.copyFailed")));
    };

    const addBuiltin = async (id: string) => {
        const b = BUILTIN_SNIPPETS.find((x) => x.id === id);
        if (!b) return;
        setAdding(id);
        const res = await create("user", draftFromBuiltin(b, t));
        setAdding(null);
        if (!res.ok) showError(res.message ?? Object.values(res.fields)[0] ?? t("toolbox.saveFailed"));
    };

    const empty = !loading && list.length === 0;
    const nothingMatches = !empty && query.trim() !== "" && GROUPS.every((g) => groups[g.key].length === 0);

    return (
        <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
            <div className={cn("flex shrink-0 items-center gap-1.5 px-3 py-2", !embedded && "border-b border-border")}>
                {/* 標題已經在分頁 / 對話框上：這裡說在哪裡跑。/ The tab or dialog already names it; say where it runs. */}
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={t("toolbox.where", { where: target.where })}>{t("toolbox.where", { where: target.where })}</p>
                <Button variant="ghost" size="icon-sm" onClick={() => setInfoOpen(true)} title={t("toolbox.howItWorks")} aria-label={t("toolbox.howItWorks")}>
                    <Info size={15} />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing("new")} className="h-7 text-xs">
                    <Plus /> {t("toolbox.new")}
                </Button>
            </div>

            <div className={cn("space-y-3 p-3", !embedded && "min-h-0 flex-1 overflow-y-auto")}>
                {!empty && (
                    <div className="relative">
                        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("toolbox.search")} aria-label={t("toolbox.search")} className="h-8 pl-8 text-sm" />
                    </div>
                )}
                {!target.connected && <Callout tone="warning">{t("toolbox.offline")}</Callout>}
                {loading && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
                {error && <Callout tone="danger">{error}</Callout>}

                {empty && (
                    <Callout tone="tip" title={t("toolbox.emptyTitle")}>
                        {t("toolbox.emptyBody")}
                    </Callout>
                )}

                {GROUPS.map((g) => groups[g.key].length > 0 && (
                    <section key={g.key} className="space-y-1.5">
                        <h3 className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {g.key === "favourites" && <Star size={12} aria-hidden />}
                            <span className="truncate">{g.key === "tunnel" ? t("toolbox.group.tunnelNamed", { name: data?.tunnel?.name ?? tunnelName }) : t(g.label)}</span>
                            <span className="tabular-nums">· {groups[g.key].length}</span>
                        </h3>
                        <ul className="space-y-1.5">
                            {groups[g.key].map((s) => (
                                <SnippetRow
                                    key={s.id}
                                    snippet={s}
                                    favourite={favourites.includes(s.id)}
                                    connected={target.connected}
                                    showScope={g.key === "favourites"}
                                    onRun={() => onRun(s)}
                                    onInsert={() => onInsert(s)}
                                    onCopy={() => onCopy(s)}
                                    onFavourite={() => toggleFav(s.id)}
                                    onEdit={() => setEditing(s)}
                                    onDelete={() => setDeleting(s)}
                                />
                            ))}
                        </ul>
                    </section>
                ))}
                {nothingMatches && <p className="py-4 text-center text-sm text-muted-foreground">{t("toolbox.noMatch")}</p>}

                {!loading && <Examples list={list} open={empty} adding={adding} onAdd={addBuiltin} />}
            </div>

            <SnippetDialog
                isOpen={editing !== null}
                onClose={() => setEditing(null)}
                snippet={editing === "new" ? null : editing}
                scopes={scopes}
                tunnelName={data?.tunnel?.name ?? tunnelName}
                onSave={(scope, draft) => (editing && editing !== "new" ? update(editing.id, draft) : create(scope, draft))}
            />
            <RunSnippetDialog
                snippet={running?.snippet ?? null}
                insert={running?.insert ?? false}
                where={target.where}
                onClose={() => setRunning(null)}
                onRun={(command, enter) => running && void send(running.snippet, command, enter)}
            />
            <ConfirmDialog
                isOpen={deleting !== null}
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    if (!deleting) return;
                    const err = await remove(deleting.id);
                    if (err) showError(err);
                }}
                title={t("toolbox.deleteTitle")}
                message={t("toolbox.deleteMessage", { name: deleting?.name ?? "" })}
                confirmText={t("common.delete")}
                isDestructive
            />
            <ToolboxInfoDialog
                isOpen={infoOpen}
                onClose={() => setInfoOpen(false)}
                ctx={{
                    stage: lastRun?.stage ?? "idle",
                    snippetName: lastRun?.name ?? null,
                    scope: lastRun?.scope ?? null,
                    variableCount: lastRun?.variableCount ?? 0,
                    account: target.where.split("@")[0] ?? "",
                    tunnelName: target.where.split("@").slice(1).join("@") || tunnelName,
                }}
            />
        </div>
    );
}

const SCOPE_CHIP: Record<SnippetScope, TranslationKey> = { user: "toolbox.scope.user", tunnel: "toolbox.scope.tunnel", site: "toolbox.scope.site" };

function SnippetRow({ snippet: s, favourite, connected, showScope, onRun, onInsert, onCopy, onFavourite, onEdit, onDelete }: {
    snippet: Snippet;
    favourite: boolean;
    connected: boolean;
    showScope: boolean;
    onRun: () => void;
    onInsert: () => void;
    onCopy: () => void;
    onFavourite: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const { t } = useI18n();
    const lines = terminalLines(s.command);
    const vars = askedVariables(s).length;
    const multi = isMultiline(s.command);
    return (
        <li className="rounded-lg border border-border bg-card px-2.5 py-2">
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm text-foreground" title={s.description || s.name}>{s.name}</span>
                        {showScope && <Chip>{t(SCOPE_CHIP[s.scope])}</Chip>}
                        {vars > 0 && <Chip mono title={t("toolbox.varsTitle", { n: vars })}>{`$×${vars}`}</Chip>}
                        {s.confirm && <ShieldAlert size={13} className="text-warning" aria-label={t("toolbox.confirmTitle")} />}
                    </div>
                    <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={s.command}>
                        {lines[0]}{multi ? ` ⏎ +${lines.length - 1}` : ""}
                    </code>
                </div>
                <Button size="xs" onClick={onRun} disabled={!connected} title={connected ? t("toolbox.runTitle") : t("toolbox.offline")}>
                    <Play /> {t("toolbox.run")}
                </Button>
            </div>
            <div className="mt-1 flex items-center gap-0.5 text-muted-foreground">
                <Button variant="ghost" size="icon-xs" onClick={onFavourite} title={favourite ? t("toolbox.unfavourite") : t("toolbox.favourite")} aria-label={favourite ? t("toolbox.unfavourite") : t("toolbox.favourite")} aria-pressed={favourite}>
                    <Star className={favourite ? "fill-current text-primary" : undefined} />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={onInsert} disabled={!connected || multi} title={multi ? t("toolbox.insertMulti") : t("toolbox.insertTitle")} aria-label={t("toolbox.insert")}>
                    <TextCursorInput />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={onCopy} title={t("toolbox.copy")} aria-label={t("toolbox.copy")}>
                    <Copy />
                </Button>
                {s.use_count > 0 && <span className="ml-1 text-xs tabular-nums" title={t("toolbox.usedTitle")}>{t("toolbox.used", { n: s.use_count })}</span>}
                {s.can_edit && (
                    <span className="ml-auto flex items-center gap-0.5">
                        <Button variant="ghost" size="icon-xs" onClick={onEdit} title={t("common.edit")} aria-label={t("common.edit")}>
                            <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={onDelete} title={t("common.delete")} aria-label={t("common.delete")} className="hover:text-destructive">
                            <Trash2 />
                        </Button>
                    </span>
                )}
            </div>
        </li>
    );
}

/** 內建範例：空的工具箱直接展開，否則收在最下面。/ Built-in examples: open on an empty toolbox, folded at the bottom otherwise. */
function Examples({ list, open, adding, onAdd }: { list: Snippet[]; open: boolean; adding: string | null; onAdd: (id: string) => void }) {
    const { t } = useI18n();
    // 一開始空的就展開；之後由使用者決定（連加幾個時不會自己收起來）。/ Open when it starts empty; then the person decides.
    const [expanded, setExpanded] = useState(open);
    const added = addedBuiltins(list.filter((s) => s.scope === "user"));
    const left = BUILTIN_SNIPPETS.filter((b) => !added.has(b.id));
    if (left.length === 0) return null;
    return (
        <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)} className="group rounded-lg border border-dashed border-border">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground">
                <Bookmark size={13} aria-hidden /> {t("toolbox.examples", { n: left.length })}
            </summary>
            <ul className="space-y-1 px-2.5 pb-2.5">
                {left.map((b) => (
                    <li key={b.id} className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-foreground" title={t(b.descKey)}>{t(b.nameKey)}</div>
                            <code className="block truncate font-mono text-xs text-muted-foreground" title={b.command}>{terminalLines(b.command)[0]}</code>
                        </div>
                        <Button variant="outline" size="xs" onClick={() => onAdd(b.id)} disabled={adding !== null}>
                            {adding === b.id ? <Loader2 className="animate-spin" /> : <Plus />} {t("toolbox.add")}
                        </Button>
                    </li>
                ))}
            </ul>
        </details>
    );
}
