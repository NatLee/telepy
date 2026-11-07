"use client";

/**
 * `/tunnels/sso`：`?linked=<代號>` = 連好了；`?error=<code>&provider=` = 為什麼沒連上；`?test=<票券>` = 管理員試登入，
 * 用這個瀏覽器的綁定 cookie 換回 id_token 的 claim 與「Telepy 會怎麼做」，只看一次。
 * `/tunnels/sso`: `?linked=` = done; `?error=` = why not; `?test=<ticket>` = an admin's test sign-in, redeemed once
 * with this browser's binding cookie for the claims and what Telepy would do.
 */
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, FlaskConical, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { openPreferences } from "@/components/layout/UserPreferencesModal";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, Section, SectionPanels } from "@/components/ui/section";
import { usePageCrumb } from "@/hooks/usePageCrumb";
import { useSsoButtons } from "@/hooks/useSignInLook";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { orderedClaims, providerName, ssoErrorKey, type SsoTestResult } from "@/lib/sso";
import type { TranslationKey } from "@/locales/en";

const SETTINGS_HREF = "/tunnels/settings?tab=signin#sso";

/** 票券只能兌換一次（React 開發模式會跑兩次 effect）。/ A ticket redeems once (effects may run twice in dev). */
const redeemed = new Map<string, Promise<{ ok: boolean; data: unknown }>>();

function redeem(ticket: string) {
    let p = redeemed.get(ticket);
    if (!p) {
        p = apiFetch("/api/auth/oidc/test-result", { method: "POST", body: JSON.stringify({ ticket }) }).then(async (res) => ({ ok: res.ok, data: await readJson(res) }));
        redeemed.set(ticket, p);
    }
    return p;
}

const WOULD_KEYS: Record<string, TranslationKey> = {
    sign_in: "sso.test.wouldSignIn",
    link_by_email: "sso.test.wouldLink",
    create: "sso.test.wouldCreate",
    refuse: "sso.test.wouldRefuse",
};

function claimText(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
}

