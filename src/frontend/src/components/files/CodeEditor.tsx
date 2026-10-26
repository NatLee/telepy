"use client";

/**
 * 檔案編輯器：CodeMirror 6（MIT），只在打開編輯 / 預覽時才動態載入（核心 + 用到的那一種語言），不進主 bundle。
 * 顏色走設計 token（CSS 變數），深淺色自動跟著；換行、唯讀、語言用 Compartment 即時切換，不重建編輯器。
 * File editor: CodeMirror 6 (MIT), loaded on demand (the core plus the one language a file needs), never in the main
 * bundle. Colours come from the design tokens, so light / dark follow; wrap, read-only and language switch live.
 */
import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type { Compartment, Extension } from "@codemirror/state";
import type { EditorLanguage } from "@/lib/fileManager";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 一種語言的 CodeMirror 擴充（動態載入）。/ Load one language's extension on demand. */
async function loadLanguage(lang: EditorLanguage | null): Promise<Extension> {
    if (!lang) return [];
    const legacy = async (load: () => Promise<Parameters<typeof import("@codemirror/language").StreamLanguage.define>[0]>) => {
        const [{ StreamLanguage }, parser] = await Promise.all([import("@codemirror/language"), load()]);
        return StreamLanguage.define(parser);
    };
    switch (lang) {
        case "javascript":
        case "jsx":
        case "typescript":
        case "tsx":
            return (await import("@codemirror/lang-javascript")).javascript({ jsx: lang === "jsx" || lang === "tsx", typescript: lang === "typescript" || lang === "tsx" });
        case "json":
            return (await import("@codemirror/lang-json")).json();
        case "python":
            return (await import("@codemirror/lang-python")).python();
        case "markdown":
            return (await import("@codemirror/lang-markdown")).markdown();
        case "html":
            return (await import("@codemirror/lang-html")).html();
        case "css":
            return (await import("@codemirror/lang-css")).css();
        case "yaml":
            return (await import("@codemirror/lang-yaml")).yaml();
        case "xml":
            return (await import("@codemirror/lang-xml")).xml();
        case "rust":
            return (await import("@codemirror/lang-rust")).rust();
        case "go":
            return (await import("@codemirror/lang-go")).go();
        case "sql":
            return (await import("@codemirror/lang-sql")).sql();
        case "shell":
            return legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell);
        case "toml":
            return legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml);
        case "ini":
            return legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties);
        case "dockerfile":
            return legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
        case "nginx":
            return legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx);
    }
}

interface Loaded {
    view: EditorView;
    wrap: Compartment;
    readOnly: Compartment;
    language: Compartment;
    lineWrapping: Extension;
    readOnlyExt: (on: boolean) => Extension;
}

export interface CodeEditorProps {
    /** 打開時的內容；之後的變更走 onChange（編輯器自己持有內容）。/ Initial content; changes come back through onChange. */
    initial: string;
    language: EditorLanguage | null;
    wrap: boolean;
    readOnly: boolean;
    onChange?: (value: string) => void;
    /** Ctrl/⌘+S。/ Ctrl/Cmd+S. */
    onSave?: () => void;
    /** 換內容（例如重新載入）時改這個 key。/ Bump to replace the content (e.g. after a reload). */
    revision?: number;
    className?: string;
}

