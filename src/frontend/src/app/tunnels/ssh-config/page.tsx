"use client";

/**
 * SSH config 編輯器（`/tunnels/ssh-config`，側欄工作區）：貼上整份 ~/.ssh/config，左邊是文字、右邊是分頁——主機總覽（點一台
 * 用表單改、加新的）、值得看一下（一鍵修正，先看會改到什麼）、簡化（逐一驗證過的精簡版，一鍵換上）、命令列
 * （`telepy config tidy` 直接改自己電腦上的檔）。兩欄各有自己的高度、工具列黏在上面，長設定不會把整頁拉長；手機上
 * 「設定」是其中一個分頁。全部在瀏覽器裡算，貼上的內容不送出也不保存；每次整份換掉之前記一筆，可以復原。
 * The SSH config editor: paste a whole ~/.ssh/config; the text on the left, tabs on the right — the host overview
 * (open a host to edit it in a form, add new ones), worth a look (one-click fixes, previewed first), simplify (the
 * verified shorter version, applied in one click) and command line (`telepy config tidy` edits the file on your own
 * computer). Both columns have their own height and the toolbar sticks, so a long config never stretches the page;
 * on phones the config is one of the tabs. Everything runs in the browser; the text is never sent or stored, and
 * every whole-text change is undoable.
 */
