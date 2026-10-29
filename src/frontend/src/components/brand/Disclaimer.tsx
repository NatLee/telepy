"use client";

/**
 * 使用聲明：「關於 Telepy」裡的一顆按鈕（跟原始碼、片尾名單並排），打開完整聲明的對話框：無擔保、真實機器、只連有權使用
 * 的系統、金鑰與授權等同密碼、MCP 代理（提示注入）、分享、站台管理員。條文寫在字典 about.disclaimer.*。
 * The disclaimer: a button in "About Telepy" (next to Source code and Credits) that opens the full notice: no
 * warranty, real machines, authorised systems only, credentials, MCP agents (prompt injection), sharing, server
 * operators. The text lives in the dictionaries under about.disclaimer.*.
 */
import React, { useState } from "react";
import { Bot, ExternalLink, KeyRound, Scale, ServerCog, Share2, ShieldAlert, ShieldCheck, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
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

/** 「關於 Telepy」裡的「使用聲明」按鈕，打開完整聲明。/ The "Disclaimer" button in "About Telepy"; opens the full notice. */
export function DisclaimerButton() {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <ShieldAlert />
                {t("about.disclaimer")}
            </Button>
            {open && <DisclaimerDialog onClose={() => setOpen(false)} />}
        </>
    );
}
