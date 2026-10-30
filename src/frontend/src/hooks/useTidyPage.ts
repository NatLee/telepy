/**
 * SSH config 簡化頁的狀態：貼上的文字只在記憶體裡（不存 localStorage——可能有主機名稱、帳號），萬用字元的選擇記在
 * localStorage。打字時用 useDeferredValue，長設定不會卡住輸入。
 * The SSH config simplifier's state: the pasted text stays in memory only (never localStorage — it may hold host
 * names and accounts); the wildcard choice is remembered. useDeferredValue keeps typing smooth on long configs.
 */
import { useDeferredValue, useMemo, useState } from "react";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { firstChangedName, namesIn, tidyConfig, TIDY_EXAMPLE } from "@/lib/sshConfigTidy";

export function useTidyPage() {
    const [text, setText] = useState("");
    const [wild, setWild] = useStoredChoice("telepy.tidyWildcards", ["on", "off"] as const, "off");
    const deferred = useDeferredValue(text);
    const wildcards = wild === "on";
    const result = useMemo(() => (deferred.trim() ? tidyConfig(deferred, { wildcards }) : null), [deferred, wildcards]);
    const names = useMemo(() => (deferred.trim() ? namesIn(deferred) : []), [deferred]);
    return {
        text,
        setText,
        /** 結果對應的輸入（打字中可能比 text 慢一步）。/ The input the result belongs to (may trail text while typing). */
        input: deferred,
        stale: deferred !== text,
        result,
        names,
        firstChanged: result ? firstChangedName(result) : undefined,
        wildcards,
        setWildcards: (on: boolean) => setWild(on ? "on" : "off"),
        loadExample: () => setText(TIDY_EXAMPLE),
    };
}
