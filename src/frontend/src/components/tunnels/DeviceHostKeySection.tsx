"use client";

/**
 * 隧道詳細資訊的「裝置身分」：Telepy 第一次連到裝置時記下的 SSH host key 指紋；之後裝置出示不同的金鑰時連線全部被擋，
 * 這裡列出新的指紋、教使用者在裝置上核對，擁有者 / ADMIN 確認後才改信任。
 * The "device identity" section: the pinned host-key fingerprint, and when the device shows a different key,
 * the refused fingerprint with how to check it on the device and an owner-only "trust this key".
 */
import React, { useState } from "react";
import { Fingerprint, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { useDeviceHostKey, type HostKey } from "@/hooks/useDeviceHostKey";
import { useI18n } from "@/lib/i18n";

const CHECK_COMMANDS = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\n# Windows (PowerShell):\nssh-keygen -lf $env:ProgramData\\ssh\\ssh_host_ed25519_key.pub";

export function DeviceHostKeySection({ tunnelId, isOpen, onChanged }: { tunnelId: number | null; isOpen: boolean; onChanged?: () => void }) {
    const { t, tn, locale } = useI18n();
    const { data, loaded, busy, accept, forget } = useDeviceHostKey(tunnelId, isOpen, onChanged);
    const [confirmAccept, setConfirmAccept] = useState<HostKey | null>(null);
    const [confirmForget, setConfirmForget] = useState(false);
    const time = (iso: string) => new Date(iso).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    if (!loaded) return null;
    const changed = !!data && data.rejected.length > 0;

    return (
        <Section
            icon={changed ? <ShieldAlert /> : <ShieldCheck />}
            title={t("hostKey.title")}
            description={t("hostKey.description")}
            action={data?.can_manage && data.pinned.length > 0 ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmForget(true)} disabled={busy}>
                    <Trash2 size={14} /> {t("hostKey.forget")}
                </Button>
            ) : undefined}
        >
            {!data ? (
                <p className="text-sm text-muted-foreground">{t("hostKey.loadFailed")}</p>
            ) : (
                <>
                    {changed && (
                        <Callout tone="danger">
                            <p>{t("hostKey.changedTitle")}</p>
                            <p className="mt-1 text-muted-foreground">{t("hostKey.changedBody")}</p>
                        </Callout>
                    )}
                    {data.rejected.map((k) => (
                        <div key={k.fingerprint} className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <Chip tone="danger"><ShieldAlert /> {t("hostKey.refused")}</Chip>
                                <Chip mono>{k.key_type}</Chip>
                                <span className="text-xs text-muted-foreground">{t("hostKey.refusedSeen", { time: time(k.first_seen), count: k.attempts })}</span>
                            </div>
                            <p className="mt-2 flex items-center gap-2 break-all font-mono text-sm text-foreground">
                                <Fingerprint size={14} className="shrink-0 text-muted-foreground" aria-hidden /> {k.fingerprint}
                            </p>
                            <p className="mt-3 text-sm text-muted-foreground">{t("hostKey.howToCheck")}</p>
                            <pre className="mt-1.5 overflow-x-auto rounded-md bg-surface px-3 py-2 font-mono text-xs text-foreground">{CHECK_COMMANDS}</pre>
                            {data.can_manage ? (
                                <Button type="button" size="sm" variant="destructive" className="mt-3" onClick={() => setConfirmAccept(k)} disabled={busy}>
                                    {t("hostKey.trust")}
                                </Button>
                            ) : (
                                <p className="mt-3 text-xs text-muted-foreground">{t("hostKey.askOwner")}</p>
                            )}
                        </div>
                    ))}
                    {data.pinned.length === 0 && !changed ? (
                        <p className="text-sm text-muted-foreground">{t("hostKey.notYet")}</p>
                    ) : (
                        <PropertyList>
                            {data.pinned.map((k) => (
                                <React.Fragment key={k.fingerprint}>
                                    <Property label={t("hostKey.fingerprint")} mono>
                                        <span className="inline-flex items-center gap-1.5">
                                            <span className="break-all">{k.fingerprint}</span>
                                            <CopyButton value={k.fingerprint} />
                                        </span>
                                    </Property>
                                    <Property label={t("hostKey.type")} mono>{k.key_type}</Property>
                                    <Property label={t("hostKey.trustedSince")}>
                                        {tn(k.source === "accepted" ? "hostKey.sourceAccepted" : "hostKey.sourceFirstUse", { time: time(k.first_seen) })}
                                    </Property>
                                </React.Fragment>
                            ))}
                        </PropertyList>
                    )}
                </>
            )}

            <ConfirmDialog
                isOpen={!!confirmAccept}
                onClose={() => setConfirmAccept(null)}
                onConfirm={() => {
                    if (confirmAccept) void accept(confirmAccept.fingerprint);
                    setConfirmAccept(null);
                }}
                title={t("hostKey.trustTitle")}
                message={tn("hostKey.trustMessage", { fingerprint: <code className="break-all font-mono text-xs">{confirmAccept?.fingerprint ?? ""}</code> })}
                confirmText={t("hostKey.trust")}
                isDestructive
            />
            <ConfirmDialog
                isOpen={confirmForget}
                onClose={() => setConfirmForget(false)}
                onConfirm={() => {
                    void forget();
                    setConfirmForget(false);
                }}
                title={t("hostKey.forgetTitle")}
                message={t("hostKey.forgetMessage")}
                confirmText={t("hostKey.forget")}
                isDestructive
            />
        </Section>
    );
}