import React, { Suspense, useState } from "react";
import { ClipboardPaste, Copy, Check, Download, FileCode2, Info, Redo2, Shield, Sparkles, Undo2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { TidyResultView } from "@/components/sshconfig/TidyResultView";
import { TidyInfoDialog } from "@/components/sshconfig/TidyInfoDialog";
import { HostsPanel } from "@/components/sshconfig/HostsPanel";
import { IssuesPanel } from "@/components/sshconfig/IssuesPanel";
import { HostEditorDialog } from "@/components/sshconfig/HostEditorDialog";
import { CliPanel } from "@/components/sshconfig/CliPanel";
import { EDITOR_TABS, useConfigEditor, type EditorTab } from "@/hooks/useConfigEditor";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { TIDY_EXAMPLE, tidyConfig } from "@/lib/sshConfigTidy";

function EditorPage() {
    const { t } = useI18n();
    const ed = useConfigEditor();
    const [howOpen, setHowOpen] = useState(false);
    // undefined = 關著；null = 新增；字串 = 那台主機。/ undefined = closed; null = add; a string = that host.
    const [editing, setEditing] = useState<string | null | undefined>(undefined);
    const [copied, setCopied] = useState(false);
    const empty = ed.text.trim() === "";
    const issues = (ed.result?.notes ?? []).filter((n) => n.kind !== "wall").length;
    const hosts = ed.overview?.rows.length ?? 0;
    const lines = empty ? 0 : ed.text.replace(/\r?\n$/, "").split(/\r?\n/).length;

    const paste = () =>
        navigator.clipboard
            .readText()
            .then((s) => s && ed.replace(s))
            .catch(() => { /* 不給讀剪貼簿：直接貼到框裡 / no clipboard access: paste into the box */ });
    const copy = () =>
        navigator.clipboard.writeText(ed.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    const download = () => {
        const url = URL.createObjectURL(new Blob([ed.text], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "config";
        a.click();
        URL.revokeObjectURL(url);
    };

    // 還沒貼東西時，資訊視窗用例子示範。/ With nothing pasted, the info dialog shows the example.
    const before = empty ? TIDY_EXAMPLE : ed.input;
    const after = empty ? tidyConfig(TIDY_EXAMPLE).text : (ed.result?.text ?? ed.input);
    const tabLabel = (tab: EditorTab) =>
        tab === "issues" && issues > 0 ? `${t("tidy.tab.issues")} · ${issues}` : tab === "hosts" && hosts > 0 ? `${t("tidy.tab.hosts")} · ${hosts}` : t(`tidy.tab.${tab}`);
    const panelTab: Exclude<EditorTab, "config"> = ed.tab === "config" ? "hosts" : ed.tab;
    // 手機：設定是一個分頁（還沒貼東西時一定先看到它）。/ Phones: the config is a tab (always shown while empty).
    const phoneEditor = ed.tab === "config" || empty;

    return (
        <div className="animate-fade-in-up space-y-4">
            <PageHeader
                icon={<FileCode2 />}
                title={t("tidy.title")}
                description={t("tidy.subtitle")}
                actions={
                    <Button variant="outline" onClick={() => setHowOpen(true)}>
                        <Info size={16} /> {t("tidy.how")}
                    </Button>
                }
            />
            <TidyInfoDialog
                isOpen={howOpen}
                onClose={() => setHowOpen(false)}
                before={before}
                after={after}
                names={empty ? ["web-1", "db", "lab-pi", "bastion"] : ed.names}
                initial={empty ? "web-1" : ed.firstChanged}
            />
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Shield size={15} className="mt-0.5 shrink-0" aria-hidden />
                {t("tidy.private")}
            </p>

            {/* 工具列黏在頁首下面。/ The toolbar sticks under the page header. */}
            <div className="sticky top-16 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-background px-1 py-2">
                <Button variant="outline" size="sm" onClick={paste}>
                    <ClipboardPaste size={15} /> {t("tidy.paste")}
                </Button>
                <Button variant="outline" size="sm" onClick={ed.loadExample}>
                    <Sparkles size={15} /> {t("tidy.example")}
                </Button>
                <Button variant="ghost" size="icon" onClick={ed.undo} disabled={!ed.canUndo} aria-label={t("tidy.undo")} title={t("tidy.undo")}>
                    <Undo2 size={16} />
                </Button>
                <Button variant="ghost" size="icon" onClick={ed.redo} disabled={!ed.canRedo} aria-label={t("tidy.redo")} title={t("tidy.redo")}>
                    <Redo2 size={16} />
                </Button>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{empty ? "" : t("tidy.statsNow", { hosts, lines })}</span>
                <Button variant="outline" size="sm" onClick={download} disabled={empty}>
                    <Download size={15} /> <span className="max-sm:sr-only">{t("tidy.download")}</span>
                </Button>
                <Button size="sm" onClick={copy} disabled={empty}>
                    {copied ? <Check size={15} /> : <Copy size={15} />} <span className="max-sm:sr-only">{copied ? t("common.copied") : t("tidy.copyAll")}</span>
                </Button>
                {!empty && (
                    <Button variant="ghost" size="icon" onClick={() => ed.replace("")} aria-label={t("tidy.clear")} title={t("tidy.clear")}>
                        <X size={16} />
                    </Button>
                )}
            </div>

            {/* 手機：一行選單（五個分頁的日文標籤放不下一列）；平板：一列分頁。/ Phones: a one-line select; tablets: one row of tabs. */}
            <div className="sm:hidden">
                <NativeSelect value={ed.tab} onChange={(e) => ed.setTab(e.target.value as EditorTab)} aria-label={t("tidy.title")}>
                    {EDITOR_TABS.map((x) => (
                        <option key={x} value={x}>{tabLabel(x)}</option>
                    ))}
                </NativeSelect>
            </div>
            <div className="max-sm:hidden lg:hidden">
                <Segmented kind="tabs" aria-label={t("tidy.title")} value={ed.tab} onChange={ed.setTab} options={EDITOR_TABS.map((x) => ({ value: x, label: tabLabel(x) }))} />
            </div>

            <div className="grid gap-4 [--pane:max(28rem,calc(100dvh-17rem))] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                <section aria-label={t("tidy.input")} className={cn(!phoneEditor && "max-lg:hidden")}>
                    <Textarea
                        value={ed.text}
                        onChange={(e) => ed.type(e.target.value)}
                        placeholder={t("tidy.placeholder")}
                        aria-label={t("tidy.input")}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="h-[55dvh] min-h-[18rem] resize-none font-mono text-[0.8125rem] leading-relaxed lg:h-(--pane)"
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">{t("tidy.inputHint")}</p>
                </section>

                <section aria-label={tabLabel(panelTab)} className={cn("min-w-0", phoneEditor && "max-lg:hidden")}>
                    <div className="mb-3 max-lg:hidden">
                        <Segmented
                            kind="tabs"
                            aria-label={t("tidy.title")}
                            value={panelTab}
                            onChange={ed.setTab}
                            options={(["hosts", "issues", "simplify", "cli"] as const).map((x) => ({ value: x, label: tabLabel(x) }))}
                        />
                    </div>
                    {/* 寬的時候這欄有自己的高度、自己捲。/ Wide: this column has its own height and scrolls itself. */}
                    <div className="lg:h-[calc(var(--pane)-3rem)] lg:overflow-y-auto lg:pr-1">
                        {panelTab === "cli" ? (
                            <CliPanel />
                        ) : empty ? (
                            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
                                <p className="text-sm text-muted-foreground">{t("tidy.empty")}</p>
                                <Button variant="outline" size="sm" className="mt-3" onClick={ed.loadExample}>
                                    <Sparkles size={15} /> {t("tidy.example")}
                                </Button>
                            </div>
                        ) : panelTab === "hosts" && ed.overview ? (
                            <HostsPanel rows={ed.overview.rows} other={ed.overview.other} hasMatch={ed.overview.hasMatch} onOpen={(n) => setEditing(n)} onAdd={() => setEditing(null)} />
                        ) : panelTab === "issues" && ed.result ? (
                            <IssuesPanel text={ed.input} notes={ed.result.notes} onApply={ed.replace} />
                        ) : panelTab === "simplify" && ed.result ? (
                            <TidyResultView
                                input={ed.input}
                                result={ed.result}
                                stale={ed.stale}
                                wildcards={ed.wildcards}
                                onWildcards={ed.setWildcards}
                                onUse={ed.replace}
                                onExplain={() => setHowOpen(true)}
                            />
                        ) : null}
                    </div>
                </section>
            </div>

            {editing !== undefined && (
                <HostEditorDialog
                    key={editing ?? "+"}
                    text={ed.text}
                    host={editing}
                    onClose={() => setEditing(undefined)}
                    onApply={(next) => {
                        ed.replace(next);
                        setEditing(undefined);
                    }}
                />
            )}
        </div>
    );
}

export default function SshConfigEditorPage() {
    return (
        <Suspense>
            <EditorPage />
        </Suspense>
    );
}