export function CodeEditor({ initial, language, wrap, readOnly, onChange, onSave, revision = 0, className }: CodeEditorProps) {
    const { t } = useI18n();
    const host = useRef<HTMLDivElement>(null);
    const loaded = useRef<Loaded | null>(null);
    const [ready, setReady] = useState(false);
    const cb = useRef({ onChange, onSave });
    useEffect(() => {
        cb.current = { onChange, onSave };
    }, [onChange, onSave]);
    const opts = useRef({ wrap, readOnly, language, initial });
    useEffect(() => {
        opts.current = { wrap, readOnly, language, initial };
    }, [wrap, readOnly, language, initial]);

    // 建編輯器（第一次載入 CodeMirror）。revision 變了就整個換內容。/ Create the editor; a new revision replaces it.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [view, state, commands, lang, search, hl] = await Promise.all([
                import("@codemirror/view"),
                import("@codemirror/state"),
                import("@codemirror/commands"),
                import("@codemirror/language"),
                import("@codemirror/search"),
                import("@lezer/highlight"),
            ]);
            if (cancelled || !host.current) return;
            const o = opts.current;
            const { tags } = hl;
            const style = lang.HighlightStyle.define([
                { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "var(--primary)" },
                { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--success)" },
                { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--info)" },
                { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
                { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--warning)" },
                { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName)], color: "var(--foreground)" },
                { tag: [tags.heading], color: "var(--primary)" },
                { tag: [tags.link, tags.url], color: "var(--info)", textDecoration: "underline" },
                { tag: tags.invalid, color: "var(--destructive)" },
                { tag: [tags.meta, tags.processingInstruction], color: "var(--muted-foreground)" },
            ]);
            const theme = view.EditorView.theme({
                "&": { height: "100%", fontSize: "0.8125rem", backgroundColor: "var(--surface)", color: "var(--foreground)" },
                ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
                ".cm-content": { caretColor: "var(--foreground)" },
                ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
                ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" },
                ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 70%, transparent)" },
                ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
                "&.cm-focused": { outline: "none" },
                "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent) !important" },
                ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
                ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 25%, transparent)" },
                ".cm-textfield, .cm-button": { fontSize: "0.8125rem" },
            });
            const wrapC = new state.Compartment();
            const readOnlyC = new state.Compartment();
            const languageC = new state.Compartment();
            const readOnlyExt = (on: boolean) => [state.EditorState.readOnly.of(on), view.EditorView.editable.of(!on)];
            const languageExt = await loadLanguage(o.language);
            if (cancelled || !host.current) return;
            const editor = new view.EditorView({
                parent: host.current,
                state: state.EditorState.create({
                    doc: o.initial,
                    extensions: [
                        view.lineNumbers(),
                        view.highlightActiveLine(),
                        view.highlightActiveLineGutter(),
                        view.drawSelection(),
                        view.highlightSpecialChars(),
                        commands.history(),
                        lang.indentOnInput(),
                        lang.bracketMatching(),
                        lang.syntaxHighlighting(style),
                        search.highlightSelectionMatches(),
                        view.keymap.of([
                            { key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave?.(); return true; } },
                            ...commands.defaultKeymap,
                            ...commands.historyKeymap,
                            ...search.searchKeymap,
                            commands.indentWithTab,
                        ]),
                        theme,
                        wrapC.of(o.wrap ? view.EditorView.lineWrapping : []),
                        readOnlyC.of(readOnlyExt(o.readOnly)),
                        languageC.of(languageExt),
                        view.EditorView.updateListener.of((u) => {
                            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
                        }),
                    ],
                }),
            });
            loaded.current = { view: editor, wrap: wrapC, readOnly: readOnlyC, language: languageC, lineWrapping: view.EditorView.lineWrapping, readOnlyExt };
            setReady(true);
            if (!o.readOnly) editor.focus();
        })();
        return () => {
            cancelled = true;
            loaded.current?.view.destroy();
            loaded.current = null;
            setReady(false);
        };
    }, [revision]);

    useEffect(() => {
        const l = loaded.current;
        l?.view.dispatch({ effects: l.wrap.reconfigure(wrap ? l.lineWrapping : []) });
    }, [wrap, ready]);

    useEffect(() => {
        const l = loaded.current;
        if (!l) return;
        l.view.dispatch({ effects: l.readOnly.reconfigure(l.readOnlyExt(readOnly)) });
        if (!readOnly) l.view.focus();
    }, [readOnly, ready]);

    useEffect(() => {
        let cancelled = false;
        void loadLanguage(language).then((ext) => {
            const l = loaded.current;
            if (!cancelled && l) l.view.dispatch({ effects: l.language.reconfigure(ext) });
        });
        return () => {
            cancelled = true;
        };
    }, [language, ready]);

    return (
        <div className={cn("relative", className)}>
            <div ref={host} className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-surface [&_.cm-editor]:h-full" />
            {!ready && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" aria-hidden /> {t("files.editor.loading")}
                </div>
            )}
        </div>
    );
}
