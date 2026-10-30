"use client";

/**
 * 隧道名稱欄位下面那幾行（建立精靈、一鍵加入、詳情的改名共用）：規則一直看得到（名稱會變成 ssh 的主機名稱），打錯字當下就說
 * 哪個字不行，給一鍵「改成 …」；「為什麼？」說明這些規則跟著 OpenSSH（空白、`%` 這些在 ssh 裡有意思、`@` `:` 是 Telepy 自己的、
 * ssh 連線時轉小寫所以只差大小寫算同一個）。規則本身在 `lib/tunnelName.ts`（有測試、與後端同一份）。
 * 另外 `SshNameChip`：舊的、不合規則的名稱在卡片 / 列表上的提醒。
 * The lines under a tunnel name field (the create wizard, the one-command join, renaming in the details): the rules
 * are always visible (the name becomes the ssh host name), a bad character is named while typing with a one-click
 * "Use …", and "Why?" explains that the rules follow OpenSSH. `SshNameChip` flags an older, non-conforming name.
 */
import React from "react";
import { HelpCircle, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NAME_PROBLEM_KEY, badChars, suggestTunnelName, tunnelNameProblem } from "@/lib/tunnelName";
import { quiet, type RowVariant } from "@/components/tunnels/quiet";

/** 名稱的錯誤訊息（`null` = 沒問題；空字串不在這裡算錯，交給「必填」）。/ The live error, or null (empty is the caller's "required"). */
export function useTunnelNameError(): (name: string) => string | null {
    const { t } = useI18n();
    return (name: string) => {
        const problem = tunnelNameProblem(name);
        if (!problem || problem === "name_empty") return null;
        if (problem === "name_chars") {
            const chars = badChars(name)
                .slice(0, 6)
                .map((c) => (c === " " ? t("tunnelName.space") : /\s/.test(c) ? t("tunnelName.whitespace") : c))
                .join(" ");
            return t("tunnelName.err.chars", { chars });
        }
        return t(NAME_PROBLEM_KEY[problem]);
    };
}

function WhyRules() {
    const { t, tn } = useI18n();
    const code = (s: string) => <code className="font-mono text-foreground">{s}</code>;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                    <HelpCircle size={12} aria-hidden />
                    {t("tunnelName.why")}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-2 p-3 text-xs leading-relaxed">
                <p className="text-sm text-foreground">{t("tunnelName.whyTitle")}</p>
                <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground marker:text-border">
                    <li>{tn("tunnelName.why1", { ssh: code("ssh <name>"), cli: code("telepy ssh <name>") })}</li>
                    <li>{tn("tunnelName.why2", { chars: code("% * ? ! #") })}</li>
                    <li>{tn("tunnelName.why3", { at: code("telepy ssh box@pi"), colon: code("telepy cp box:/tmp/") })}</li>
                    <li>{tn("tunnelName.why4", { upper: code("MyBox"), lower: code("mybox") })}</li>
                </ul>
                <p className="text-muted-foreground">{t("tunnelName.whySource")}</p>
            </PopoverContent>
        </Popover>
    );
}

/**
 * 欄位下面的說明：規則 + 為什麼，有錯就加一行錯誤與「改成 …」。`error` = 其他來源的錯誤（必填、已被使用、伺服器）。
 * `rulesKey` 換說明的第一句（一鍵加入可以留空：空 = 用主機名稱）。
 * Under the field: the rules + why, plus an error line and "Use …" when needed. `error` = another error (required,
 * taken, server). `rulesKey` swaps the first sentence (the join may stay empty: empty = the hostname).
 */
export function TunnelNameHelp({ value, error, onUse, id, original, rulesKey = "tunnelName.rules" }: {
    value: string;
    error?: string | null;
    onUse: (name: string) => void;
    id?: string;
    /** 改名時原本的名稱：沒改就不報（規則之前的舊名稱照樣能存其他欄位）。/ When renaming: an unchanged name is not flagged. */
    original?: string;
    rulesKey?: "tunnelName.rules" | "tunnelName.rulesJoin";
}) {
    const { t } = useI18n();
    const check = useTunnelNameError();
    const liveError = original !== undefined && value.trim() === original ? null : check(value.trim());
    const shown = error || liveError;
    const suggestion = liveError ? suggestTunnelName(value) : null;
    return (
        <div id={id} className="space-y-1">
            <p className="text-xs leading-relaxed text-muted-foreground">
                {t(rulesKey)} <WhyRules />
            </p>
            {shown && (
                <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
                    <span>{shown}</span>
                    {suggestion && suggestion !== value && (
                        <button type="button" onClick={() => onUse(suggestion)} className="rounded-sm text-foreground underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                            {t("tunnelName.use", { name: suggestion })}
                        </button>
                    )}
                </p>
            )}
        </div>
    );
}

/** 舊名稱（規則之前建的）在卡片 / 列表上的提醒，點了開詳情改名。/ An older name's flag; opens the details to rename. */
export function SshNameChip({ name, onOpen, variant = "chip", className }: { name: string; onOpen: () => void; variant?: RowVariant; className?: string }) {
    const { t } = useI18n();
    if (tunnelNameProblem(name) === null) return null;
    return (
        <button
            type="button"
            onClick={onOpen}
            className={cn(variant === "text" ? quiet("warning") : "inline-flex items-center gap-1 rounded-sm bg-warning/12 px-1.5 py-px text-xs text-warning hover:bg-warning/20", className)}
            title={t("tunnelName.old.chipHint")}
        >
            <TriangleAlert size={13} aria-hidden /> {t("tunnelName.old.chip")}
        </button>
    );
}
