"use client";

/**
 * 一件事哪些工具做得到：`telepy` 與 `ssh` 兩個小記號，做得到的打勾、做不到的淡掉畫一槓。工具名是產品名，不翻譯；
 * 整句話（「telepy 和 ssh 都可以」）放在 aria-label / title。
 * Which tools can do a thing: two small marks, `telepy` and `ssh` — a check when it can, faint with a dash when it
 * can't. The tool names are product names (not translated); the sentence lives in the aria-label / title.
 */
import React from "react";
import { Check, Minus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Way } from "@/lib/forwardRecipes";

const WAYS: readonly Way[] = ["telepy", "ssh"];

export function WayMarks({ ways, className }: { ways: readonly Way[]; className?: string }) {
    const { t } = useI18n();
    const label = t(ways.includes("ssh") ? "sheet.ways.ariaBoth" : "sheet.ways.ariaTelepyOnly");
    return (
        <span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0 items-center gap-2 font-mono text-[0.6875rem] leading-none", className)}>
            {WAYS.map((w) => {
                const on = ways.includes(w);
                return (
                    <span key={w} className={cn("inline-flex items-center gap-0.5", on ? "text-foreground" : "text-muted-foreground/50")}>
                        {on ? <Check size={11} className="text-success" aria-hidden /> : <Minus size={11} aria-hidden />}
                        {w}
                    </span>
                );
            })}
        </span>
    );
}
