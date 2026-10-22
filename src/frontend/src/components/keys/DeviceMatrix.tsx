/**
 * 「我的金鑰 × 我能用的裝置」矩陣：勾選 = 放進那台裝置的金鑰清單；格子裡是每個 OS 帳號的安裝狀態。
 * 桌面是表格（金鑰多時可橫向捲動），手機改成每台裝置一張卡。
 * My keys × the devices I can use: a tick puts the key on that device's list; each cell shows the
 * per-account install state. A table on desktop (scrolls sideways with many keys), cards on phones.
 */
import React from "react";
import Link from "next/link";
import { HardDrive, Loader2, Plus, RefreshCw, Settings2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { KeyDevice, TunnelRole, UserKey } from "@/types/keys";
import { TargetChips } from "./TargetChips";

const ROLE_KEY: Record<TunnelRole, TranslationKey> = {
    owner: "keys.role.owner",
    admin: "keys.role.admin",
    edit: "keys.role.edit",
    view: "keys.role.view",
};

export function OnlineDot({ online }: { online: boolean }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground">
            <span className={cn("size-2 rounded-full", online ? "bg-success shadow-[0_0_0_3px] shadow-success/15" : "bg-muted-foreground/40")} aria-hidden />
            {online ? t("keys.online") : t("keys.offline")}
        </span>
    );
}

export function RoleBadge({ role }: { role: TunnelRole }) {
    const { t } = useI18n();
    return (
        <span className={cn("rounded-full px-1.5 py-px text-[0.6875rem] ring-1 ring-inset", role === "owner" ? "bg-primary/8 text-primary ring-primary/25" : "bg-brand-2/10 text-brand-2 ring-brand-2/30")}>
            {t(ROLE_KEY[role])}
        </span>
    );
}

function DeviceHeading({ device }: { device: KeyDevice }) {
    const { t } = useI18n();
    return (
        <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <HardDrive size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm text-foreground">{device.host_friendly_name}</span>
                <RoleBadge role={device.role} />
                <OnlineDot online={device.online} />
            </div>
            <div className="mt-1 text-[0.75rem] text-muted-foreground">
                {device.accounts.length > 0 ? (
                    <>
                        {t("keys.matrix.accounts")} <span className="font-mono text-foreground/80">{device.accounts.join(", ")}</span>
                    </>
                ) : (
                    <span className="inline-flex items-center gap-1 text-warning">
                        <ShieldAlert size={12} aria-hidden /> {device.role === "owner" || device.role === "admin" ? t("keys.matrix.noAccountsOwner") : t("keys.matrix.noAccountsSharee")}
                    </span>
                )}
            </div>
        </div>
    );
}

function Cell({ device, keyItem, busy, onToggle }: { device: KeyDevice; keyItem: UserKey; busy: boolean; onToggle: (on: boolean) => void }) {
    const { t } = useI18n();
    const placed = device.keys.find((k) => k.user_key_id === keyItem.id);
    const id = `cell-${device.tunnel_id}-${keyItem.id}`;
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground has-[:disabled]:cursor-wait">
                {busy ? (
                    <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                ) : (
                    <input
                        id={id}
                        type="checkbox"
                        checked={!!placed}
                        disabled={busy}
                        onChange={(e) => onToggle(e.target.checked)}
                        className="size-4 cursor-pointer rounded accent-primary"
                    />
                )}
                <span className="sr-only">{t("keys.matrix.toggleAria", { key: keyItem.host_friendly_name, device: device.host_friendly_name })}</span>
                <span aria-hidden>{placed ? t("keys.matrix.inList") : t("keys.matrix.notInList")}</span>
            </label>
            {placed && <TargetChips targets={placed.targets} online={device.online} />}
        </div>
    );
}

