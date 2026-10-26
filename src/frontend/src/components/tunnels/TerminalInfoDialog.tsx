"use client";

/** 終端機頁 info 按鈕打開的說明：即時路徑圖 + 步驟 + 須知。/ The dialog behind the terminal page's info button. */
import React from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { TerminalFlow, type TerminalFlowContext } from "./TerminalFlow";

export function TerminalInfoDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: TerminalFlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("terminal.flow.title")}
            description={t("terminal.flow.description")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <TerminalFlow ctx={ctx} />
        </Modal>
    );
}