export function SsoResultView() {
    const { t, tn } = useI18n();
    const q = useSearchParams();
    const buttons = useSsoButtons();
    const linked = q.get("linked");
    const error = q.get("error");
    const ticket = q.get("test");
    const name = providerName(buttons, linked ?? q.get("provider"));
    const [test, setTest] = useState<SsoTestResult | null>(null);
    const [testError, setTestError] = useState<string | null>(null);
    const started = useRef(false);
    usePageCrumb(t("sso.page.title"));

    useEffect(() => {
        if (!ticket || started.current) return;
        started.current = true;
        // 換完把票券從網址拿掉（重新整理也不會再換一次）。/ Drop the ticket from the URL once redeemed.
        void redeem(ticket).then(({ ok, data }) => {
            window.history.replaceState(window.history.state, "", window.location.pathname + (q.get("provider") ? `?provider=${encodeURIComponent(q.get("provider")!)}` : ""));
            if (ok && data) setTest(data as SsoTestResult);
            else setTestError((data as { code?: string } | null)?.code ?? "sso_failed");
        });
    }, [ticket, q]);

    const back = { href: ticket || testError ? SETTINGS_HREF : "/tunnels", label: ticket || testError ? t("sso.page.backSettings") : t("sso.page.backTunnels") };

    return (
        <div className="mx-auto w-full max-w-3xl space-y-6">
            <PageHeader icon={<Building2 />} back={back} title={ticket || test || testError ? t("sso.test.title", { name }) : t("sso.page.title")} description={ticket || test ? t("sso.test.description") : undefined} />

            {linked && (
                <Callout tone="success" title={t("sso.page.linkedTitle", { name })}>
                    <p>{t("sso.page.linkedBody", { name })}</p>
                    <Button className="mt-3" size="sm" variant="outline" onClick={() => openPreferences("security")}>
                        {t("sso.page.openSecurity")}
                    </Button>
                </Callout>
            )}

            {error && (
                <Callout tone="danger" title={t("sso.page.failedTitle", { name })}>
                    <p>{t(ssoErrorKey(error), { name })}</p>
                    <Button className="mt-3" size="sm" variant="outline" onClick={() => openPreferences("security")}>
                        {t("sso.page.openSecurity")}
                    </Button>
                </Callout>
            )}

            {ticket && !test && !testError && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}

            {testError && (
                <Callout tone="danger" title={t("sso.test.failedTitle")}>
                    {t(testError === "admin_only" ? "sso.test.adminOnly" : ssoErrorKey(testError), { name })}
                </Callout>
            )}

            {test && (
                <SectionPanels>
                    <Section icon={<FlaskConical />} title={t("sso.test.would")} description={t("sso.test.nobody")}>
                        <Callout tone={test.would.action === "refuse" ? "warning" : "success"}>
                            {tn(WOULD_KEYS[test.would.action] ?? "sso.test.wouldRefuse", {
                                username: <code>{test.would.username ?? ""}</code>,
                                reason: test.would.code ? t(ssoErrorKey(test.would.code), { name: test.provider.name }) : "",
                            })}
                        </Callout>
                    </Section>
                    <Section icon={<ShieldCheck />} title={t("sso.test.groupsTitle")} description={t("sso.test.groupsHint", { claim: test.groups_claim ?? "groups" })}>
                        <RolesReport test={test} />
                    </Section>
                    <Section icon={<Building2 />} title={t("sso.test.claims")} description={t("sso.test.claimsHint")}>
                        <dl className="divide-y divide-border/70 rounded-lg text-sm ring-1 ring-inset ring-border/80">
                            {orderedClaims(test.claims).map(([k, v, read]) => (
                                <div key={k} className="grid gap-1 px-3 py-2 sm:grid-cols-[12rem_1fr] sm:gap-3">
                                    <dt className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                                        {k}
                                        {read && <Chip>{t("sso.test.read")}</Chip>}
                                    </dt>
                                    <dd className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]">{claimText(v)}</dd>
                                </div>
                            ))}
                        </dl>
                    </Section>
                </SectionPanels>
            )}

            {!linked && !error && !ticket && !test && !testError && (
                <p className="text-sm text-muted-foreground">
                    {t("sso.page.nothing")}{" "}
                    <Link href="/tunnels" className={buttonVariants({ variant: "link", size: "sm" })}>
                        {t("sso.page.backTunnels")}
                    </Link>
                </p>
            )}
        </div>
    );
}

/** 讀到的群組與角色會怎麼變。/ The groups found and how roles would change. */
function RolesReport({ test }: { test: SsoTestResult }) {
    const { t } = useI18n();
    const claim = test.groups_claim ?? "groups";
    const roles = test.would.roles;
    const lines: string[] = [];
    if (roles) {
        if (roles.join.length) lines.push(t("sso.test.join", { groups: roles.join.join(", ") }));
        if (roles.leave.length) lines.push(t("sso.test.leave", { groups: roles.leave.join(", ") }));
        if (roles.admin === "grant") lines.push(t("sso.test.adminGrant"));
        if (roles.admin === "revoke") lines.push(t("sso.test.adminRevoke"));
        if (roles.admin === "keep_last") lines.push(t("sso.test.adminKeepLast"));
    }
    return (
        <div className="space-y-3 text-sm">
            {test.groups == null ? (
                <Callout tone="warning">{t("sso.test.noGroupsClaim", { claim })}</Callout>
            ) : test.groups.length === 0 ? (
                <p className="text-muted-foreground">{t("sso.test.noGroups")}</p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {test.groups.map((g) => (
                        <Chip key={g} mono>
                            {g}
                        </Chip>
                    ))}
                </div>
            )}
            {test.would.action !== "refuse" &&
                test.groups != null &&
                (!roles ? (
                    <p className="text-muted-foreground">{t("sso.test.noRules")}</p>
                ) : lines.length === 0 ? (
                    <p className="text-muted-foreground">{t("sso.test.rolesSame")}</p>
                ) : (
                    <ul className="list-disc space-y-1 pl-5">
                        {lines.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                ))}
        </div>
    );
}
