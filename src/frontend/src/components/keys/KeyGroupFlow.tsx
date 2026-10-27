/**
 * 「這個金鑰群組的金鑰去哪」的即時圖：群組裡的金鑰 → 授予給（通道群組 / 裝置）→ 每台到得了的裝置與帳號
 * （允許的 ∩ 選的帳號，加上裝好了幾個、在等幾個、失敗幾個）。直線與直角，桌面橫排、手機直排。
 * `extra` = 授予視窗裡還沒存的那筆（預覽，標成主色）。
 * Live picture of where a key group's keys go: the keys → what it is given to (tunnel groups / devices) → each
 * device reached with its accounts (allowed ∩ chosen) and how many are installed / waiting / failed. Straight
 * lines only; a row from `sm`, a column on phones. `extra` = an unsaved grant from the grant dialog (preview).
 */
import React from "react";
import { FolderTree, HardDrive, KeyRound, Layers, Send } from "lucide-react";
import { Chip } from "@/components/ui/section";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { FlowLink, FlowNode } from "@/components/keys/KeyPlacementFlow";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { deviceProgress, keyGroupReach, placedAccounts } from "@/lib/groups";
import type { KeyGroup, KeyGroupGrant, TunnelGroup } from "@/types/groups";
import type { KeyDevice, UserKey } from "@/types/keys";

/** 授予的帳號選擇，一個小籤。/ A grant's account choice as a chip. */
export function GrantAccounts({ accounts }: { accounts: string[] | null }) {
    const { t } = useI18n();
    return accounts === null ? (
        <Chip>{t("groups.grant.allAccounts")}</Chip>
    ) : (
        <Chip tone="warning" className="max-w-full truncate" title={accounts.join(", ")}>
            {t("groups.grant.only", { accounts: accounts.join(", ") })}
        </Chip>
    );
}

/** 授予對象的名字（通道群組 / 裝置）與圖示。/ A grant target's icon and name. */
export function GrantTarget({ grant, tunnelGroups }: { grant: KeyGroupGrant; tunnelGroups: TunnelGroup[] }) {
    const { t } = useI18n();
    const tg = grant.tunnel_group ? tunnelGroups.find((g) => g.id === grant.tunnel_group!.id) : undefined;
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {grant.tunnel_group ? <FolderTree size={13} className="shrink-0 text-muted-foreground" aria-hidden /> : <HardDrive size={13} className="shrink-0 text-muted-foreground" aria-hidden />}
            <span className="truncate text-sm text-foreground" title={grant.tunnel_group?.name ?? grant.tunnel?.name ?? ""}>
                {grant.tunnel_group?.name ?? grant.tunnel?.name ?? "?"}
            </span>
            {grant.tunnel_group && <span className="shrink-0 text-xs text-muted-foreground">{t("groups.grant.devices", { count: tg?.tunnel_ids.length ?? 0 })}</span>}
        </span>
    );
}

