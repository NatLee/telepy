/**
 * SSH config 編輯器的狀態：文字（只在記憶體，不存 localStorage——可能有主機名稱、帳號）、復原 / 重做（每次「整份換掉」的
 * 動作——修正、表單、套用簡化、貼上、範例、清除——之前記一筆；打字有輸入框自己的復原）、萬用字元的選擇（localStorage）、
 * 分頁（`?tab=`）。簡化、總覽、提醒都從 useDeferredValue 的文字算，長設定打字不卡。
 * The SSH config editor's state: the text (memory only, never localStorage — it may hold host names and accounts),
 * undo / redo (a snapshot before every whole-text change — fixes, the form, using the simpler version, paste,
 * example, clear; typing has the textarea's own undo), the wildcard choice (localStorage) and the tab (`?tab=`).
 * Simplifying, the overview and the notes run on useDeferredValue text, so typing stays smooth on long configs.
 */
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { hostTable } from "@/lib/sshConfigEdit";
import { firstChangedName, namesIn, tidyConfig, TIDY_EXAMPLE } from "@/lib/sshConfigTidy";

export const EDITOR_TABS = ["config", "hosts", "issues", "simplify", "cli"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];
const HISTORY = 100;

export function useConfigEditor() {
    const [text, setTextRaw] = useState("");
    const [past, setPast] = useState<string[]>([]);
    const [future, setFuture] = useState<string[]>([]);
    const [wild, setWild] = useStoredChoice("telepy.tidyWildcards", ["on", "off"] as const, "off");
    const deferred = useDeferredValue(text);
    const wildcards = wild === "on";

    /** 整份換掉（記一筆可以復原）。/ Replace the whole text (undoable). */
    const replace = useCallback(
        (next: string) => {
            if (next === text) return;
            setPast((p) => [...p.slice(-HISTORY + 1), text]);
            setFuture([]);
            setTextRaw(next);
        },
        [text],
    );
    const undo = useCallback(() => {
        if (past.length === 0) return;
        setFuture((f) => [text, ...f]);
        setTextRaw(past[past.length - 1]);
        setPast((p) => p.slice(0, -1));
    }, [past, text]);
    const redo = useCallback(() => {
        if (future.length === 0) return;
        setPast((p) => [...p, text]);
        setTextRaw(future[0]);
        setFuture((f) => f.slice(1));
    }, [future, text]);

    const has = deferred.trim() !== "";
    const result = useMemo(() => (has ? tidyConfig(deferred, { wildcards }) : null), [deferred, has, wildcards]);
    const overview = useMemo(() => (has ? hostTable(deferred) : null), [deferred, has]);
    const names = useMemo(() => (has ? namesIn(deferred) : []), [deferred, has]);

    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const raw = params.get("tab");
    const tab: EditorTab = (EDITOR_TABS as readonly string[]).includes(raw ?? "") ? (raw as EditorTab) : "hosts";
    const setTab = useCallback(
        (next: EditorTab) => {
            const qs = new URLSearchParams(params.toString());
            if (next === "hosts") qs.delete("tab");
            else qs.set("tab", next);
            const s = qs.toString();
            router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
        },
        [params, pathname, router],
    );

    return {
        text,
        /** 打字（不記復原）。/ Typing (no undo snapshot). */
        type: setTextRaw,
        replace,
        undo,
        redo,
        canUndo: past.length > 0,
        canRedo: future.length > 0,
        /** 結果對應的輸入（打字中可能比 text 慢一步）。/ The input the results belong to (may trail text while typing). */
        input: deferred,
        stale: deferred !== text,
        result,
        overview,
        names,
        firstChanged: result ? firstChangedName(result) : undefined,
        wildcards,
        setWildcards: (on: boolean) => setWild(on ? "on" : "off"),
        loadExample: () => replace(TIDY_EXAMPLE),
        tab,
        setTab,
    };
}
