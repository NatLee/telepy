/**
 * 「連線中打的指令不寫進 shell 歷史檔」：個人預設（`/api/user/settings` 的 `shell_history`）＋每條隧道的個人覆寫
 * （`/api/reverse/server/{id}/shell-history`，null = 跟隨預設）。後端怎麼做到的見 `shell_history.rs`。
 * Keeping commands out of the device's shell history: the personal default plus a personal per-tunnel override
 * (null = follow the default). How the backend does it: `shell_history.rs`.
 */
import type { TranslationKey } from "@/locales/en";

export type HistoryMode = "keep" | "skip";
/** 隧道那一層的選擇：跟隨預設，或固定一種。/ The tunnel layer: follow the default, or pin one. */
export type OverrideChoice = "default" | HistoryMode;

export function isHistoryMode(v: unknown): v is HistoryMode {
    return v === "keep" || v === "skip";
}

/** 隧道的覆寫優先，沒有就是個人預設。/ The tunnel's override wins; otherwise the personal default. */
export function effectiveHistory(def: HistoryMode, override: HistoryMode | null): { mode: HistoryMode; source: "default" | "tunnel" } {
    return override ? { mode: override, source: "tunnel" } : { mode: def, source: "default" };
}

export function overrideChoice(mode: unknown): OverrideChoice {
    return isHistoryMode(mode) ? mode : "default";
}

/** PUT 的內容。/ The PUT body. */
export function overrideBody(choice: OverrideChoice): { mode: HistoryMode | null } {
    return { mode: choice === "default" ? null : choice };
}

/** 狀態的短字（chip、選項括號裡）。/ The short state word (chips, the default option). */
export const MODE_LABEL: Record<HistoryMode, TranslationKey> = {
    keep: "shellHistory.saved",
    skip: "shellHistory.keptOut",
};

/** 每種 shell 打的那一行（資訊視窗裡列出來，跟 `shell_history::plan` 一致）。/ The line per shell, as `plan` types it. */
export const SETUP_COMMANDS: ReadonlyArray<{ shells: string; command: string }> = [
    { shells: "bash, sh", command: "HISTFILE=/dev/null" },
    { shells: "zsh", command: "unset HISTFILE" },
    { shells: "fish", command: "set -g fish_history ''" },
];
