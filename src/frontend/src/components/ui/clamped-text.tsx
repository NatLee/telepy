"use client";

/**
 * 長文字（AI 下的指令、錯誤輸出）的收合區塊：預設只顯示幾行，超出時才出現「展開全部」；保留換行、長字串在任何位置換行，
 * 不會撐寬版面，也沒有內層捲軸（展開就是整段）。可選複製鈕。
 * A collapsible block for long text (commands an agent ran, error output): a few lines by default, "Show all" only
 * when it overflows; newlines are kept and long tokens wrap anywhere, so it never widens the layout, and there is no
 * inner scroll box (expanded means all of it). Optional copy button.
 */
import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Highlighted } from "@/components/ui/timeline";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TONES = {
    code: "border-border bg-surface text-foreground",
    error: "border-destructive/25 bg-destructive/5 text-destructive",
} as const;

export function ClampedText({
    text,
    query = "",
    lines = 3,
    tone = "code",
    copy = false,
    className,
}: {
    text: string;
    /** 搜尋字，命中處會標示。/ Search text whose hits are marked. */
    query?: string;
    /** 收合時顯示幾行。/ Lines shown while collapsed. */
    lines?: number;
    tone?: keyof typeof TONES;
    copy?: boolean;
    className?: string;
}) {
    const { t } = useI18n();
    const ref = useRef<HTMLPreElement>(null);
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);

    // 收合時量是否被截掉（寬度一變就重量）；展開時維持原判斷，「收合」鈕才不會消失。
    // While collapsed, measure whether it is cut off (again whenever the width changes); keep it while expanded so
    // the "Show less" button stays.
    useEffect(() => {
        const el = ref.current;
        if (!el || open) return;
        const ro = new ResizeObserver(() => setOverflows(el.scrollHeight > el.clientHeight + 1));
        ro.observe(el);
        return () => ro.disconnect();
    }, [open, text]);

    const lineCount = text.split("\n").length;

    return (
        <div className={className}>
            {/* padding 放外層：line-clamp 只裁內容框，padding 留在 pre 上會露出半行下一行。
                Padding sits on the wrapper: line-clamp only trims the content box, so padding on the pre would show
                half of the next line. */}
            <div className={cn("relative rounded-md border px-3 py-2", copy && "pr-10", TONES[tone])}>
                <pre
                    ref={ref}
                    className="m-0 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
                    style={open ? undefined : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }}
                >
                    <Highlighted text={text} query={query} />
                </pre>
                {copy && <CopyButton value={text} className="absolute right-1 top-1 size-7 rounded-md" />}
            </div>
            {(overflows || open) && (
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {open ? t("ui.showLess") : lineCount > lines ? t("ui.showAllLines", { lines: lineCount }) : t("ui.showAll")}
                </button>
            )}
        </div>
    );
}
