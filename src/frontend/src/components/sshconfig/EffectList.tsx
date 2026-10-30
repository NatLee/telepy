"use client";

/**
 * 一個改動會讓哪個名稱的哪個設定怎麼變（`lib/sshConfigEdit.effectChanges`）：依名稱分組，`舊 → 新`，沒有了 / 新加的另外標。
 * What a change does to which setting of which name (`lib/sshConfigEdit.effectChanges`): grouped by name, `old → new`,
 * with gone / new marked.
 */
import React from "react";
import { ArrowRight, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { OTHER, type EffectChange } from "@/lib/sshConfigEdit";

export function EffectList({ changes, renamed }: { changes: EffectChange[]; renamed?: { from: string; to: string } }) {
    const { t } = useI18n();
    if (changes.length === 0) {
        return (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check size={15} className="text-success" aria-hidden />
                {t("tidy.edit.noEffect")}
            </p>
        );
    }
    const groups = new Map<string, EffectChange[]>();
    for (const c of changes) groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
    const label = (name: string) => (name === OTHER ? t("tidy.hosts.other") : renamed && name === renamed.from ? `${renamed.from} → ${renamed.to}` : name);
    const value = (v: string | null) => (v === null ? <span className="text-muted-foreground">{t("tidy.edit.unset")}</span> : <code className="font-mono text-foreground [overflow-wrap:anywhere]">{v}</code>);
    return (
        <ul className="divide-y divide-border/70 rounded-lg bg-surface ring-1 ring-inset ring-border/70">
            {[...groups].map(([name, list]) => (
                <li key={name} className="px-3 py-2">
                    <p className="font-mono text-sm text-foreground">{label(name)}</p>
                    <ul className="mt-1 space-y-0.5">
                        {list.map((c) => (
                            <li key={c.slot} className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
                                <span className="font-mono text-info">{c.key}</span>
                                {value(c.before)}
                                <ArrowRight size={12} className="shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
                                {value(c.after)}
                            </li>
                        ))}
                    </ul>
                </li>
            ))}
        </ul>
    );
}
