"use client";

/**
 * 身分提供者對話框的「自動建立帳號（SCIM）」頁：SCIM 基底網址、權杖（建立 / 換掉 / 關掉，新權杖只顯示一次）、
 * 這個身分提供者管了幾個帳號與群組、推送的群組變成角色（功能）還是群組（分享）、它會做什麼，以及 Okta / Microsoft
 * Entra 那邊要填哪裡。
 * The provider dialog's "Provisioning (SCIM)" tab: the base URL, the token (create / replace / turn off; a new token
 * is shown once), how many accounts and groups this provider manages, whether pushed groups become roles (features)
 * or groups (sharing), what it does, and where Okta / Entra take it.
 */
import { useState } from "react";
import { BadgeCheck, KeyRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/field";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/Toast";
import { useReauth } from "@/hooks/useReauth";
import type { OidcProvider } from "@/hooks/useOidcProviders";
import type { ScimGroupsAs } from "@/lib/sso";
import { readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { mfaErrorMessage, needsReauth } from "@/lib/mfa";
import { formatRelativeTime } from "@/lib/relativeTime";
import { CopyButton } from "@/components/ui/CopyButton";

export function ScimTab({
    provider,
    base,
    createToken,
    removeToken,
    refresh,
    groupsAs,
    onGroupsAs,
    groupsAsError,
}: {
    provider: OidcProvider | null;
    base: string;
    createToken: (p: OidcProvider, reauth: unknown) => Promise<Response>;
    removeToken: (p: OidcProvider) => Promise<void>;
    refresh: () => Promise<void>;
    /** 推送的群組變成什麼（對話框的草稿，按儲存才送出）。/ What pushed groups become (the dialog's draft, sent on Save). */
    groupsAs: ScimGroupsAs;
    onGroupsAs: (v: ScimGroupsAs) => void;
    groupsAsError?: string;
}) {
    const { t, locale } = useI18n();
    const { showError, showSuccess } = useToast();
    const { request, dialog } = useReauth();
    const [fresh, setFresh] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<"replace" | "remove" | null>(null);

    const groupsChoice = (
        <Field label={t("scim.groupsAs")} hint={t(groupsAs === "group" ? "scim.groupsAsGroup" : "scim.groupsAsRole")} error={groupsAsError}>
            <Segmented<ScimGroupsAs>
                size="sm"
                aria-label={t("scim.groupsAs")}
                value={groupsAs}
                onChange={onGroupsAs}
                options={[
                    { value: "role", label: t("scim.asRole"), icon: <BadgeCheck size={13} /> },
                    { value: "group", label: t("scim.asGroup"), icon: <Users size={13} /> },
                ]}
            />
        </Field>
    );

    if (!provider) {
        return (
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t("scim.intro")}</p>
                {groupsChoice}
                <Callout tone="info">{t("scim.saveFirst")}</Callout>
            </div>
        );
    }
    const scim = provider.scim;
    const active = !!scim?.active;

    const make = async () => {
        setBusy(true);
        try {
            let res = await createToken(provider, null);
            let data = await readJson<{ token?: string }>(res);
            const methods = needsReauth(res.status, data);
            if (methods) {
                const proof = await request(methods, t("scim.reauth"));
                if (!proof) return;
                res = await createToken(provider, proof);
                data = await readJson<{ token?: string }>(res);
            }
            if (res.ok && data?.token) {
                setFresh(data.token);
                showSuccess(t("scim.created"));
                await refresh();
            } else showError(mfaErrorMessage(t, data, t("sso.admin.saveFailed")));
        } finally {
            setBusy(false);
        }
    };

    const when = (iso: string | null | undefined) => (iso ? formatRelativeTime(iso, locale) : null);

    return (
        <div className="space-y-5">
            <p className="text-sm text-muted-foreground">{t("scim.intro")}</p>

            <Field label={t("scim.baseUrl")} hint={t("scim.baseUrlHint")}>
                <div className="flex items-center gap-1 rounded-md bg-surface py-1.5 pl-3 pr-1">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{base}</code>
                    <CopyButton value={base} />
                </div>
            </Field>

            <div className="space-y-2">
                <SectionHeading icon={<KeyRound />} title={t("scim.token")} description={t("scim.tokenHint")} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface px-3 py-2.5">
                    <div className="min-w-0 flex-1 text-sm">
                        {active ? (
                            <>
                                <p className="flex flex-wrap items-center gap-2">
                                    <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
                                    <span>{t("scim.on")}</span>
                                    <Chip mono>{`${scim!.prefix}…`}</Chip>
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    {[
                                        scim!.created_at && t("scim.madeAt", { when: when(scim!.created_at)! }),
                                        scim!.last_used_at ? t("scim.usedAt", { when: when(scim!.last_used_at)! }) : t("scim.neverUsed"),
                                    ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </p>
                            </>
                        ) : (
                            <p className="flex items-center gap-2">
                                <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                                <span>{t("scim.off")}</span>
                            </p>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {active ? (
                            <>
                                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("replace")}>
                                    {t("scim.replace")}
                                </Button>
                                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("remove")}>
                                    {t("scim.turnOff")}
                                </Button>
                            </>
                        ) : (
                            <Button type="button" size="sm" disabled={busy} onClick={() => void make()}>
                                {t("scim.create")}
                            </Button>
                        )}
                    </div>
                </div>
                {fresh && (
                    <Callout tone="success" title={t("scim.copyNow")}>
                        <div className="mt-1 flex items-center gap-1 rounded-md bg-card py-1 pl-2.5 pr-1 ring-1 ring-inset ring-border/80">
                            <code className="min-w-0 flex-1 break-all font-mono text-xs">{fresh}</code>
                            <CopyButton value={fresh} />
                        </div>
                    </Callout>
                )}
                {scim && (scim.users > 0 || scim.groups > 0) && <p className="text-xs text-muted-foreground">{t("scim.counts", { users: scim.users, groups: scim.groups })}</p>}
            </div>

            {groupsChoice}

            <div className="space-y-2">
                <SectionHeading title={t("scim.doesTitle")} />
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground marker:text-border">
                    <li>{t("scim.doesCreate")}</li>
                    <li>{t("scim.doesDisable")}</li>
                    <li>{t("scim.doesDelete")}</li>
                    <li>{t(groupsAs === "group" ? "scim.doesGroupsAsGroup" : "scim.doesGroups")}</li>
                    <li>{t("scim.doesExisting")}</li>
                </ul>
            </div>

            <div className="space-y-2">
                <SectionHeading title={t("scim.whereTitle")} />
                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                    <dt>Okta</dt>
                    <dd className="text-muted-foreground">{t("scim.whereOkta")}</dd>
                    <dt>Microsoft Entra ID</dt>
                    <dd className="text-muted-foreground">{t("scim.whereEntra")}</dd>
                </dl>
            </div>

            {confirm && (
                <ConfirmDialog
                    isOpen
                    isDestructive={confirm === "remove"}
                    title={t(confirm === "replace" ? "scim.replaceTitle" : "scim.turnOffTitle")}
                    message={t(confirm === "replace" ? "scim.replaceMessage" : "scim.turnOffMessage")}
                    confirmText={t(confirm === "replace" ? "scim.replace" : "scim.turnOff")}
                    onConfirm={() => {
                        const what = confirm;
                        setConfirm(null);
                        if (what === "replace") void make();
                        else {
                            setFresh(null);
                            void removeToken(provider);
                        }
                    }}
                    onClose={() => setConfirm(null)}
                />
            )}
            {dialog}
        </div>
    );
}
