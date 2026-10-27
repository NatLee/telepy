/**
 * 「把金鑰群組授予給…」：選一個通道群組或一台裝置、要不要只給某些帳號（名稱，從那些裝置上我能用的帳號挑），
 * 下面是即時預覽（`KeyGroupFlow`，還沒存的這筆標成主色）。已經授予過同一個對象時，儲存 = 改帳號。
 * "Give a key group to…": a tunnel group or one device, every account or only some (names, picked from the
 * accounts I may use on those devices), with a live preview below (`KeyGroupFlow`, the unsaved grant in the
 * primary colour). Granting an existing target again just changes its accounts.
 */
import React, { useState } from "react";
import Link from "next/link";
import { FolderTree, HardDrive, Loader2, Send } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { SectionHeading } from "@/components/ui/section";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { KeyGroupFlow } from "@/components/keys/KeyGroupFlow";
import { DeviceFilterBar, DeviceFilterFooter, useDeviceFilter } from "@/components/keys/DeviceFilter";
import { GroupSearchBox, GroupSearchFooter, useGroupSearch } from "@/components/groups/GroupSearch";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { accountChoices } from "@/lib/groups";
import type { GrantTarget } from "@/hooks/useKeyGroups";
import type { KeyGroup, KeyGroupGrant, TunnelGroup } from "@/types/groups";
import type { KeyDevice, UserKey } from "@/types/keys";

type Kind = "group" | "device";

const choice = "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30";

