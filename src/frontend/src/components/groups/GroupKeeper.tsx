/**
 * 群組旁的一行安靜字：成員是誰在維護（你 / 做群組的人 / 管理員 / 公司帳號同步）。一般使用者只看到這個，
 * 不用學「組織群組 / 個人群組」兩個詞。
 * One quiet line next to a group: who keeps its members (you / the person who made it / admins / synced from company
 * accounts). Ordinary users only see this, never the words "organization group" / "personal group".
 */
import React from "react";
import { Building2, RefreshCw, User } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { groupKeeper, type GroupKeeperKind } from "@/lib/peopleGroups";
import type { TranslationKey } from "@/locales/en";

const KEY: Record<GroupKeeperKind, TranslationKey> = {
    you: "peopleGroups.keeper.you",
    owner: "peopleGroups.keeper.owner",
    admins: "peopleGroups.keeper.admins",
    synced: "peopleGroups.keeper.synced",
};

export function useKeeperLabel() {
    const { t } = useI18n();
    return (keeper: GroupKeeperKind, owner?: string | null) => t(KEY[keeper], { owner: owner ?? "?" });
}

export function GroupKeeper({
    group,
    className,
}: {
    group: { kind: "org" | "personal"; mine?: boolean; synced?: boolean; owner?: string | null };
    className?: string;
}) {
    const label = useKeeperLabel();
    const keeper = groupKeeper(group);
    const Icon = keeper === "synced" ? RefreshCw : keeper === "admins" ? Building2 : User;
    return (
        <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}>
            <Icon size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{label(keeper, group.owner)}</span>
        </span>
    );
}
