"use client";

/** info 按鈕打開的說明：即時路徑圖 + 步驟 + 須知。/ The dialog behind the info button. */
import React from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { DesktopFlow, type FlowContext } from "./DesktopFlow";

export function DesktopInfoDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: FlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("desktop.flow.title")}
            description={t("desktop.flow.description")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <DesktopFlow ctx={ctx} />
        </Modal>
    );
}
