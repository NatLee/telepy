/**
 * 一把個人金鑰的卡片：名稱、類型 / 位元數、SHA256 指紋（可複製）、註解與說明、最後使用（時間 + 來源 IP）、
 * 放在哪些裝置的清單上。
 * Card for one personal key: name, type / size, copyable SHA256 fingerprint, comment and description, last
 * use (time + source IP) and which devices' lists it is on.
 */
import React from "react";
import { Clock3, HardDrive, KeyRound, Trash2, TriangleAlert, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/CopyButton";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { KeyDevice, KeyTarget, UserKey } from "@/types/keys";

export function KeyTypeBadge({ type, bits }: { type: string | null; bits: number | null }) {
    const { t } = useI18n();
    if (!type) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[0.75rem] text-warning ring-1 ring-inset ring-warning/30">
                <TriangleAlert size={12} aria-hidden /> {t("keys.unrecognized")}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[0.75rem] text-muted-foreground">
            {type}
            {bits ? ` · ${bits}` : ""}
        </span>
    );
}

export function KeyCard({
    keyItem,
    placements,
    onDetails,
    onDelete,
}: {
    keyItem: UserKey;
    placements: { device: KeyDevice; targets: KeyTarget[] }[];
    onDetails: () => void;
    onDelete: () => void;
}) {
    const { t, locale } = useI18n();
    const installed = placements.filter((p) => p.targets.some((tg) => tg.status === "installed")).length;
    return (
        <Card className="group h-full gap-0 p-0 hover:shadow-card-hover">
            <div className="flex items-start gap-3 p-4 pb-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary" aria-hidden>
                    <KeyRound size={18} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="truncate text-[1rem] text-foreground" title={keyItem.host_friendly_name}>{keyItem.host_friendly_name}</h3>
                        <KeyTypeBadge type={keyItem.key_type} bits={keyItem.bits} />
                    </div>
                    {keyItem.comment && <p className="mt-0.5 truncate font-mono text-[0.75rem] text-muted-foreground" title={keyItem.comment}>{keyItem.comment}</p>}
                </div>
            </div>

            <div className="mx-4 flex items-center gap-1 rounded-lg bg-surface py-1 pl-2.5 pr-1 ring-1 ring-border">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-muted-foreground" title={keyItem.fingerprint ?? ""}>
                    {keyItem.fingerprint ?? t("keys.noFingerprint")}
                </span>
                {keyItem.fingerprint && <CopyButton value={keyItem.fingerprint} />}
            </div>

            {keyItem.description && <p className="mx-4 mt-2.5 line-clamp-2 text-xs text-muted-foreground">{keyItem.description}</p>}

            <dl className="mx-4 mb-4 mt-3 space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                    <Clock3 size={14} className="mt-px shrink-0 text-muted-foreground" aria-hidden />
                    <dt className="sr-only">{t("keys.lastUsed")}</dt>
                    <dd className="min-w-0 text-muted-foreground">
                        {keyItem.last_used_at ? (
                            <span title={new Date(keyItem.last_used_at).toLocaleString(locale)}>
                                {keyItem.last_used_ip
                                    ? t("keys.usedFrom", { when: formatRelativeTime(keyItem.last_used_at, locale), ip: keyItem.last_used_ip })
                                    : t("keys.used", { when: formatRelativeTime(keyItem.last_used_at, locale) })}
                            </span>
                        ) : (
                            t("keys.neverUsed")
                        )}
                    </dd>
                </div>
                <div className="flex items-start gap-2">
                    <HardDrive size={14} className="mt-px shrink-0 text-muted-foreground" aria-hidden />
                    <dt className="sr-only">{t("keys.onDevices")}</dt>
                    <dd className="min-w-0 text-muted-foreground">
                        {placements.length === 0 ? (
                            t("keys.onNoDevice")
                        ) : (
                            <span title={placements.map((p) => p.device.host_friendly_name).join(", ")}>
                                <span className="text-foreground/80">{placements.map((p) => p.device.host_friendly_name).join(", ")}</span>
                                <span> · {t("keys.onDeviceCount", { count: placements.length, installed })}</span>
                            </span>
                        )}
                    </dd>
                </div>
            </dl>

            <div className="mt-auto flex gap-1.5 border-t border-border/70 p-3 pt-2.5">
                <Button variant="ghost" size="sm" onClick={onDetails} className="flex-1 text-primary hover:text-primary">
                    <PanelRightOpen /> {t("common.details")}
                </Button>
                <Button variant="ghost" size="sm" onClick={onDelete} className="flex-1 text-destructive hover:bg-destructive/8 hover:text-destructive">
                    <Trash2 /> {t("common.delete")}
                </Button>
            </div>
        </Card>
    );
}
