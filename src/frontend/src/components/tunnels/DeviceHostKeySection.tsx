"use client";

/**
 * 隧道詳細資訊的「裝置身分」：Telepy 第一次連到裝置時記下的 SSH host key 指紋；之後裝置出示不同的金鑰時連線全部被擋，
 * 這裡列出新的指紋、教使用者在裝置上核對，擁有者 / ADMIN 確認後才改信任。釘選的金鑰也是「這台機器」的身分：
 * 機器屬於別的帳號的隧道時連線被拒（這裡說明原因），自己的其他隧道在同一台上時列出來。
 * The "device identity" section: the pinned host-key fingerprint, and when the device shows a different key,
 * the refused fingerprint with how to check it on the device and an owner-only "trust this key". The pinned key is
 * also the machine's identity: a machine owned by another account's tunnel is refused (explained here), and the
 * user's other tunnels on the same machine are listed.
 */
import React, { useEffect, useRef, useState } from "react";
import { Fingerprint, Layers, ShieldAlert, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { useDeviceHostKey, type HostKey } from "@/hooks/useDeviceHostKey";
import { useI18n } from "@/lib/i18n";

const CHECK_COMMANDS = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\n# Windows (PowerShell):\nssh-keygen -lf $env:ProgramData\\ssh\\ssh_host_ed25519_key.pub";
// 複製出來的機器：重做 host key 後它就是另一台了。/ A cloned machine: new host keys make it a machine of its own.
const REGENERATE_COMMANDS = "sudo rm /etc/ssh/ssh_host_*_key*\nsudo ssh-keygen -A\nsudo systemctl restart ssh";

const SOURCE_KEY = { join: "hostKey.sourceJoin", accepted: "hostKey.sourceAccepted" } as const;

export function DeviceHostKeySection({ tunnelId, isOpen, onChanged, onAlert }: {
    tunnelId: number | null;
    isOpen: boolean;
    onChanged?: () => void;
    /** 金鑰變了 / 機器是別人的(通道詳細資訊用來標紅分頁並切過來)。/ Key changed or machine claimed (the details dialog marks and opens its tab). */
    onAlert?: (alert: boolean) => void;
}) {
    const { t, tn, locale } = useI18n();
    const { data, loaded, busy, accept, forget } = useDeviceHostKey(tunnelId, isOpen, onChanged);
    const [confirmAccept, setConfirmAccept] = useState<HostKey | null>(null);
    const [confirmForget, setConfirmForget] = useState(false);
    const time = (iso: string) => new Date(iso).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const changed = !!data && data.rejected.length > 0;
    const claimed = !!data?.refused_claim;
    // 金鑰變了 / 機器是別人的：開窗時直接捲到這一段（最要緊的事不該藏在下面）。/ Scroll this section into view on open.
    const anchorRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (changed || claimed) anchorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        onAlert?.(changed || claimed);
    }, [changed, claimed, onAlert]);

    if (!loaded) return null;

    return (
        <div ref={anchorRef} className="scroll-mt-2">
        <Section
            icon={claimed ? <ShieldOff /> : changed ? <ShieldAlert /> : <ShieldCheck />}
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
                    {data.refused_claim && (
                        <Callout tone="danger" title={t("hostKey.claimedTitle")}>
                            <p>{t("hostKey.claimedBody")}</p>
                            <p className="mt-2 flex items-center gap-2 break-all font-mono text-sm text-foreground">
                                <Fingerprint size={14} className="shrink-0 text-muted-foreground" aria-hidden /> {data.refused_claim.fingerprint}
                                <span className="font-sans text-xs text-muted-foreground">{time(data.refused_claim.at)}</span>
                            </p>
                            <p className="mt-3">{t("hostKey.claimedClone")}</p>
                            <pre className="mt-1.5 overflow-x-auto rounded-md bg-surface px-3 py-2 font-mono text-xs text-foreground">{REGENERATE_COMMANDS}</pre>
                        </Callout>
                    )}
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
                                        {tn(SOURCE_KEY[k.source as keyof typeof SOURCE_KEY] ?? "hostKey.sourceFirstUse", { time: time(k.first_seen) })}
                                    </Property>
                                </React.Fragment>
                            ))}
                            {data.same_machine.length > 0 && (
                                <Property label={t("hostKey.sameMachine")}>
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        {data.same_machine.map((s) => (
                                            <Chip key={s.id}><Layers /> {s.name}</Chip>
                                        ))}
                                        <span className="text-xs text-muted-foreground">{t("hostKey.sameMachineHint")}</span>
                                    </span>
                                </Property>
                            )}
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
        </div>
    );
}
