"use client";

/**
 * 規則清單：每列 = 做什麼（擋下 / 要核准）、比對式、管誰、管哪裡、說明；能改的人有開關、編輯、刪除。
 * The rule list: what happens, the pattern, who and where, the note; editors get a switch, edit and delete.
 */
import React from "react";
import { Ban, Hourglass, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { ACTION_KEY, VIA_KEY, WHO_KEY } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CommandRule } from "@/types/commandRules";

export function ActionChip({ action }: { action: CommandRule["action"] }) {
    const { t } = useI18n();
    return (
        <Chip tone={action === "block" ? "danger" : "warning"}>
            {action === "block" ? <Ban aria-hidden /> : <Hourglass aria-hidden />}
            {t(ACTION_KEY[action])}
        </Chip>
    );
}

export function RuleList({
    rules,
    canEdit,
    onEdit,
    onToggle,
    onDelete,
}: {
    rules: CommandRule[];
    canEdit: boolean;
    onEdit?: (r: CommandRule) => void;
    onToggle?: (r: CommandRule) => void;
    onDelete?: (r: CommandRule) => void;
}) {
    const { t } = useI18n();
    return (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {rules.map((r) => (
                <li key={r.id} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3", !r.enabled && "opacity-60")}>
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="flex flex-wrap items-center gap-1.5">
                            <ActionChip action={r.action} />
                            <code className="break-all font-mono text-sm text-foreground">{r.pattern}</code>
                            {r.kind === "regex" && <Chip>{t("commands.kind.regexShort")}</Chip>}
                            {!r.enabled && <Chip>{t("commands.off")}</Chip>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t(WHO_KEY[r.who])} · {t(VIA_KEY[r.via])}
                        </p>
                        {r.note && <p className="text-xs text-foreground/80">“{r.note}”</p>}
                    </div>
                    {canEdit && (
                        <div className="flex items-center gap-1">
                            <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("commands.toggleHint")}>
                                <input type="checkbox" className="size-4 accent-primary" checked={r.enabled} onChange={() => onToggle?.(r)} aria-label={t("commands.form.enabled")} />
                                {t("commands.on")}
                            </label>
                            <Button size="icon-sm" variant="ghost" onClick={() => onEdit?.(r)} aria-label={t("common.edit")} title={t("common.edit")}>
                                <Pencil />
                            </Button>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => onDelete?.(r)}
                                aria-label={t("common.delete")}
                                title={t("common.delete")}
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}
