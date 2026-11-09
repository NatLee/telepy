"use client";

/**
 * 一行裡的項目（通道連結）太多時只列前 `max` 個，「+N」展開、「收起」收回。
 * Items in one line (tunnel links): past `max` the rest fold into "+N more", which expands; "Show less" folds back.
 */
import React, { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { foldList } from "@/lib/peopleGroups";

export function FoldedItems({ label, items, max = 5 }: { label: string; items: { key: React.Key; node: React.ReactNode }[]; max?: number }) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const { shown, more } = foldList(items, max);
    const list = open ? items : shown;
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="text-muted-foreground">{label}</span>
            {list.map((i) => (
                <React.Fragment key={i.key}>{i.node}</React.Fragment>
            ))}
            {more > 0 && (
                <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    {open ? t("peopleGroups.showLess") : t("peopleGroups.moreCount", { count: more })}
                </button>
            )}
        </span>
    );
}
