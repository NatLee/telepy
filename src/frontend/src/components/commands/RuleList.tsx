"use client";

/**
 * 規則清單：每列 = 做什麼（擋下 / 要核准 / 允許）、比對式、管誰、管哪裡、套用的隧道、誰核准、說明；別人的規則標出是誰寫的。
 * 能改的人（自己的規則 / 管理員的全站規則）有開關、編輯、刪除。
 * The rule list: what happens, the pattern, who and where, the tunnels it covers, who approves, the note; other
 * people's rules say who wrote them. Editors (your own rules / admins on site-wide ones) get a switch, edit and delete.
 */
import React from "react";
import { Ban, CircleCheck, Hourglass, Pencil, Server, Trash2, UserCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { ACTION_KEY, ACTION_TONE, VIA_KEY, WHO_KEY, ruleCoverage, ruleSource } from "@/lib/commandRules";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { CommandRule, MatchedRule, RuleAction } from "@/types/commandRules";

export function ActionIcon({ action, size = 15, className }: { action: RuleAction; size?: number; className?: string }) {
    const Icon = action === "block" ? Ban : action === "approve" ? Hourglass : CircleCheck;
    return <Icon size={size} className={className} aria-hidden />;
}

export function ActionChip({ action }: { action: RuleAction }) {
    const { t } = useI18n();
    return (
        <Chip tone={ACTION_TONE[action]}>
            <ActionIcon action={action} />
            {t(ACTION_KEY[action])}
        </Chip>
    );
}

/** 比對到的規則是誰的（全站 / 你自己的 / 某人的）。/ Whose rule matched (site-wide / yours / someone's). */
export function RuleSource({ rule }: { rule: Pick<MatchedRule, "scope" | "owner"> }) {
    const { t } = useI18n();
    const { user } = useAuth();
    const src = ruleSource(rule, user?.id);
    return <>{t(src.key, { name: src.name ?? "" })}</>;
}

const COVER_KEY: Record<"site" | "managed" | "used" | "theirs", TranslationKey> = {
    site: "commands.cover.site",
    managed: "commands.cover.managed",
    used: "commands.cover.used",
    theirs: "commands.cover.theirs",
};

/** 規則套用到哪些隧道：所有（哪一種）或一排隧道籤；不算數的劃掉，看不到的只算數量。/ Which tunnels a rule covers. */
function Coverage({ rule }: { rule: CommandRule }) {
    const { t } = useI18n();
    const c = ruleCoverage(rule);
    if (c.kind === "every") {
        return (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Server size={13} className="shrink-0" aria-hidden />
                {t(COVER_KEY[c.whose])}
            </span>
        );
    }
    return (
        <span className="flex flex-wrap items-center gap-1">
            <Server size={13} className="shrink-0 text-muted-foreground" aria-hidden />
            {c.tunnels.map((x) => (
                <Chip key={x.id} className={cn("max-w-full truncate", !x.applies && "line-through opacity-70")} title={x.applies ? undefined : t("commands.cover.notApplied")}>
                    {x.name}
                </Chip>
            ))}
            {c.hidden > 0 && <span className="text-xs text-muted-foreground">{t("commands.cover.hidden", { count: c.hidden })}</span>}
        </span>
    );
}

export function RuleList({
    rules,
    canEdit,
    onEdit,
    onToggle,
    onDelete,
    showOwner = false,
}: {
    rules: CommandRule[];
    /** 誰的規則能改：true = 全部、function = 每條自己判斷。/ Which rules are editable. */
    canEdit: boolean | ((r: CommandRule) => boolean);
    onEdit?: (r: CommandRule) => void;
    onToggle?: (r: CommandRule) => void;
    onDelete?: (r: CommandRule) => void;
    /** 標出別人的規則是誰寫的。/ Name the author of other people's rules. */
    showOwner?: boolean;
}) {
    const { t } = useI18n();
    return (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {rules.map((r) => {
                const editable = typeof canEdit === "function" ? canEdit(r) : canEdit;
                return (
                    <li key={r.id} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3", !r.enabled && "opacity-60")}>
                        <div className="min-w-0 flex-1 space-y-1">
                            <p className="flex flex-wrap items-center gap-1.5">
                                <ActionChip action={r.action} />
                                <code className="break-all font-mono text-sm text-foreground">{r.pattern}</code>
                                {r.kind === "regex" && <Chip>{t("commands.kind.regexShort")}</Chip>}
                                {!r.enabled && <Chip>{t("commands.off")}</Chip>}
                                {showOwner && r.owner && !r.mine && (
                                    <Chip>
                                        <UserRound /> {t("commands.byOwner", { name: r.owner.username ?? `#${r.owner.id}` })}
                                    </Chip>
                                )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t(WHO_KEY[r.who])} · {t(VIA_KEY[r.via])}
                            </p>
                            <Coverage rule={r} />
                            {/* 指定的核准人（只有「要核准」規則有）。/ Named approvers (approve rules only). */}
                            {r.action === "approve" && r.approvers && r.approvers.length > 0 && (
                                <p className="flex items-center gap-1 text-xs text-foreground/80">
                                    <UserCheck size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                                    {t("commands.approversLine", { names: r.approvers.map((u) => u.username).join(", ") })}
                                </p>
                            )}
                            {r.note && <p className="text-xs text-foreground/80">“{r.note}”</p>}
                        </div>
                        {editable && (
                            <div className="flex items-center gap-1">
                                <span className="mr-1 inline-flex" title={t("commands.toggleHint")}>
                                    <Switch size="sm" checked={r.enabled} onCheckedChange={() => onToggle?.(r)} aria-label={t("commands.form.enabled")} />
                                </span>
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
                );
            })}
        </ul>
    );
}