export function DeviceMatrix({
    devices,
    keys,
    pending,
    syncing,
    onToggle,
    onSync,
    onManage,
}: {
    devices: KeyDevice[];
    keys: UserKey[];
    pending: Set<string>;
    syncing: Set<number>;
    onToggle: (device: KeyDevice, key: UserKey, on: boolean) => void;
    onSync: (device: KeyDevice) => void;
    onManage: (device: KeyDevice) => void;
}) {
    const { t } = useI18n();

    if (devices.length === 0) {
        return (
            <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-card px-6 py-10 text-center">
                <HardDrive size={32} className="text-muted-foreground/60" aria-hidden />
                <div>
                    <p className="text-sm text-foreground">{t("keys.matrix.emptyTitle")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("keys.matrix.emptyBody")}</p>
                </div>
                <Button asChild size="sm" variant="outline">
                    <Link href="/tunnels/create"><Plus /> {t("keys.matrix.createTunnel")}</Link>
                </Button>
            </div>
        );
    }

    const actions = (d: KeyDevice) => (
        <div className="flex shrink-0 items-center gap-1">
            <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onSync(d)}
                disabled={syncing.has(d.tunnel_id) || d.keys.length === 0}
                title={t("keys.matrix.syncNow")}
                aria-label={t("keys.matrix.syncAria", { device: d.host_friendly_name })}
            >
                <RefreshCw className={cn(syncing.has(d.tunnel_id) && "animate-spin")} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => onManage(d)}>
                <Settings2 /> {t("keys.matrix.manage")}
            </Button>
        </div>
    );

    return (
        <>
            {/* 桌面：表格 / Desktop: table */}
            <div className="hidden overflow-x-auto rounded-xl border border-border/80 bg-card shadow-card md:block">
                <table className="w-full min-w-max text-left">
                    <thead className="bg-surface text-xs text-muted-foreground">
                        <tr>
                            <th scope="col" className="sticky left-0 z-10 bg-surface px-4 py-2.5 font-normal">{t("keys.matrix.device")}</th>
                            {keys.map((k) => (
                                <th key={k.id} scope="col" className="max-w-[14rem] px-4 py-2.5 font-normal normal-case tracking-normal">
                                    <span className="block truncate text-xs text-foreground" title={k.host_friendly_name}>{k.host_friendly_name}</span>
                                    <span className="font-mono text-[0.6875rem] text-muted-foreground">{k.key_type ?? "?"}</span>
                                </th>
                            ))}
                            <th scope="col" className="px-4 py-2.5 text-right font-normal"><span className="sr-only">{t("keys.thActions")}</span></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                        {devices.map((d) => (
                            <tr key={d.tunnel_id} className="align-top transition-colors hover:bg-muted/30">
                                <th scope="row" className="sticky left-0 z-10 max-w-[18rem] bg-card px-4 py-3 font-normal">
                                    <DeviceHeading device={d} />
                                </th>
                                {keys.map((k) => (
                                    <td key={k.id} className="max-w-[14rem] px-4 py-3">
                                        <Cell device={d} keyItem={k} busy={pending.has(`${d.tunnel_id}:${k.id}`)} onToggle={(on) => onToggle(d, k, on)} />
                                    </td>
                                ))}
                                <td className="px-4 py-3">
                                    <div className="flex justify-end">{actions(d)}</div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* 手機：卡片 / Phones: cards */}
            <div className="space-y-3 md:hidden">
                {devices.map((d) => (
                    <div key={d.tunnel_id} className="rounded-xl border border-border/80 bg-card p-4 shadow-card">
                        <div className="flex items-start justify-between gap-3">
                            <DeviceHeading device={d} />
                        </div>
                        <ul className="mt-3 space-y-3 border-t border-border/70 pt-3">
                            {keys.map((k) => (
                                <li key={k.id} className="flex flex-col gap-1.5">
                                    <span className="truncate text-xs text-foreground">{k.host_friendly_name}</span>
                                    <Cell device={d} keyItem={k} busy={pending.has(`${d.tunnel_id}:${k.id}`)} onToggle={(on) => onToggle(d, k, on)} />
                                </li>
                            ))}
                        </ul>
                        <div className="mt-3 flex justify-end border-t border-border/70 pt-3">{actions(d)}</div>
                    </div>
                ))}
            </div>
        </>
    );
}