export function KeyGroupGrantDialog({
    group,
    keys,
    tunnelGroups,
    devices,
    onClose,
    onSubmit,
}: {
    group: KeyGroup;
    keys: UserKey[];
    tunnelGroups: TunnelGroup[];
    devices: KeyDevice[];
    onClose: () => void;
    onSubmit: (target: GrantTarget, accounts: string[] | null) => Promise<boolean>;
}) {
    const { t } = useI18n();
    const ordered = [...tunnelGroups].sort((a, b) => a.position - b.position || a.id - b.id);
    const [kind, setKind] = useState<Kind>(ordered.length ? "group" : "device");
    const [groupId, setGroupId] = useState<number | null>(ordered[0]?.id ?? null);
    const [deviceId, setDeviceId] = useState<number | null>(null);
    const [some, setSome] = useState<string[] | null>(null);
    const [saving, setSaving] = useState(false);
    const filter = useDeviceFilter(devices, { device: (d) => d });
    const groupSearch = useGroupSearch(ordered, groupId);

    const targetIds = kind === "group" ? (ordered.find((g) => g.id === groupId)?.tunnel_ids ?? []) : deviceId !== null ? [deviceId] : [];
    const choices = accountChoices(targetIds, devices);
    const existing = group.grants.find((g) => (kind === "group" ? g.tunnel_group?.id === groupId : g.tunnel?.id === deviceId));
    const hasTarget = kind === "group" ? groupId !== null : deviceId !== null;

    // 換對象時帶入已經授予過的帳號選擇。/ Switching to an already granted target loads its account choice.
    const [loadedFor, setLoadedFor] = useState<number | null>(null);
    if (existing && loadedFor !== existing.id) {
        setLoadedFor(existing.id);
        setSome(existing.accounts);
    }

    const target: KeyGroupGrant | null = !hasTarget
        ? null
        : {
              id: -1,
              tunnel: kind === "device" ? { id: deviceId!, name: devices.find((d) => d.tunnel_id === deviceId)?.host_friendly_name ?? "" } : null,
              tunnel_group: kind === "group" ? { id: groupId!, name: ordered.find((g) => g.id === groupId)?.name ?? "" } : null,
              accounts: some,
              created_at: "",
          };
    const invalid = !hasTarget || (some !== null && some.length === 0);

    const submit = async () => {
        if (!target || invalid) return;
        setSaving(true);
        const ok = await onSubmit(kind === "group" ? { tunnel_group_id: groupId! } : { tunnel_id: deviceId! }, some);
        setSaving(false);
        if (ok) onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("groups.grant.title", { name: group.name })}
            description={t("groups.grant.description")}
            icon={<Send />}
            size="4xl"
            // 兩個分頁的內容高度不同：固定視窗大小，切換時才不會跳來跳去。/ The two tabs differ in height: a fixed size keeps the dialog still when switching.
            fixedHeight
            toolbar={
                <Segmented
                    size="sm"
                    value={kind}
                    onChange={setKind}
                    aria-label={t("groups.grant.title", { name: group.name })}
                    options={[
                        { value: "group", label: t("groups.grant.toGroup") },
                        { value: "device", label: t("groups.grant.toDevice") },
                    ]}
                />
            }
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
                    <Button onClick={submit} disabled={saving || invalid}>
                        {saving && <Loader2 className="animate-spin" />} {existing ? t("groups.grant.update") : t("groups.grant.submit")}
                    </Button>
                </>
            }
        >
            <div className="space-y-5">
                {kind === "group" ? (
                    ordered.length === 0 ? (
                        <Callout tone="info">
                            {t("groups.grant.noTunnelGroups")}{" "}
                            <Link href="/tunnels" className="text-primary hover:underline">{t("tunnels.title")}</Link>
                        </Callout>
                    ) : (
                        <fieldset className="space-y-2">
                            <legend className="sr-only">{t("groups.grant.toGroup")}</legend>
                            <GroupSearchBox s={groupSearch} />
                            <div className="grid gap-1.5 p-px sm:grid-cols-2">
                                {groupSearch.visible.map((g) => (
                                    <label key={g.id} className={choice}>
                                        <input type="radio" name="grant-group" checked={groupId === g.id} onChange={() => setGroupId(g.id)} className="size-4 shrink-0 accent-primary" />
                                        <FolderTree size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-foreground" title={g.name}>{g.name}</span>
                                            {g.description && <span className="block truncate text-xs text-muted-foreground" title={g.description}>{g.description.replace(/\s+/g, " ")}</span>}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">{t("groups.grant.devices", { count: g.tunnel_ids.length })}</span>
                                    </label>
                                ))}
                            </div>
                            <GroupSearchFooter s={groupSearch} />
                            <p className="text-xs text-muted-foreground">{t("groups.grant.groupLater")}</p>
                        </fieldset>
                    )
                ) : devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("groups.grant.noDevices")}</p>
                ) : (
                    <fieldset className="space-y-2">
                        <legend className="sr-only">{t("groups.grant.toDevice")}</legend>
                        <DeviceFilterBar filter={filter} modes={["all"]} />
                        <div className="grid gap-1.5 p-px sm:grid-cols-2">
                            {filter.visible.map((d) => (
                                <label key={d.tunnel_id} className={choice}>
                                    <input type="radio" name="grant-device" checked={deviceId === d.tunnel_id} onChange={() => setDeviceId(d.tunnel_id)} className="size-4 shrink-0 accent-primary" />
                                    <HardDrive size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                                    <StatusDot health={d.online ? "online" : "offline"} />
                                    <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={d.host_friendly_name}>{d.host_friendly_name}</span>
                                    <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground">{d.accounts.join(", ") || t("keys.status.noAccounts")}</span>
                                </label>
                            ))}
                        </div>
                        <DeviceFilterFooter filter={filter} />
                    </fieldset>
                )}

                {hasTarget && (
                    <fieldset className="space-y-2">
                        <legend className="text-sm text-foreground">{t("groups.grant.accounts")}</legend>
                        <div className="flex flex-wrap gap-1.5">
                            <label className={cn(choice, "py-1.5")}>
                                <input type="radio" name="grant-accounts" checked={some === null} onChange={() => setSome(null)} className="size-4 accent-primary" />
                                <span className="text-sm">{t("groups.grant.accountsAll")}</span>
                            </label>
                            <label className={cn(choice, "py-1.5")}>
                                <input type="radio" name="grant-accounts" checked={some !== null} onChange={() => setSome(some ?? [])} className="size-4 accent-primary" />
                                <span className="text-sm">{t("groups.grant.accountsSome")}</span>
                            </label>
                        </div>
                        {some !== null && (
                            <div className="space-y-1.5 rounded-lg bg-surface p-2.5 ring-1 ring-border">
                                {choices.length === 0 && some.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">{t("groups.grant.accountsNone")}</p>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {[...new Set([...choices, ...some])].sort().map((a) => (
                                            <label key={a} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-mono text-sm ring-1 ring-border hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30">
                                                <input
                                                    type="checkbox"
                                                    checked={some.includes(a)}
                                                    onChange={(e) => setSome(e.target.checked ? [...some, a] : some.filter((x) => x !== a))}
                                                    className="size-4 accent-primary"
                                                />
                                                {a}
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <p className="text-xs text-muted-foreground">{some.length === 0 ? t("groups.grant.pickOne") : t("groups.grant.accountsHint")}</p>
                            </div>
                        )}
                        {existing && <p className="text-xs text-muted-foreground">{t("groups.grant.already")}</p>}
                    </fieldset>
                )}

                <section>
                    <SectionHeading title={t("groups.grant.preview")} className="mb-2" />
                    <KeyGroupFlow group={group} keys={keys} tunnelGroups={tunnelGroups} devices={devices} extra={target} />
                </section>
            </div>
        </Modal>
    );
}
