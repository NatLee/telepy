"use client";

/** info 按鈕打開的說明：決定路徑圖 + 規則怎麼合起來。/ The dialog behind the info button: the decision path + how rules combine. */
import React from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { DecisionFlow, type DecisionFlowProps } from "./DecisionFlow";

export function DecisionFlowDialog({ isOpen, onClose, ...flow }: { isOpen: boolean; onClose: () => void } & DecisionFlowProps) {
    const { t } = useI18n();
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("commands.flow.title")} description={t("commands.flow.description")} icon={<Info />} size="4xl" footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
            <div className="space-y-5">
                <DecisionFlow {...flow} />
                <section className="border-t border-border pt-4">
                    <SectionHeading title={t("commands.flow.rulesTitle")} />
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                        <li>{t("commands.flow.rule1")}</li>
                        <li>{t("commands.flow.rule2")}</li>
                        <li>{t("commands.flow.rule3")}</li>
                        <li>{t("commands.flow.rule4")}</li>
                    </ol>
                </section>
            </div>
        </Modal>
    );
}
