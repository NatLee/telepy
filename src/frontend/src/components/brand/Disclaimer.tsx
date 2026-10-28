"use client";

/**
 * 使用聲明：放在「關於 Telepy」裡。一段一直看得到的摘要（Telepy 直接操作真實機器，也能讓 API Token / CLI / MCP
 * 應用程式代你操作，後果自行負責），加上「閱讀完整聲明」打開的對話框：無擔保、真實機器、只連有權使用的系統、
 * 金鑰與授權等同密碼、MCP 代理（提示注入）、分享、站台管理員。條文寫在字典 about.disclaimer.*。
 * The disclaimer inside "About Telepy": a summary that is always visible (Telepy acts on real machines and lets
 * API tokens / the CLI / MCP apps act for you; you answer for it) plus "Read the full disclaimer", which opens a
 * dialog: no warranty, real machines, authorised systems only, credentials, MCP agents (prompt injection),
 * sharing, server operators. The text lives in the dictionaries under about.disclaimer.*.
 */
import React, { useState } from "react";
import { Bot, ExternalLink, KeyRound, Scale, ServerCog, Share2, ShieldAlert, ShieldCheck, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/section";
import { SOURCE_URL } from "@/components/brand/ConsoleHello";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;

const SECTIONS: { icon: React.ReactNode; title: TranslationKey; body: TranslationKey }[] = [
    { icon: <Scale />, title: "about.disclaimer.asIsTitle", body: "about.disclaimer.asIsBody" },
    { icon: <SquareTerminal />, title: "about.disclaimer.machinesTitle", body: "about.disclaimer.machinesBody" },
    { icon: <ShieldCheck />, title: "about.disclaimer.authorizedTitle", body: "about.disclaimer.authorizedBody" },
    { icon: <KeyRound />, title: "about.disclaimer.credentialsTitle", body: "about.disclaimer.credentialsBody" },
    { icon: <Bot />, title: "about.disclaimer.agentsTitle", body: "about.disclaimer.agentsBody" },
    { icon: <Share2 />, title: "about.disclaimer.sharingTitle", body: "about.disclaimer.sharingBody" },
    { icon: <ServerCog />, title: "about.disclaimer.operatorsTitle", body: "about.disclaimer.operatorsBody" },
];

function DisclaimerDialog({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="2xl"
            icon={<ShieldAlert />}
            title={t("about.disclaimer")}
            description={t("about.disclaimerDescription")}
            footer={
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" asChild>
                        <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                            <ExternalLink />
                            {t("about.disclaimerLicence")}
                        </a>
                    </Button>
                    <Button size="sm" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                </div>
            }
        >
            <div className="space-y-5">
                {SECTIONS.map((s) => (
                    <Section key={s.title} as="h4" icon={s.icon} title={t(s.title)} wrapTitle className="space-y-1.5">
                        <p className="text-sm leading-relaxed text-muted-foreground">{t(s.body)}</p>
                    </Section>
                ))}
                <p className="border-t border-border pt-4 text-sm leading-relaxed text-foreground">{t("about.disclaimer.closing")}</p>
            </div>
        </Modal>
    );
}

/** 「關於 Telepy」裡的摘要 + 完整聲明。/ The summary in "About Telepy" plus the full disclaimer. */
export function Disclaimer() {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    return (
        <>
            <Callout tone="warning" title={t("about.disclaimer")} className="mt-3.5">
                <p>{t("about.disclaimerSummary")}</p>
                <Button variant="link" size="sm" className="mt-1 h-auto px-0 py-0.5" onClick={() => setOpen(true)}>
                    {t("about.disclaimerRead")}
                </Button>
            </Callout>
            {open && <DisclaimerDialog onClose={() => setOpen(false)} />}
        </>
    );
}