export function KeyGroupFlow({
    group,
    keys,
    tunnelGroups,
    devices,
    extra,
    className,
}: {
    group: KeyGroup;
    /** 我所有的金鑰（找群組裡的名稱用）。/ All my keys (for the names). */
    keys: UserKey[];
    tunnelGroups: TunnelGroup[];
    /** 金鑰頁矩陣的資料：我能用的裝置、帳號與安裝狀態。/ The keys-page matrix: devices, accounts and install state. */
    devices: KeyDevice[];
    extra?: KeyGroupGrant | null;
    className?: string;
}) {
    const { t } = useI18n();
    const members = keys.filter((k) => group.key_ids.includes(k.id));
    const grants = extra ? [...group.grants.filter((g) => !sameTarget(g, extra)), extra] : group.grants;
    const reach = keyGroupReach({ ...group, grants }, tunnelGroups).flatMap((r) => {
        const d = devices.find((x) => x.tunnel_id === r.tunnelId);
        return d ? [{ ...r, device: d }] : [];
    });
    const lit = members.length > 0 && grants.length > 0;
    return (
        <div className={className}>
            <div className="flex flex-col sm:flex-row sm:items-stretch" role="img" aria-label={t("groups.flow.aria", { group: group.name })}>
                <FlowNode icon={KeyRound} title={t("groups.flow.keys")} className="sm:w-[11rem]">
                    {members.length === 0 ? (
                        <Chip tone="warning">{t("groups.flow.noKeys")}</Chip>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {members.map((k) => (
                                <li key={k.id} className="flex min-w-0 items-center gap-1.5">
                                    <span className="truncate text-sm text-foreground" title={k.host_friendly_name}>{k.host_friendly_name}</span>
                                    <span className="shrink-0 font-mono text-[0.75rem] text-muted-foreground">{k.key_type ?? "?"}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </FlowNode>
                <FlowLink tone={lit ? "success" : "neutral"} />
                <FlowNode icon={Send} title={t("groups.flow.grants")} className="sm:w-[13rem]">
                    {grants.length === 0 ? (
                        <span className="text-[0.75rem] text-muted-foreground">{t("groups.flow.noGrants")}</span>
                    ) : (
                        <ul className="flex flex-col gap-1.5">
                            {grants.map((g) => (
                                <li key={g.id} className={cn("flex min-w-0 flex-col gap-1 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-inset", g === extra ? "ring-primary/50" : "ring-border")}>
                                    <GrantTarget grant={g} tunnelGroups={tunnelGroups} />
                                    <span>
                                        <GrantAccounts accounts={g.accounts} />
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </FlowNode>
                <FlowLink tone={lit && reach.length > 0 ? "success" : "neutral"} />
                <FlowNode icon={Layers} title={t("groups.flow.devices")} className="min-w-0 flex-1">
                    {reach.length === 0 ? (
                        <span className="text-[0.75rem] text-muted-foreground">{t("groups.flow.noDevices")}</span>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {reach.map(({ device: d, via, accounts }) => {
                                const placed = placedAccounts(d.accounts, accounts);
                                const p = deviceProgress(d, group.key_ids);
                                const viaGroup = via.find((g) => g.tunnel_group)?.tunnel_group?.name;
                                const preview = extra && via.includes(extra) && via.length === 1;
                                return (
                                    <li key={d.tunnel_id} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-inset", preview ? "ring-primary/50" : placed.length ? "ring-success/40" : "ring-border")}>
                                        <StatusDot health={d.online ? "online" : "offline"} />
                                        <span className="min-w-0 truncate text-sm text-foreground" title={d.host_friendly_name}>{d.host_friendly_name}</span>
                                        {viaGroup && <span className="text-[0.75rem] text-muted-foreground">{t("groups.flow.via", { name: viaGroup })}</span>}
                                        <span className="flex flex-wrap gap-1">
                                            {placed.length === 0 ? (
                                                <Chip tone="warning">{t("groups.flow.noAccount")}</Chip>
                                            ) : (
                                                placed.map((a) => (
                                                    <Chip key={a} tone="success" mono>{a}</Chip>
                                                ))
                                            )}
                                        </span>
                                        {placed.length > 0 && !preview && members.length > 0 && (
                                            <span className="ml-auto flex flex-wrap gap-x-2 text-[0.75rem]">
                                                {!d.online && p.installed + p.error === 0 ? (
                                                    <span className="text-muted-foreground">{t("groups.flow.offline")}</span>
                                                ) : (
                                                    <>
                                                        {p.installed > 0 && <span className="text-success">{t("groups.flow.installed", { count: p.installed })}</span>}
                                                        {p.pending > 0 && <span className="text-muted-foreground">{t("groups.flow.pending", { count: p.pending })}</span>}
                                                        {p.error > 0 && <span className="text-destructive">{t("groups.flow.failed", { count: p.error })}</span>}
                                                    </>
                                                )}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </FlowNode>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("groups.flow.note")}</p>
        </div>
    );
}

/** 兩筆授予是不是給同一個對象。/ Whether two grants point at the same target. */
export function sameTarget(a: KeyGroupGrant, b: KeyGroupGrant): boolean {
    return (!!a.tunnel && a.tunnel.id === b.tunnel?.id) || (!!a.tunnel_group && a.tunnel_group.id === b.tunnel_group?.id);
}
