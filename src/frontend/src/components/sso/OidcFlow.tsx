"use client";

/**
 * 單一登入「怎麼運作」：你的瀏覽器 ─ Telepy ─ 身分提供者 ─ 回到 Telepy，下面是五個步驟與 Telepy 怎麼決定帳號，
 * 以及它擋掉的事（別的瀏覽器拿到回呼網址、別家的回應、偽造的 id_token）。
 * How single sign-on works: your browser ─ Telepy ─ the provider ─ back to Telepy, then the five steps, how Telepy
 * picks the account, and what it refuses (a callback URL in another browser, another provider's answer, a forged token).
 */
import React from "react";
import { Building2, Monitor, UserCheck } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const STEPS: TranslationKey[] = ["sso.flow.step1", "sso.flow.step2", "sso.flow.step3", "sso.flow.step4", "sso.flow.step5", "sso.flow.step6"];
const ACCOUNT: TranslationKey[] = ["sso.flow.account1", "sso.flow.accountScim", "sso.flow.account2", "sso.flow.account3", "sso.flow.account4"];
const GUARDS: TranslationKey[] = ["sso.flow.guard1", "sso.flow.guard2", "sso.flow.guard3", "sso.flow.guard4"];
const ROLES: TranslationKey[] = ["sso.flow.roles1", "sso.flow.roles2", "sso.flow.roles3", "sso.flow.roles4"];

export function OidcFlowDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useI18n();
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("sso.flow.title")} description={t("sso.flow.description")} icon={<Building2 />} size="5xl">
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Monitor} title={t("sso.flow.browser")} sub={t("sso.flow.browserSub")} state="ok" stateText={t("sso.flow.browserState")} />
                    <FlowLink compact label={t("sso.flow.toTelepy")} state="ok" />
                    <FlowNode brand title="Telepy" sub={t("sso.flow.telepySub")} state="ok" stateText={t("sso.flow.telepyState")} />
                    <FlowLink compact label={t("sso.flow.toProvider")} state="ok" />
                    <FlowNode icon={Building2} title={t("sso.flow.provider")} sub={t("sso.flow.providerSub")} state="ok" stateText={t("sso.flow.providerState")} />
                    <FlowLink compact label={t("sso.flow.back")} state="ok" />
                    <FlowNode icon={UserCheck} title={t("sso.flow.signedIn")} sub={t("sso.flow.signedInSub")} state="ok" stateText={t("sso.flow.signedInState")} />
                </FlowPath>

                <Section title={t("sso.flow.stepsTitle")}>
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                        {STEPS.map((k) => (
                            <li key={k}>{t(k)}</li>
                        ))}
                    </ol>
                </Section>
                <div className="grid gap-5 md:grid-cols-2">
                    <Section title={t("sso.flow.rolesTitle")}>
                        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                            {ROLES.map((k) => (
                                <li key={k}>{t(k)}</li>
                            ))}
                        </ul>
                    </Section>
                    <Section title={t("sso.flow.accountTitle")}>
                        <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                            {ACCOUNT.map((k) => (
                                <li key={k}>{t(k)}</li>
                            ))}
                        </ol>
                    </Section>
                    <Section title={t("sso.flow.guardTitle")}>
                        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                            {GUARDS.map((k) => (
                                <li key={k}>{t(k)}</li>
                            ))}
                        </ul>
                    </Section>
                </div>
            </div>
        </Modal>
    );
}
